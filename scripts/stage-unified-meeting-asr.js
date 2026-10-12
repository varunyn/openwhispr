// Explicit test-build staging. Assets remain ignored by Git; nothing downloads
// or uploads audio here. Supply the pinned official runtime archive, matching
// C API header, and the evaluated Handy GGUF checkpoint.
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const pins = {
  archive: "df25679788bd7b611f43a55a967daedb365a591efed21c999125583169a98255",
  header: "288457c5b1d974d164b545609d8483c90fb73c9715e734e8886e7ef0d72d18f8",
  model: "4b50b6dd862bf6e346929aaf4f5eaacec003bfa3f56462d6c874b41ef2f38795",
};
function argument(name) {
  const i = process.argv.indexOf(name);
  if (i < 0 || !process.argv[i + 1]) throw new Error(`Missing ${name}`);
  return path.resolve(process.argv[i + 1]);
}
if (process.platform !== "darwin" || process.arch !== "arm64")
  throw new Error("This test runtime targets Apple Silicon");
const inputs = {
  archive: argument("--runtime-archive"),
  header: argument("--header-file"),
  model: argument("--model-file"),
};
for (const [kind, file] of Object.entries(inputs)) {
  if (crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex") !== pins[kind])
    throw new Error(`Unexpected ${kind} SHA-256`);
}
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "ow-unified-stage-"));
try {
  execFileSync("tar", ["-xzf", inputs.archive, "-C", temporary]);
  const source = path.join(temporary, "transcribe-native-macos-arm64-metal");
  const bin = path.resolve(__dirname, "../resources/bin");
  const destination = path.join(bin, "transcribe-darwin-arm64");
  for (const dir of ["lib", "bin", "include"])
    fs.mkdirSync(path.join(destination, dir), { recursive: true });
  for (const file of fs.readdirSync(source).filter((name) => name.endsWith(".dylib")))
    fs.copyFileSync(path.join(source, file), path.join(destination, "lib", file));
  fs.cpSync(path.join(source, "licenses"), path.join(destination, "licenses"), { recursive: true });
  fs.copyFileSync(inputs.header, path.join(destination, "include/transcribe.h"));
  const models = path.join(bin, "asr-models");
  fs.mkdirSync(models, { recursive: true });
  fs.copyFileSync(inputs.model, path.join(models, "parakeet-unified-en-0.6b-Q8_0.gguf"));
  fs.writeFileSync(
    path.join(models, "unified-manifest.json"),
    JSON.stringify(
      {
        repo: "handy-computer/parakeet-unified-en-0.6b-gguf",
        revision: "7e948f21b7bdbac698d3318db9d350f1096f3b6c",
        runtime: "transcribe.cpp 0.2.4",
        sha256: pins,
      },
      null,
      2
    )
  );
  require("./build-unified-meeting-asr");
} finally {
  fs.rmSync(temporary, { recursive: true, force: true });
}
