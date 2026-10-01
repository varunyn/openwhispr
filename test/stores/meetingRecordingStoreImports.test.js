const test = require("node:test");
const assert = require("node:assert/strict");
const { createRendererServer, installBrowserGlobals } = require("../lib/rendererTestHarness");

test("meetingRecordingStore still loads under the renderer harness after the reducer extraction", async (t) => {
  installBrowserGlobals(t);
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-store-import-test-",
  });

  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  const reducer = await vite.ssrLoadModule("/stores/meetingSegmentReducer.ts");

  assert.equal(typeof store.startRecording, "function");
  assert.equal(typeof store.useMeetingRecordingStore?.getState, "function");
  assert.equal(typeof reducer.reduceMeetingSegmentEvent, "function");
  const initial = store.useMeetingRecordingStore.getState();
  assert.deepEqual(initial.segments, []);
  assert.equal(initial.micPartial, "");
  assert.equal(initial.systemPartial, "");
});

test("returning to Auto clears the saved manual count and sends an automatic config", async (t) => {
  const configs = [];
  const updates = [];
  installBrowserGlobals(t, {
    window: {
      electronAPI: {
        setMeetingSessionSpeakerConfig: (config) => configs.push(config),
        updateNote: (id, patch) => updates.push({ id, patch }),
      },
    },
  });
  const vite = await createRendererServer(t, {
    cachePrefix: "openwhispr-meeting-store-auto-count-test-",
  });
  const store = await vite.ssrLoadModule("/stores/meetingRecordingStore.ts");
  store.useMeetingRecordingStore.setState({ recordingNoteId: 42 });
  store.setSessionExpectedCount(4);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(store.useMeetingRecordingStore.getState().userTouchedStepper, true);
  assert.deepEqual(configs[0], { enabled: true, expectedCount: 4, countIsExplicit: true });
  store.setSessionExpectedCount(0);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(store.useMeetingRecordingStore.getState().userTouchedStepper, false);
  assert.equal(configs[1].countIsExplicit, false);
  assert.deepEqual(updates.at(-1), { id: 42, patch: { expected_speaker_count: null } });
});
