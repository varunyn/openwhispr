const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { afterEach, test } = require("node:test");

const MeetingAudioStorage = require("../../src/helpers/meetingAudioStorage");

const directories = [];
const sessionId = "b47cc7e7-8996-4092-b929-53d07f60d6e2";

function storage(now = () => 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openwhispr-meeting-audio-"));
  directories.push(dir);
  return new MeetingAudioStorage(dir, now);
}

afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

test("saves aligned mic and system PCM as one stereo WAV for the note", () => {
  const manager = storage();
  assert.equal(manager.begin(42, sessionId), true);
  const mic = Buffer.alloc(4);
  mic.writeInt16LE(1000, 0);
  mic.writeInt16LE(-1000, 2);
  const system = Buffer.alloc(2);
  system.writeInt16LE(2000, 0);
  manager.append("mic", mic, 0);
  manager.append("system", system, 1); // 24 samples after the mic starts
  const file = manager.finish();
  assert.ok(file?.endsWith(".wav"));
  assert.deepEqual(manager.filesForNote(42), [file]);
  assert.deepEqual(manager.filesForNote(43), []);
  const wav = fs.readFileSync(file);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt16LE(22), 2);
  assert.equal(wav.readUInt32LE(24), 24000);
  assert.equal(wav.readUInt32LE(40), 25 * 4);
  assert.equal(wav.readInt16LE(44), 1000); // left / mic
  assert.equal(wav.readInt16LE(46), 0); // right / system
  assert.equal(wav.readInt16LE(48), -1000);
  assert.equal(wav.readInt16LE(44 + 24 * 4 + 2), 2000); // delayed right channel
});

test("retention removes expired recordings and note deletion removes only its files", () => {
  let now = Date.now();
  const manager = storage(() => now);
  manager.begin(42, sessionId);
  manager.append("mic", Buffer.from([1, 0]), now);
  const oldFile = manager.finish();
  now += 2 * 86400000;
  manager.cleanupExpired(1);
  assert.equal(fs.existsSync(oldFile), false);

  manager.begin(42, sessionId);
  manager.append("mic", Buffer.from([1, 0]), now);
  const note42File = manager.finish();
  manager.begin(43, sessionId);
  manager.append("system", Buffer.from([2, 0]), now);
  const note43File = manager.finish();
  manager.deleteForNote(42);
  assert.equal(fs.existsSync(note42File), false);
  assert.equal(fs.existsSync(note43File), true);
});

test("aborting an active meeting discards its temporary audio", () => {
  const manager = storage();
  manager.begin(42, sessionId);
  manager.append("mic", Buffer.from([1, 0]));
  manager.abort();
  assert.deepEqual(fs.readdirSync(manager.dir), []);
  assert.equal(manager.finish(), null);
});
