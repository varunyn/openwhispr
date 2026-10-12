const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const sidecarPidFile = require("./sidecarPidFile");
const debugLogger = require("./debugLogger");
const speakerEmbeddings = require("./speakerEmbeddings");
const { downsample24kTo16k, pcm16ToFloat32 } = require("../utils/audioUtils");

const BYTES_PER_SECOND = 48000;
const MAX_PENDING_BYTES = BYTES_PER_SECOND * 15;
const HISTORY_BYTES = BYTES_PER_SECOND * 45;

class LiveNemotronDiarization {
  constructor({ spawnImpl = spawn, embeddings = speakerEmbeddings } = {}) {
    this.spawn = spawnImpl;
    this.embeddings = embeddings;
    this.enabled = true;
    this.proc = null;
    this.states = new Map();
    this.slots = new Map();
    this.intervals = [];
  }
  setDiarizationManager(manager) {
    this.manager = manager;
  }
  getBinaryPath() {
    return resolveBinaryPath(
      path.join(`nemo-speech-${process.platform}-${process.arch}`, "bin/nemotron-live")
    );
  }
  isAvailable() {
    return !!this.getBinaryPath() && !!this.manager?.nemotron?.isAvailable();
  }
  setMaxSpeakers(value) {
    if (Number(value) > (Number(this.maxSpeakers) || 8)) {
      const seen = new Set();
      for (const [slot, id] of this.slots) {
        if (seen.has(id)) this.slots.delete(slot);
        else seen.add(id);
      }
    }
    this.maxSpeakers = value;
  }
  setEnabled(value) {
    this.enabled = value !== false;
  }
  getSpeakerEmbedding(id) {
    return this.states.get(id)?.embedding || null;
  }
  mapSpeaker(id, profileId, displayName, noteId) {
    const state = this.states.get(id) || {};
    this.states.set(id, { ...state, profileId, displayName, noteId });
  }
  getTransientState() {
    return Object.fromEntries(
      [...this.states]
        .filter(([, s]) => s.embedding)
        .map(([id, s]) => [
          id,
          {
            embedding: Array.from(s.embedding),
            displayName: s.displayName || null,
            profileId: s.profileId ?? null,
            noteId: s.noteId ?? null,
          },
        ])
    );
  }
  async recluster() {
    return [];
  } // Native speaker cache owns the stable stream slots.

