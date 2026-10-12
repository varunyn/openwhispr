// Stateful Nemotron diarization sidecar. stdin: u32le byte count + 24 kHz mono
// PCM16 payload (zero count finishes). stdout: newline-delimited JSON events.
#include <nemo_speech/diar.h>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <vector>

static bool check(nemo_speech_asr_status status) {
  if (status == NEMO_SPEECH_ASR_OK) return true;
  std::fprintf(stderr, "Nemotron: %s\n", nemo_speech_asr_last_error());
  return false;
}

static bool emit(nemo_speech_diar_model* model, nemo_speech_diar_stream* stream, bool final, double inputSeconds) {
  size_t count = 0;
  if (!check(nemo_speech_diar_segments(stream, nullptr, nullptr, 0, &count))) return false;
  std::vector<nemo_speech_diar_segment> segments(count);
  if (count && !check(nemo_speech_diar_segments(stream, nullptr, segments.data(), count, &count))) return false;
  const double through = nemo_speech_diar_frame_count(stream) * nemo_speech_diar_seconds_per_frame(model);
  // Revisit the recent tail, where hysteresis and streaming context may revise
  // a boundary. The library compacts older probabilities itself on long calls.
  std::printf("{\"type\":\"segments\",\"through\":%.6f,\"inputSeconds\":%.6f,\"final\":%s,\"segments\":[", through, inputSeconds, final ? "true" : "false");
  double activity[8]{};
  for (const auto& s : segments) if (s.speaker >= 1 && s.speaker <= 8) activity[s.speaker - 1] += s.end_time - s.start_time;
  bool first = true;
  for (const auto& s : segments) {
    if (s.end_time < through - 30.0) continue;
    std::printf("%s{\"start\":%.6f,\"end\":%.6f,\"speaker\":%d}", first ? "" : ",", s.start_time, s.end_time, s.speaker);
    first = false;
  }
  std::printf("],\"activity\":[");
  for (int i = 0; i < 8; ++i) std::printf("%s%.6f", i ? "," : "", activity[i]);
  std::printf("]}\n");
  std::fflush(stdout);
  return true;
}

int main(int argc, char** argv) {
  if (argc != 2) { std::fprintf(stderr, "Usage: nemotron-live MODEL.gguf\n"); return 2; }
  nemo_speech_diar_model_config config{};
  config.size = sizeof(config);
  config.model_path = argv[1];
  config.gpu = 0;
  config.preset = "v3-streaming";
  config.left_context_frames = -1;
  nemo_speech_diar_model* model = nullptr;
  if (!check(nemo_speech_diar_create(&config, &model))) return 1;
  nemo_speech_diar_stream* stream = nullptr;
  if (!check(nemo_speech_diar_stream_open(model, &stream))) { nemo_speech_diar_destroy(model); return 1; }
  std::printf("{\"type\":\"ready\"}\n"); std::fflush(stdout);
  int result = 0;
  int64_t lastFrames = 0;
  size_t inputSamples = 0;
  for (;;) {
    unsigned char header[4];
    const size_t read = std::fread(header, 1, 4, stdin);
    if (read == 0) break;
    if (read != 4) { result = 2; break; }
    const uint32_t bytes = uint32_t(header[0]) | uint32_t(header[1]) << 8 | uint32_t(header[2]) << 16 | uint32_t(header[3]) << 24;
    if (bytes == 0) break;
    if (bytes > 96000 || bytes % 2) { result = 2; break; }
    std::vector<unsigned char> pcm(bytes);
    if (std::fread(pcm.data(), 1, bytes, stdin) != bytes) { result = 2; break; }
    std::vector<float> samples(bytes / 2);
    for (size_t i = 0; i < samples.size(); ++i) {
      const int16_t sample = static_cast<int16_t>(uint16_t(pcm[2*i]) | uint16_t(pcm[2*i+1]) << 8);
      samples[i] = float(sample) / 32768.0f;
    }
    if (!check(nemo_speech_diar_stream_push_f32(stream, samples.data(), samples.size(), 24000))) { result = 1; break; }
    inputSamples += samples.size();
    const int64_t frames = nemo_speech_diar_frame_count(stream);
    if (frames != lastFrames) {
      if (!emit(model, stream, false, inputSamples / 24000.0)) { result = 1; break; }
      lastFrames = frames;
    }
  }
  if (!result && (!check(nemo_speech_diar_stream_finish(stream)) || !emit(model, stream, true, inputSamples / 24000.0))) result = 1;
  nemo_speech_diar_stream_close(stream);
  nemo_speech_diar_destroy(model);
  return result;
}
