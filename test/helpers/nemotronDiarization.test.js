const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

require.cache[require.resolve("electron")] = {
  exports: {
    app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
    net: {},
  },
};
const {
  NemotronDiarization,
  parseNemotronSegments,
} = require("../../src/helpers/nemotronDiarization");
const DiarizationManager = require("../../src/helpers/diarization");

test("Nemotron intervals retain arrival identities and reject a short notification identity", () => {
  const result = parseNemotronSegments(
    JSON.stringify({
      segments: [
        { start: 5, end: 8, speaker: 2 },
        { start: 0, end: 2, speaker: 1 },
        { start: 2, end: 2.55, speaker: 3 },
        { start: 9, end: 9.3, speaker: 1 },
      ],
    })
  );
  assert.deepEqual(result, [
    { start: 0, end: 2, speaker: "speaker_0" },
    { start: 5, end: 8, speaker: "speaker_1" },
    { start: 9, end: 9.3, speaker: "speaker_0" },
  ]);
});

test("Nemotron output must contain well-formed speaker intervals", () => {
  for (const segment of [
    { start: -1, end: 2, speaker: 1 },
    { start: 2, end: 1, speaker: 1 },
    { start: 0, end: 2, speaker: 9 },
    { start: "0", end: 2, speaker: 1 },
  ])
    assert.throws(() => parseNemotronSegments(JSON.stringify({ segments: [segment] })));
  assert.throws(() => parseNemotronSegments("{}"));
  assert.deepEqual(parseNemotronSegments('{"segments":[]}'), []);
});

function fakeRunner(script, captured = []) {
  const runner = new NemotronDiarization({
    spawnImpl: (binary, args, options) => {
      captured.push({ binary, args, options });
      return spawn(process.execPath, ["-e", script, args[args.indexOf("--output") + 1]], options);
    },
  });
  runner.getBinaryPath = () => "/fake runtime/bin/nemo-speech";
  runner.getModelPath = () => "/fake model.gguf";
  return runner;
}

test("runner uses the offline preset and local model and removes its temporary output", async () => {
  const captured = [];
  const runner = fakeRunner(
    'require("fs").writeFileSync(process.argv[1], JSON.stringify({segments:[{start:0,end:2,speaker:1}]}))',
    captured
  );
  const result = await runner.diarize("/recording with spaces.wav");
  assert.deepEqual(result, [{ start: 0, end: 2, speaker: "speaker_0" }]);
  assert.ok(captured[0].args.includes("/recording with spaces.wav"));
  assert.ok(captured[0].args.includes("v3-offline"));
  assert.ok(captured[0].args.includes("/fake model.gguf"));
  assert.equal(fs.existsSync(path.dirname(captured[0].args.at(-1))), false);
  assert.equal(runner.processes.size, 0);
});

test("runner rejects failure instead of silently replacing labels with legacy results", async () => {
  await assert.rejects(
    fakeRunner('process.stderr.write("decode failed");process.exit(2)').diarize("a.wav"),
    /decode failed/
  );
});

test("timeout and cancellation stop inference and release process state", async () => {
  const runner = fakeRunner("setInterval(() => {}, 1000)");
  await assert.rejects(runner.diarize("a.wav", { timeoutMs: 50 }), /timed out/);
  assert.equal(runner.processes.size, 0);
  const controller = new AbortController();
  const result = runner.diarize("a.wav", { signal: controller.signal });
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(result, /cancelled/);
  assert.equal(runner.processes.size, 0);
});

test("only meeting finalization selects Nemotron; unavailable bundles retain platform fallback", async () => {
  const manager = new DiarizationManager();
  manager.nemotron.isAvailable = () => true;
  manager.nemotron.diarize = async () => ["nemotron"];
  manager.diarize = async () => ["legacy"];
  assert.deepEqual(await manager.diarizeMeeting("a.wav"), ["nemotron"]);
  manager.nemotron.isAvailable = () => false;
  assert.deepEqual(await manager.diarizeMeeting("a.wav"), ["legacy"]);
});
