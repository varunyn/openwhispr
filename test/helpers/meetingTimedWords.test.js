const test = require("node:test"),
  assert = require("node:assert/strict");
const { groupMeetingTimedWords } = require("../../src/helpers/meetingTimedWords");
test("timed speech is grouped into short rows without duplicating or dropping words", () => {
  const words = [
    { text: "First", startMs: 1000, endMs: 1500 },
    { text: "person.", startMs: 1600, endMs: 2100 },
    { text: "Next", startMs: 3000, endMs: 3500 },
    { text: "speaker.", startMs: 3600, endMs: 4000 },
  ];
  const groups = groupMeetingTimedWords("First person. Next speaker.", words, 1000000);
  assert.equal(groups.length, 2);
  assert.equal(groups.map((g) => g.text).join(" "), "First person. Next speaker.");
  assert.equal(groups[0].timestamp, 1001000);
  assert.equal(groups[0].endTimestamp, 1002100);
  assert.equal(groups[1].timestamp, 1003000);
});
test("incomplete or invalid timing falls back to full text rather than losing speech", () => {
  assert.deepEqual(
    groupMeetingTimedWords("two words", [{ text: "two", startMs: 0, endMs: 100 }], 1000000),
    []
  );
  assert.deepEqual(
    groupMeetingTimedWords("two", [{ text: "two", startMs: 100, endMs: 0 }], 1000000),
    []
  );
});

test("a detected speaker handoff splits a row even inside the short grouping window", () => {
  const words = [
    { text: "anything.", startMs: 263040, endMs: 263200 },
    { text: "I'm", startMs: 263200, endMs: 263360 },
    { text: "just", startMs: 263360, endMs: 263520 },
    { text: "No,", startMs: 263840, endMs: 264080 },
    { text: "I", startMs: 264080, endMs: 264400 },
  ];
  const groups = groupMeetingTimedWords(
    "anything. I'm just No, I",
    words,
    1000000,
    1500,
    (start) => (start < 1263611 ? "speaker_3" : "speaker_1")
  );
  assert.deepEqual(
    groups.map((g) => g.text),
    ["anything. I'm just", "No, I"]
  );
  assert.deepEqual(
    groups.map((g) => g.speakerHint),
    ["speaker_3", "speaker_1"]
  );
});