  async start(callback, options = {}) {
    await this.stop();
    if (!this.isAvailable() || options.enabled === false) return false;
    this.enabled = true;
    this.maxSpeakers = options.maxSpeakers;
    this.callback = callback;
    this.profiles = options.getSpeakerProfiles;
    this.states = new Map();
    this.slots = new Map();
    this.intervals = [];
    this.history = Buffer.alloc(0);
    this.receivedBytes = 0;
    this.carry = Buffer.alloc(0);
    this.embeddingQueue = Promise.resolve();
    this.stopping = false;
    this.lastThrough = 0;
    const proc = this.spawn(this.getBinaryPath(), [this.manager.nemotron.getModelPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.proc = proc;
    sidecarPidFile.write("nemotron-live", proc.pid);
    let stderr = "";
    proc.stderr.on("data", (data) => {
      stderr = (stderr + data).slice(-4096);
    });
    proc.stdin.on("error", () => {}); // close/error handlers degrade labels without stopping audio.
    const lines = readline.createInterface({ input: proc.stdout });
    const ready = new Promise((resolve) => {
      let settled = false;
      const settle = (value) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(value);
        }
      };
      const timer = setTimeout(() => {
        settle(false);
        void gracefulStopProcess(proc);
      }, 30000);
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "ready") settle(true);
          else if (event.type === "segments" && this.proc === proc) this.handleSegments(event);
        } catch (error) {
          debugLogger.warn("Invalid Nemotron live event", { error: error.message });
        }
      });
      proc.once("error", (error) => {
        debugLogger.warn("Nemotron live process failed", { error: error.message });
        settle(false);
      });
      this.closed = new Promise((closed) =>
        proc.once("close", (code) => {
          settle(false);
          lines.close();
          if (this.proc === proc) {
            this.proc = null;
            sidecarPidFile.clear("nemotron-live");
          }
          if (code !== 0) debugLogger.warn("Nemotron live exited", { code, stderr });
          closed();
        })
      );
    });
    const started = await ready;
    debugLogger.info("Nemotron live diarization started", { started });
    return started;
  }

  feedAudio(buffer) {
    const proc = this.proc;
    if (!proc || this.stopping || !buffer?.length) return;
    // Preserve odd capture boundaries; never silently drop a sample or pull the clock behind.
    const data = this.carry.length ? Buffer.concat([this.carry, buffer]) : buffer;
    const bytes = data.length - (data.length % 2);
    this.carry = Buffer.from(data.subarray(bytes));
    if (!bytes) return;
    if (proc.stdin.writableLength + bytes > MAX_PENDING_BYTES) {
      debugLogger.warn("Nemotron live fell behind; final diarization will recover labels");
      this.stopping = true;
      void gracefulStopProcess(proc);
      return;
    }
    const pcm = data.subarray(0, bytes);
    this.receivedBytes += bytes;
    this.history = Buffer.concat([this.history, pcm]).subarray(-HISTORY_BYTES);
    // The bridge bounds each packet; pipe ordering supplies backpressure without
    // spawning concurrent inference or queuing an entire meeting in JS memory.
    for (let offset = 0; offset < bytes; offset += 48000) {
      const chunk = pcm.subarray(offset, Math.min(offset + 48000, bytes));
      const header = Buffer.alloc(4);
      header.writeUInt32LE(chunk.length);
      proc.stdin.write(Buffer.concat([header, chunk]));
    }
  }

  handleSegments(event) {
    if (
      !Number.isFinite(event.through) ||
      !Array.isArray(event.segments) ||
      !Array.isArray(event.activity)
    )
      return;
    this.lastThrough = event.through;
    this.intervals = event.segments.filter(
      (s) =>
        Number.isInteger(s.speaker) &&
        s.speaker >= 1 &&
        s.speaker <= 8 &&
        Number.isFinite(s.start) &&
        Number.isFinite(s.end) &&
        s.end > s.start &&
        event.activity[s.speaker - 1] >= 1
    );
    if (!this.enabled) return;
    for (const seg of event.segments) {
      if (
        !Number.isInteger(seg.speaker) ||
        seg.speaker < 1 ||
        seg.speaker > 8 ||
        !Number.isFinite(seg.start) ||
        !Number.isFinite(seg.end) ||
        seg.start < 0 ||
        seg.end <= seg.start ||
        !Number.isFinite(event.activity[seg.speaker - 1]) ||
        event.activity[seg.speaker - 1] < 1
      )
        continue;
      let id = this.slots.get(seg.speaker);
      if (!id) {
        const cap = Math.max(1, Math.min(8, Number(this.maxSpeakers) || 8));
        const ids = [...new Set(this.slots.values())];
        id = ids.length < cap ? `speaker_${ids.length}` : ids[0];
        this.slots.set(seg.speaker, id);
      }
      const state = this.states.get(id) || {};
      this.states.set(id, state);
      this.callback?.({
        speakerId: id,
        displayName: state.displayName || null,
        startTime: seg.start,
        endTime: seg.end,
        provisional: true,
      });
      this.maybeExtractEmbedding(id, seg);
    }
  }

  getSpeakerForInterval(start, end) {
    let speaker = null,
      best = 0;
    for (const s of this.intervals) {
      const overlap = Math.min(end, s.end) - Math.max(start, s.start);
      if (overlap > best) {
        best = overlap;
        speaker = this.slots.get(s.speaker) || null;
      }
    }
    return speaker;
  }

  maybeExtractEmbedding(id, seg) {
    const state = this.states.get(id);
    if (
      !this.embeddings.isAvailable() ||
      state.extracting ||
      state.embedding ||
      seg.end - seg.start < 1.6
    )
      return;
    const historyStart = (this.receivedBytes - this.history.length) / BYTES_PER_SECOND;
    const start = Math.max(seg.start, historyStart);
    const end = Math.min(seg.end, start + 8);
    if (end - start < 1.6) return;
    const pcm = Buffer.from(
      this.history.subarray(
        Math.floor((start - historyStart) * 24000) * 2,
        Math.floor((end - historyStart) * 24000) * 2
      )
    );
    state.extracting = true;
    const states = this.states;
    this.embeddingQueue = this.embeddingQueue
      .then(async () => {
        const embedding = await this.embeddings.extractEmbeddingFromSamples(
          pcm16ToFloat32(downsample24kTo16k(pcm))
        );
        if (!embedding || this.states !== states) return;
        state.embedding = embedding;
        if (state.displayName) return;
        const matches = (this.profiles?.() || [])
          .filter((profile) => profile?.embedding)
          .map((profile) => ({
            profile,
            score: this.embeddings.cosineSimilarity(
              embedding,
              profile.embedding instanceof Float32Array
                ? profile.embedding
                : Array.isArray(profile.embedding)
                  ? new Float32Array(profile.embedding)
                  : new Float32Array(
                      profile.embedding.buffer.slice(
                        profile.embedding.byteOffset,
                        profile.embedding.byteOffset + profile.embedding.byteLength
                      )
                    )
            ),
          }))
          .sort((a, b) => b.score - a.score);
        if (matches[0]?.score > 0.65 && matches[0].score - (matches[1]?.score || 0) > 0.03) {
          state.displayName = matches[0].profile.display_name;
          state.profileId = matches[0].profile.id;
        }
      })
      .catch((error) =>
        debugLogger.debug("Nemotron live embedding skipped", { error: error.message })
      )
      .finally(() => {
        state.extracting = false;
      });
  }

  async stop() {
    const proc = this.proc;
    if (proc) {
      this.stopping = true;
      if (!proc.stdin.destroyed) proc.stdin.end(Buffer.alloc(4));
      const timer = setTimeout(() => {
        void gracefulStopProcess(proc);
      }, 10000);
      await this.closed;
      clearTimeout(timer);
    }
    await this.embeddingQueue;
    this.callback = null;
    this.history = Buffer.alloc(0);
    return this.getTransientState();
  }
}
module.exports = { LiveNemotronDiarization, MAX_PENDING_BYTES };
