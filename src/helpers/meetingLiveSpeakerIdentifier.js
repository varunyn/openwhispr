const legacy = require("./liveSpeakerIdentifier");
const { LiveNemotronDiarization } = require("./liveNemotronDiarization");
const nemotron = new LiveNemotronDiarization();
let active = legacy;
module.exports = {
  setDiarizationManager(manager) {
    legacy.setDiarizationManager(manager);
    nemotron.setDiarizationManager(manager);
  },
  isAvailable() {
    return nemotron.isAvailable() || legacy.isAvailable();
  },
  async start(callback, options) {
    active = nemotron.isAvailable() ? nemotron : legacy;
    return active.start(callback, options);
  },
  stop: () => active.stop(),
  feedAudio: (buffer) => active.feedAudio(buffer),
  recluster: () => active.recluster(),
  getSpeakerForInterval: (start, end) => active.getSpeakerForInterval?.(start, end) || null,
  getSpeakerEmbedding: (id) => active.getSpeakerEmbedding(id),
  mapSpeaker: (...args) => active.mapSpeaker(...args),
  setEnabled(value) {
    legacy.setEnabled(value);
    nemotron.setEnabled(value);
  },
  setMaxSpeakers(value) {
    legacy.setMaxSpeakers(value);
    nemotron.setMaxSpeakers(value);
  },
};
