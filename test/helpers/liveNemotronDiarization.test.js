const test = require("node:test");
const assert = require("node:assert/strict");
const os = require("node:os");
const { spawn } = require("node:child_process");
require.cache[require.resolve("electron")] = {
  exports: {
    app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
    net: {},
  },
};
const {
  LiveNemotronDiarization,
  MAX_PENDING_BYTES,
} = require("../../src/helpers/liveNemotronDiarization");
const embeddings = { isAvailable: () => false };
function runner(script) {
  const live = new LiveNemotronDiarization({
    embeddings,
    spawnImpl: (_, __, options) => spawn(process.execPath, ["-e", script], options),
  });
  live.getBinaryPath = () => "/fake/nemotron-live";
  live.setDiarizationManager({
    nemotron: { isAvailable: () => true, getModelPath: () => "/fake/model.gguf" },
  });
  return live;
}
const consumer = `
console.log(JSON.stringify({type:'ready'}));
let pending=Buffer.alloc(0),bytes=0;
process.stdin.on('data', chunk=>{
 pending=Buffer.concat([pending,chunk]);
 while(pending.length>=4){
  const n=pending.readUInt32LE(); if(pending.length<4+n)return;
  if(n===0){console.log(JSON.stringify({type:'segments',through:bytes/48000,activity:[2],segments:[{start:0,end:bytes/48000,speaker:1}]}));process.exit(0);}
  bytes+=n; pending=pending.subarray(4+n);
 }
});
`;
test("a persistent process preserves odd PCM boundaries, flushes its tail and emits provisional identity", async () => {
  const live = runner(consumer),
    events = [];
  assert.equal(await live.start((event) => events.push(event)), true);
  live.feedAudio(Buffer.alloc(3));
  live.feedAudio(Buffer.alloc(95997));
  await live.stop();
  assert.equal(live.proc, null);
  assert.deepEqual(events, [
    { speakerId: "speaker_0", displayName: null, startTime: 0, endTime: 2, provisional: true },
  ]);
});
test("stream slots survive revisions and short turns, while brief new sound identities are suppressed", () => {
  const live = runner(consumer),
    events = [];
  live.callback = (event) => events.push(event);
  live.handleSegments({
    through: 10,
    activity: [4, 0.5, 2],
    segments: [
      { start: 4, end: 6, speaker: 1 },
      { start: 7, end: 7.5, speaker: 2 },
      { start: 8, end: 8.2, speaker: 3 },
    ],
  });
  live.mapSpeaker("speaker_0", 42, "Ada", 11);
  live.handleSegments({ through: 12, activity: [6], segments: [{ start: 4, end: 8, speaker: 1 }] });
  assert.deepEqual(
    events.map((e) => e.speakerId),
    ["speaker_0", "speaker_1", "speaker_0"]
  );
  assert.equal(events[2].displayName, "Ada");
  live.setEnabled(false);
  live.handleSegments({ through: 13, activity: [7], segments: [{ start: 4, end: 9, speaker: 1 }] });
  assert.equal(events.length, 3);
});
test("a child that exits before readiness degrades labels without hanging start", async () => {
  const live = runner("process.exit(1)");
  assert.equal(await live.start(() => {}), false);
  await live.stop();
});
test("backpressure failure stops inference instead of dropping audio and shifting the speaker clock", async () => {
  const live = runner("console.log(JSON.stringify({type:'ready'}));setInterval(()=>{},1000)");
  assert.equal(await live.start(() => {}), true);
  live.feedAudio(Buffer.alloc(MAX_PENDING_BYTES + 2));
  assert.equal(live.stopping, true);
  await live.stop();
});

test("manual speaker limit caps slots while automatic mode discovers multiple speakers", () => {
  const live = runner(consumer),
    events = [];
  live.callback = (e) => events.push(e);
  live.setMaxSpeakers(1);
  live.handleSegments({
    through: 5,
    activity: [2, 2],
    segments: [
      { start: 0, end: 2, speaker: 1 },
      { start: 3, end: 5, speaker: 2 },
    ],
  });
  assert.deepEqual(
    events.map((e) => e.speakerId),
    ["speaker_0", "speaker_0"]
  );
});

test("stream speaker embeddings preserve profile names for final-pass reconciliation", async () => {
  const live = runner(consumer);
  live.embeddings = {
    isAvailable: () => true,
    extractEmbeddingFromSamples: async () => new Float32Array([1, 0]),
    cosineSimilarity: () => 0.9,
  };
  live.callback = () => {};
  live.history = Buffer.alloc(96000);
  live.receivedBytes = 96000;
  live.embeddingQueue = Promise.resolve();
  live.profiles = () => [{ id: 42, display_name: "Ada", embedding: new Float32Array([1, 0]) }];
  live.handleSegments({ through: 2, activity: [2], segments: [{ start: 0, end: 2, speaker: 1 }] });
  await live.embeddingQueue;
  assert.equal(live.getTransientState().speaker_0.displayName, "Ada");
  assert.equal(live.getTransientState().speaker_0.profileId, 42);
  assert.deepEqual(live.getTransientState().speaker_0.embedding, [1, 0]);
});

test("timed speech can query the native interval cache across a voice handoff", () => {
  const live = runner(consumer);
  live.callback = () => {};
  live.handleSegments({
    through: 6,
    activity: [3, 3],
    segments: [
      { start: 0, end: 3, speaker: 1 },
      { start: 3, end: 6, speaker: 2 },
    ],
  });
  assert.equal(live.getSpeakerForInterval(2, 2.8), "speaker_0");
  assert.equal(live.getSpeakerForInterval(3.1, 3.8), "speaker_1");
  assert.equal(live.getSpeakerForInterval(8, 9), null);
});
