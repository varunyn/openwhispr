const test = require("node:test");
const assert = require("node:assert/strict");

const {
  resolveDiarizationInput,
  normalizeMeetingDiarizationTimestamps,
} = require("../../src/helpers/meetingDiarizationInput");

test("audible system audio diarizes the system capture", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: true,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-1.pcm",
    startedAt: 1000,
    diarizedSource: "system",
    cleanupPcmPaths: ["/tmp/ow-diarize-raw-mic-1.pcm"],
  });
});

test("a silent system capture yields to the mic capture", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: false,
    systemStartedAt: 1000,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    startedAt: 900,
    diarizedSource: "mic",
    cleanupPcmPaths: ["/tmp/ow-diarize-raw-1.pcm"],
  });
});

test("a silent system capture with no mic capture keeps today's system path", () => {
  const input = resolveDiarizationInput({
    systemPcmPath: "/tmp/ow-diarize-raw-1.pcm",
    micPcmPath: null,
    systemAudioHeard: false,
    systemStartedAt: 1000,
    micStartedAt: null,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-1.pcm",
    startedAt: 1000,
    diarizedSource: "system",
    cleanupPcmPaths: [],
  });
});

test("no capture at all skips diarization without cleanup work", () => {
  const input = resolveDiarizationInput({});

  assert.deepEqual(input, {
    pcmPath: null,
    startedAt: null,
    diarizedSource: "system",
    cleanupPcmPaths: [],
  });
});

test("mic-only capture (no system channel) diarizes the mic", () => {
  // Linux "unsupported" system-audio mode never delivers a system chunk, so
  // only the mic capture exists.
  const input = resolveDiarizationInput({
    systemPcmPath: null,
    micPcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    systemAudioHeard: false,
    systemStartedAt: null,
    micStartedAt: 900,
  });

  assert.deepEqual(input, {
    pcmPath: "/tmp/ow-diarize-raw-mic-1.pcm",
    startedAt: 900,
    diarizedSource: "mic",
    cleanupPcmPaths: [],
  });
});

test("final pass normalizes epoch timestamps without converting resumed relative timestamps again", () => {
  const startedAt = 1791470000000;
  const segments = [
    { timestamp: startedAt + 5000, source: "system", text: "new" },
    { timestamp: 2.5, source: "mic", speakerLocked: true, text: "saved" },
    { source: "mic", text: "missing" },
  ];
  const normalized = normalizeMeetingDiarizationTimestamps(segments, startedAt);
  assert.equal(normalized[0].timestamp, 5);
  assert.equal(normalized[1].timestamp, 2.5);
  assert.equal(normalized[1].speakerLocked, true);
  assert.equal(normalized[2].timestamp, undefined);
  assert.equal(segments[0].timestamp, startedAt + 5000);
});

test("speech end times share the same absolute-to-relative conversion as starts", () => {
  const {
    normalizeMeetingDiarizationTimestamps,
  } = require("../../src/helpers/meetingDiarizationInput");
  const epoch = 1791820000000;
  assert.deepEqual(
    normalizeMeetingDiarizationTimestamps(
      [{ timestamp: epoch + 1000, endTimestamp: epoch + 1400 }],
      epoch
    ),
    [{ timestamp: 1, endTimestamp: 1.4 }]
  );
});
