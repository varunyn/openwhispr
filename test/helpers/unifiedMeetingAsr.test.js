const test = require("node:test"),
  assert = require("node:assert/strict"),
  os = require("node:os");
const { spawn } = require("node:child_process");
require.cache[require.resolve("electron")] = {
  exports: {
    app: { getPath: () => os.tmpdir(), getAppPath: () => process.cwd(), isPackaged: false },
    net: {},
  },
};
const { UnifiedMeetingAsr } = require("../../src/helpers/unifiedMeetingAsr");
function runner(script) {
  const c = new UnifiedMeetingAsr({
    spawnImpl: (_, __, options) => spawn(process.execPath, ["-e", script], options),
  });
  c.getBinaryPath = () => "/fake/asr";
  c.getModelPath = () => "/fake/model";
  return c;
}
const consumer = `console.log(JSON.stringify({type:'ready'}));let pending=Buffer.alloc(0),received=[0,0];process.stdin.on('data',b=>{pending=Buffer.concat([pending,b]);while(pending.length>=12){const id=pending.readUInt32LE(),source=pending.readUInt32LE(4),n=pending.readUInt32LE(8);if(pending.length<n+12)return;const start=received[source];received[source]+=n/32;console.log(JSON.stringify({type:'result',id,text:n?'kept context':'final word',startMs:start,endMs:received[source],partial:''}));pending=pending.subarray(n+12)}});`;
test("one process keeps independent mic/system clocks and flushes final words", async () => {
  const c = runner(consumer);
  await c.start();
  const a = await c.feed("system", Buffer.alloc(160000), 1000000);
  const b = await c.feed("system", Buffer.alloc(160000), 1000000);
  const m = await c.feed("mic", Buffer.alloc(32000), 2000000);
  assert.equal(a.timestamp, 1000000);
  assert.equal(b.timestamp, 1005000);
  assert.equal(m.timestamp, 2000000);
  assert.equal((await c.finish("system")).text, "final word");
  await c.finish("mic");
  await c.stop();
  assert.equal(c.proc, null);
  assert.equal(c.pending.size, 0);
});
test("large capture backlogs split into bounded packets without dropping audio", async () => {
  const c = runner(consumer);
  await c.start();
  const r = await c.feed("system", Buffer.alloc(32000 * 25), 1000000);
  assert.equal(r.timestamp, 1000000);
  assert.equal(r.endTimestamp, 1025000);
  assert.equal(r.durationMs, 25000);
  assert.equal(r.text, "kept context kept context kept context");
  await c.stop();
});
test("startup failure rejects promptly rather than holding the recording open", async () => {
  const c = runner("process.exit(1)");
  await assert.rejects(c.start(), /exited/);
  await c.stop();
});
test("a crashed decoder rejects pending work and releases its process", async () => {
  const c = runner(
    `console.log(JSON.stringify({type:'ready'}));process.stdin.on('data',()=>process.exit(1))`
  );
  await c.start();
  await assert.rejects(c.feed("system", Buffer.alloc(32000), 1000000), /exited/);
  await c.stop();
  assert.equal(c.pending.size, 0);
});
