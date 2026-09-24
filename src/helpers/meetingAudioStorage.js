const fs = require("fs");
const path = require("path");

const SAMPLE_RATE = 24000;
const CHANNELS = ["mic", "system"];
const BLOCK_SAMPLES = 4096;
const MAX_WAV_DATA_BYTES = 0xffffffff - 36;

function wavHeader(dataBytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(dataBytes + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(2, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 4, 28);
  header.writeUInt16LE(4, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

// Meeting capture already reaches the main process as 24 kHz mono PCM16 for
// both sources. Spool each source to disk, then interleave them into one stereo
// WAV at stop: left is the microphone, right is system audio. Disk use stays
// bounded by recording duration rather than renderer memory.
class MeetingAudioStorage {
  constructor(audioDir, now = Date.now) {
    this.dir = path.join(audioDir, "meetings");
    this.now = now;
    this.active = null;
    fs.mkdirSync(this.dir, { recursive: true });
  }

  begin(noteId, sessionId) {
    this.abort();
    if (!Number.isSafeInteger(noteId) || noteId <= 0 || !/^[a-f0-9-]{36}$/i.test(sessionId)) {
      return false;
    }
    this.active = {
      noteId,
      sessionId,
      startedAt: this.now(),
      tracks: { mic: null, system: null },
    };
    return true;
  }

  append(source, buffer, capturedAt = null) {
    const session = this.active;
    if (!session || !CHANNELS.includes(source) || !Buffer.isBuffer(buffer) || buffer.length < 2) {
      return;
    }
    try {
      let track = session.tracks[source];
      if (!track) {
        const file = path.join(this.dir, `${session.sessionId}-${source}.pcm.part`);
        const firstAt = Number.isFinite(capturedAt) ? capturedAt : this.now();
        track = {
          file,
          fd: fs.openSync(file, "w"),
          offset: Math.max(0, Math.round(((firstAt - session.startedAt) * SAMPLE_RATE) / 1000)),
          samples: 0,
        };
        session.tracks[source] = track;
      }
      const bytes = buffer.length - (buffer.length % 2);
      fs.writeSync(track.fd, buffer, 0, bytes);
      track.samples += bytes / 2;
    } catch (error) {
      this.abort();
      throw error;
    }
  }

  finish() {
    const session = this.active;
    if (!session) return null;
    this.active = null;
    const tracks = session.tracks;
    const output = path.join(
      this.dir,
      `OpenWhispr-meeting-${session.noteId}-${session.sessionId}.wav`
    );
    const partial = `${output}.part`;
    let outputFd;
    try {
      for (const track of Object.values(tracks)) {
        if (track) fs.closeSync(track.fd);
      }
      const samples = Math.max(
        0,
        ...Object.values(tracks).map((track) => (track ? track.offset + track.samples : 0))
      );
      const dataBytes = samples * 4;
      if (!samples) return null;
      if (dataBytes > MAX_WAV_DATA_BYTES) throw new Error("Meeting exceeds WAV file size limit");
      outputFd = fs.openSync(partial, "w");
      fs.writeSync(outputFd, wavHeader(dataBytes));
      const input = Object.fromEntries(
        CHANNELS.map((source) => [
          source,
          tracks[source] ? fs.openSync(tracks[source].file, "r") : null,
        ])
      );
      try {
        for (let cursor = 0; cursor < samples; cursor += BLOCK_SAMPLES) {
          const count = Math.min(BLOCK_SAMPLES, samples - cursor);
          const block = Buffer.alloc(count * 4);
          for (let channel = 0; channel < CHANNELS.length; channel++) {
            const source = CHANNELS[channel];
            const track = tracks[source];
            if (!track) continue;
            const first = Math.max(cursor, track.offset);
            const last = Math.min(cursor + count, track.offset + track.samples);
            if (last <= first) continue;
            const mono = Buffer.alloc((last - first) * 2);
            fs.readSync(input[source], mono, 0, mono.length, (first - track.offset) * 2);
            for (let sample = 0; sample < last - first; sample++) {
              block.writeInt16LE(
                mono.readInt16LE(sample * 2),
                ((first - cursor + sample) * 2 + channel) * 2
              );
            }
          }
          fs.writeSync(outputFd, block);
        }
      } finally {
        for (const fd of Object.values(input)) if (fd != null) fs.closeSync(fd);
      }
      fs.closeSync(outputFd);
      outputFd = null;
      fs.renameSync(partial, output);
      return output;
    } finally {
      if (outputFd != null) fs.closeSync(outputFd);
      for (const track of Object.values(tracks)) {
        if (track) fs.rmSync(track.file, { force: true });
      }
      fs.rmSync(partial, { force: true });
    }
  }

  abort() {
    const session = this.active;
    this.active = null;
    if (!session) return;
    for (const track of Object.values(session.tracks)) {
      if (!track) continue;
      try {
        fs.closeSync(track.fd);
      } catch {}
      fs.rmSync(track.file, { force: true });
    }
  }

  filesForNote(noteId) {
    if (!Number.isSafeInteger(noteId) || noteId <= 0) return [];
    return fs
      .readdirSync(this.dir)
      .filter((name) => name.startsWith(`OpenWhispr-meeting-${noteId}-`) && name.endsWith(".wav"))
      .map((name) => path.join(this.dir, name));
  }

  cleanupExpired(days) {
    if (!Number.isFinite(days) || days <= 0) return;
    const cutoff = this.now() - days * 86400000;
    for (const name of fs.readdirSync(this.dir)) {
      if (!name.endsWith(".wav") && !name.endsWith(".part")) continue;
      const file = path.join(this.dir, name);
      if (fs.statSync(file).mtimeMs < cutoff) fs.rmSync(file, { force: true });
    }
  }

  deleteForNote(noteId) {
    for (const file of this.filesForNote(noteId)) fs.rmSync(file, { force: true });
  }

  deleteAll() {
    this.abort();
    for (const name of fs.readdirSync(this.dir)) {
      if (name.endsWith(".wav") || name.endsWith(".part")) {
        fs.rmSync(path.join(this.dir, name), { force: true });
      }
    }
  }

  getStorageUsage() {
    const files = fs.readdirSync(this.dir).filter((name) => name.endsWith(".wav"));
    return {
      fileCount: files.length,
      totalBytes: files.reduce((sum, name) => sum + fs.statSync(path.join(this.dir, name)).size, 0),
    };
  }
}

module.exports = MeetingAudioStorage;
