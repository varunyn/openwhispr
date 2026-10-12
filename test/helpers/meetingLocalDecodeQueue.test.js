const test = require("node:test"),
  assert = require("node:assert/strict");
const { createMeetingLocalDecodeQueue } = require("../../src/helpers/meetingLocalDecodeQueue");
test("stop waits for an in-flight decode and processes its trailing audio", async () => {
  let release;
  const gate = new Promise((r) => {
    release = r;
  });
  let buffers = ["first"],
    calls = [];
  const queue = createMeetingLocalDecodeQueue(async () => {
    const taken = buffers.splice(0);
    calls.push(taken);
    if (calls.length === 1) await gate;
  });
  const first = queue.run();
  await Promise.resolve();
  buffers.push("tail");
  await queue.run();
  assert.deepEqual(calls, [["first"]]);
  let stopped = false;
  const stop = queue.run({ drain: true }).then(() => {
    stopped = true;
  });
  await Promise.resolve();
  assert.equal(stopped, false);
  release();
  await Promise.all([first, stop]);
  assert.deepEqual(calls, [["first"], ["tail"]]);
  assert.equal(stopped, true);
});
test("a failed decode releases ownership for a later batch", async () => {
  let count = 0;
  const queue = createMeetingLocalDecodeQueue(async () => {
    if (++count === 1) throw Error("decoder failed");
  });
  await assert.rejects(queue.run(), /decoder failed/);
  await queue.run();
  assert.equal(count, 2);
});
