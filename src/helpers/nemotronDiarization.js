const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { resolveBinaryPath, gracefulStopProcess } = require("../utils/serverUtils");
const { getSafeTempDir } = require("./safeTempDir");
const debugLogger = require("./debugLogger");
const sidecarPidFile = require("./sidecarPidFile");

const { MODEL_FILE, MODEL_SHA256, RUNTIME_VERSION } = require("./nemotronDiarizationConfig");

function parseNemotronSegments(output) {
  const result = JSON.parse(output);
  if (!Array.isArray(result.segments)) throw new Error("Nemotron returned no segment array");
  const segments = result.segments
    .map(({ start, end, speaker }) => {
      if (
        !Number.isFinite(start) ||
        !Number.isFinite(end) ||
        start < 0 ||
        end <= start ||
        !Number.isInteger(speaker) ||
        speaker < 1 ||
        speaker > 8
      ) {
        throw new Error("Nemotron returned an invalid speaker interval");
      }
      return { start, end, speaker: `speaker_${speaker - 1}` };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);
  // Filter only identities with less than one second of total activity, rather
  // than short replies belonging to a speaker who also has longer turns.
  const totals = new Map();
  for (const s of segments) totals.set(s.speaker, (totals.get(s.speaker) || 0) + s.end - s.start);
  return segments.filter((s) => totals.get(s.speaker) >= 1);
}

class NemotronDiarization {
  constructor({ spawnImpl = spawn } = {}) {
    this.spawn = spawnImpl;
    this.processes = new Set();
  }

  getBinaryPath() {
    return resolveBinaryPath(
      path.join(`nemo-speech-${process.platform}-${process.arch}`, "bin", "nemo-speech")
    );
  }

  getModelPath() {
    return resolveBinaryPath(path.join("diarization-models", MODEL_FILE));
  }

  isAvailable() {
    return !!this.getBinaryPath() && !!this.getModelPath();
  }

  async diarize(wavPath, { signal = null, timeoutMs = 3600000 } = {}) {
    if (signal?.aborted) throw new Error("Nemotron diarization cancelled");
    const binary = this.getBinaryPath();
    const model = this.getModelPath();
    if (!binary || !model) throw new Error("Nemotron diarization runtime or model is missing");
    const dir = await fs.promises.mkdtemp(path.join(getSafeTempDir(), "ow-nemotron-"));
    const output = path.join(dir, "segments.json");
    const startedAt = Date.now();
    try {
      await new Promise((resolve, reject) => {
        let stderr = "";
        let stopReason = null;
        const proc = this.spawn(
          binary,
          [
            "diarize",
            wavPath,
            "--model",
            model,
            "--device",
            process.platform === "darwin" && process.arch === "arm64" ? "metal" : "cpu",
            "--preset",
            "v3-offline",
            "--format",
            "json",
            "--output",
            output,
          ],
          {
            stdio: ["ignore", "ignore", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
          }
        );
        this.processes.add(proc);
        sidecarPidFile.write("nemotron-diarization", proc.pid);
        const stop = (reason) => {
          stopReason = reason;
          void gracefulStopProcess(proc);
        };
        const timer = setTimeout(() => stop("Nemotron diarization timed out"), timeoutMs);
        const onAbort = () => stop("Nemotron diarization cancelled");
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted) onAbort();
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          this.processes.delete(proc);
          const survivor = [...this.processes].at(-1);
          if (survivor) sidecarPidFile.write("nemotron-diarization", survivor.pid);
          else sidecarPidFile.clear("nemotron-diarization");
        };
        proc.stderr.on("data", (data) => {
          stderr = (stderr + data.toString()).slice(-8192);
        });
        proc.once("error", (error) => {
          cleanup();
          reject(error);
        });
        proc.once("close", (code) => {
          cleanup();
          if (stopReason || code !== 0)
            reject(new Error(stopReason || `Nemotron exited ${code}: ${stderr.trim()}`));
          else resolve();
        });
      });
      const segments = parseNemotronSegments(await fs.promises.readFile(output, "utf8"));
      debugLogger.info("Nemotron meeting diarization complete", {
        segments: segments.length,
        speakers: new Set(segments.map((s) => s.speaker)).size,
        elapsedMs: Date.now() - startedAt,
      });
      return segments;
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }

  async shutdown() {
    await Promise.all([...this.processes].map((proc) => gracefulStopProcess(proc)));
  }
}

module.exports = {
  NemotronDiarization,
  parseNemotronSegments,
  MODEL_FILE,
  MODEL_SHA256,
  RUNTIME_VERSION,
};
