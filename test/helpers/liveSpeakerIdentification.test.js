const test = require("node:test");
const assert = require("node:assert/strict");
const { applyLiveSpeakerIdentification } = require("../../src/utils/liveSpeakerIdentification.ts");
const identification = {
  speakerId: "speaker_1",
  startTime: 1000,
  endTime: 4000,
  provisional: true,
};
const segment = {
  text: "hello",
  source: "system",
  timestamp: 2000,
  speaker: "speaker_0",
  speakerName: "Old voice",
  speakerStatus: "provisional",
};
test("a revised streaming identity replaces a provisional label and clears the old voice's name", () => {
  const result = applyLiveSpeakerIdentification(segment, identification);
  assert.equal(result.speaker, "speaker_1");
  assert.equal(result.speakerName, undefined);
  assert.equal(result.speakerStatus, "provisional");
  const revised = applyLiveSpeakerIdentification(result, {
    ...identification,
    speakerId: "speaker_0",
  });
  assert.equal(revised.speaker, "speaker_0");
});
test("microphone, user locks, confirmed final labels and other time windows survive streaming revisions", () => {
  for (const preserved of [
    { ...segment, source: "mic" },
    { ...segment, speakerLocked: true },
    { ...segment, speakerLockSource: "user" },
    { ...segment, speakerStatus: "confirmed" },
    { ...segment, timestamp: 5000 },
  ]) {
    assert.equal(applyLiveSpeakerIdentification(preserved, identification), preserved);
  }
});
test("legacy identifications still confirm a speaker", () => {
  const result = applyLiveSpeakerIdentification(segment, {
    ...identification,
    provisional: false,
    displayName: "Ada",
  });
  assert.equal(result.speakerStatus, "confirmed");
  assert.equal(result.speakerName, "Ada");
});
