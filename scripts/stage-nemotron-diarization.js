#!/usr/bin/env node
// Test-build assets: pass a verified NeMo-Speech.cpp runtime directory and the
// evaluated GGUF checkpoint. Binary assets remain ignored by Git. Example:
// node scripts/stage-nemotron-diarization.js --runtime-dir /path/to/runtime --model-file /path/to/model.gguf
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const {
  MODEL_FILE,
  MODEL_SHA256,
  MODEL_REVISION,
  RUNTIME_VERSION,
} = require("../src/helpers/nemotronDiarizationConfig");

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[index + 1]);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("This evaluated test runtime is for Apple Silicon only");
}
const runtime = argument("--runtime-dir");
const model = argument("--model-file");
const version = execFileSync(path.join(runtime, "bin", "nemo-speech"), ["--version"], {
  encoding: "utf8",
}).trim();
if (version !== `nemo-speech ${RUNTIME_VERSION}`) throw new Error(`Unexpected runtime: ${version}`);
const sha256 = crypto.createHash("sha256").update(fs.readFileSync(model)).digest("hex");
if (sha256 !== MODEL_SHA256)
  throw new Error("Nemotron model SHA-256 does not match evaluated checkpoint");
const bin = path.resolve(__dirname, "..", "resources", "bin");
const destination = path.join(bin, `nemo-speech-${process.platform}-${process.arch}`);
fs.rmSync(destination, { recursive: true, force: true });
fs.cpSync(runtime, destination, { recursive: true, verbatimSymlinks: true });
const models = path.join(bin, "diarization-models");
fs.mkdirSync(models, { recursive: true });
fs.copyFileSync(model, path.join(models, MODEL_FILE));
fs.writeFileSync(
  path.join(models, "nemotron-manifest.json"),
  JSON.stringify(
    {
      repo: "nvidia/Nemotron-3-Diarization",
      revision: MODEL_REVISION,
      file: MODEL_FILE,
      sha256,
      runtimeVersion: RUNTIME_VERSION,
      license: "https://huggingface.co/nvidia/Nemotron-3-Diarization/blob/main/LICENSE",
    },
    null,
    2
  ) + "\n"
);
require("./build-nemotron-live");
console.log(`Staged ${version} and verified ${MODEL_FILE}`);
