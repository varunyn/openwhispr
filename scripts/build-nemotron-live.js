// Compile the tiny streaming bridge against the staged, pinned NVIDIA C ABI.
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The staged Nemotron live runtime currently targets Apple Silicon");
}
const root = path.resolve(__dirname, "..");
const runtime = path.join(root, "resources/bin/nemo-speech-darwin-arm64");
if (!fs.existsSync(path.join(runtime, "include/nemo_speech/diar.h"))) {
  if (process.argv.includes("--if-available")) process.exit(0);
  throw new Error("Stage the evaluated Nemotron runtime before building the live bridge");
}
execFileSync(
  "xcrun",
  [
    "clang++",
    "-std=c++17",
    "-O2",
    "-arch",
    "arm64",
    "-mmacosx-version-min=14.0",
    "-I",
    path.join(runtime, "include"),
    path.join(root, "resources/nemotron-live.cpp"),
    "-L",
    path.join(runtime, "lib"),
    "-lnemo_speech_asr_c",
    "-Wl,-rpath,@executable_path/../lib",
    "-o",
    path.join(runtime, "bin/nemotron-live"),
  ],
  { stdio: "inherit" }
);
