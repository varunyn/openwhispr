const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const runtime = path.resolve(__dirname, "../resources/bin/transcribe-darwin-arm64");
if (!fs.existsSync(path.join(runtime, "include/transcribe.h"))) {
  if (process.argv.includes("--if-available")) process.exit(0);
  throw new Error("Stage the pinned transcribe.cpp runtime before building Unified meeting ASR");
}
execFileSync(
  "xcrun",
  [
    "clang++",
    "-std=c++17",
    "-O2",
    "-arch",
    "arm64",
    "-I",
    path.join(runtime, "include"),
    path.resolve(__dirname, "../resources/unified-meeting-asr.cpp"),
    "-L",
    path.join(runtime, "lib"),
    "-ltranscribe",
    "-Wl,-rpath,@executable_path/../lib",
    "-o",
    path.join(runtime, "bin/unified-meeting-asr"),
  ],
  { stdio: "inherit" }
);
