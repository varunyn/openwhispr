const { spawn } = require("child_process");
const readline = require("readline");
const path = require("path");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const sidecarPidFile = require("./sidecarPidFile");
const { groupMeetingTimedWords } = require("./meetingTimedWords");
const MODEL = "parakeet-unified-en-0.6b";
const MODEL_FILE = "parakeet-unified-en-0.6b-Q8_0.gguf";
class UnifiedMeetingAsr {
  constructor({ spawnImpl = spawn } = {}) {
    this.spawn = spawnImpl;
    this.proc = null;
    this.pending = new Map();
    this.nextId = 0;
    this.anchors = {};
  }
  getBinaryPath() {
    return resolveBinaryPath(
      path.join(`transcribe-${process.platform}-${process.arch}`, "bin/unified-meeting-asr")
    );
  }
  getModelPath() {
    return resolveBinaryPath(path.join("asr-models", MODEL_FILE));
  }
  isAvailable(model) {
    return model === MODEL && !!this.getBinaryPath() && !!this.getModelPath();
  }
  async start() {
    await this.stop();
    this.anchors = {};
    this.finished = new Set();
    const proc = this.spawn(this.getBinaryPath(), [this.getModelPath()], {
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    this.proc = proc;
    sidecarPidFile.write("unified-meeting-asr", proc.pid);
    let stderr = "";
    proc.stderr.on("data", (b) => {
      stderr = (stderr + b).slice(-4096);
    });
    proc.stdin.on("error", () => {});
    const lines = readline.createInterface({ input: proc.stdout });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        settled = true;
        reject(new Error("Unified EN startup timed out"));
        void gracefulStopProcess(proc);
      }, 30000);
      const fail = (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(error);
        }
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(error);
        }
        this.pending.clear();
      };
      lines.on("line", (line) => {
        try {
          const event = JSON.parse(line);
          if (event.type === "ready") {
            if (!settled) {
              settled = true;
              clearTimeout(timer);
              resolve(true);
            }
          } else if (event.type === "result") {
            const p = this.pending.get(event.id);
            if (!p) return;
            this.pending.delete(event.id);
            clearTimeout(p.timer);
            if (
              typeof event.text !== "string" ||
              !Number.isFinite(event.startMs) ||
              !Number.isFinite(event.endMs) ||
              event.startMs < 0 ||
              event.endMs < event.startMs
            ) {
              p.reject(new Error("Invalid Unified EN speech result"));
              return;
            }
            p.resolve({
              success: true,
              text: event.text.trim(),
              timestamp: this.anchors[p.source] + event.startMs,
              endTimestamp: this.anchors[p.source] + event.endMs,
              words: event.words,
              segments: groupMeetingTimedWords(event.text, event.words, this.anchors[p.source]),
              durationMs: event.endMs - event.startMs,
              partial: event.partial || "",
            });
          }
        } catch (error) {
          fail(error);
          void gracefulStopProcess(proc);
        }
      });
      proc.once("error", fail);
      this.closed = new Promise((closed) =>
        proc.once("close", (code) => {
          lines.close();
          fail(new Error(`Unified EN speech process exited ${code}: ${stderr.trim()}`));
          if (this.proc === proc) {
            this.proc = null;
            sidecarPidFile.clear("unified-meeting-asr");
          }
          closed();
        })
      );
    });
  }
  request(source, pcm, startedAt) {
    const proc = this.proc;
    if (!proc || proc.stdin.destroyed || this.finished.has(source))
      return Promise.reject(new Error("Unified EN stream is not running"));
    if (source !== "system" && source !== "mic")
      return Promise.reject(new Error("Unknown Unified EN audio channel"));
    if (pcm.length % 2 || pcm.length > 16000 * 2 * 60)
      return Promise.reject(new Error("Invalid Unified EN audio packet"));
    this.anchors[source] ??= Number.isFinite(startedAt) ? startedAt : Date.now() - pcm.length / 32;
    const id = ++this.nextId;
    const header = Buffer.alloc(12);
    header.writeUInt32LE(id);
    header.writeUInt32LE(source === "mic" ? 1 : 0, 4);
    header.writeUInt32LE(pcm.length, 8);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Unified EN transcription timed out"));
        void gracefulStopProcess(proc);
      }, 30000);
      this.pending.set(id, { resolve, reject, timer, source });
      proc.stdin.write(Buffer.concat([header, pcm]));
      if (!pcm.length) this.finished.add(source);
    });
  }
  async feed(source, pcm, startedAt) {
    let result = null;
    const text = [];
    const segments = [];
    const words = [];
    let firstTimestamp;
    let durationMs = 0;
    for (let offset = 0; offset < pcm.length; offset += 32000 * 10) {
      result = await this.request(source, pcm.subarray(offset, offset + 32000 * 10), startedAt);
      firstTimestamp ??= result.timestamp;
      if (result.text) text.push(result.text);
      if (result.words?.length) words.push(...result.words);
      if (result.segments?.length) segments.push(...result.segments);
      else if (result.text) segments.push({ ...result, segments: undefined });
      durationMs += result.durationMs;
    }
    return result
      ? { ...result, text: text.join(" "), timestamp: firstTimestamp, segments, words, durationMs }
      : { success: true, text: "" };
  }
  finish(source) {
    return this.request(source, Buffer.alloc(0));
  }
  async stop() {
    const proc = this.proc;
    if (!proc) return;
    proc.stdin.end();
    const timer = setTimeout(() => {
      void gracefulStopProcess(proc);
    }, 5000);
    await this.closed;
    clearTimeout(timer);
  }
}
module.exports = new UnifiedMeetingAsr();
module.exports.UnifiedMeetingAsr = UnifiedMeetingAsr;
module.exports.MODEL = MODEL;
module.exports.MODEL_FILE = MODEL_FILE;
