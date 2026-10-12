// Two persistent Unified EN streams sharing one model. Requests are serialized:
// u32le request id, channel (0 system / 1 mic), PCM16 byte count; zero finalizes.
#include <transcribe.h>
#include <cstdint>
#include <cstdio>
#include <string>
#include <vector>
#include <algorithm>
#include <sstream>
#include <cctype>

static std::string json(const std::string& value) {
  std::string out;
  for (unsigned char c : value) {
    if (c == '"' || c == '\\') { out += '\\'; out += c; }
    else if (c == '\n') out += "\\n";
    else if (c == '\r') out += "\\r";
    else if (c == '\t') out += "\\t";
    else if (c < 32) { char escaped[7]; std::snprintf(escaped, sizeof(escaped), "\\u%04x", c); out += escaped; }
    else out += c;
  }
  return out;
}
static uint32_t u32(const unsigned char* p) { return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24; }
int main(int argc, char** argv) {
  if (argc != 2) return 2;
  transcribe_model* model = nullptr;
  if (transcribe_model_load_file(argv[1], nullptr, &model) != TRANSCRIBE_OK) return 1;
  transcribe_session* sessions[2]{};
  size_t emitted[2]{};
  size_t wordsEmitted[2]{};
  int64_t lastCommit[2]{};
  bool finished[2]{};
  for (int i = 0; i < 2; ++i) {
    transcribe_session_params params; transcribe_session_params_init(&params); params.n_threads = 4;
    transcribe_run_params run; transcribe_run_params_init(&run); run.timestamps = TRANSCRIBE_TIMESTAMPS_WORD;
    if (transcribe_session_init(model, &params, &sessions[i]) != TRANSCRIBE_OK ||
        transcribe_stream_begin(sessions[i], &run, nullptr) != TRANSCRIBE_OK) return 1;
  }
  std::printf("{\"type\":\"ready\"}\n"); std::fflush(stdout);
  int code = 0;
  for (;;) {
    unsigned char header[12]; size_t read = std::fread(header, 1, 12, stdin);
    if (!read) break;
    if (read != 12) { code = 2; break; }
    uint32_t id = u32(header), channel = u32(header + 4), bytes = u32(header + 8);
    if (channel > 1 || finished[channel] || bytes > 16000 * 2 * 60 || bytes % 2) { code = 2; break; }
    transcribe_stream_update update; transcribe_stream_update_init(&update);
    transcribe_status status;
    if (bytes) {
      std::vector<unsigned char> pcm(bytes);
      if (std::fread(pcm.data(), 1, bytes, stdin) != bytes) { code = 2; break; }
      std::vector<float> samples(bytes / 2);
      for (size_t i = 0; i < samples.size(); ++i) samples[i] = float(int16_t(uint16_t(pcm[2*i]) | uint16_t(pcm[2*i+1]) << 8)) / 32768.f;
      status = transcribe_stream_feed(sessions[channel], samples.data(), int(samples.size()), &update);
    } else {
      status = transcribe_stream_finalize(sessions[channel], &update); finished[channel] = true;
    }
    if (status != TRANSCRIBE_OK) { std::fprintf(stderr, "Unified EN stream failed: %d\n", status); code = 1; break; }
    transcribe_stream_text text; transcribe_stream_text_init(&text);
    if (transcribe_stream_get_text(sessions[channel], &text) != TRANSCRIBE_OK) { code = 1; break; }
    const std::string committed(text.committed_text ? text.committed_text : "");
    size_t end = committed.size();
    // The stable API prefix can end inside a tokenized word. Hold that word
    // until a separator arrives (or finalize), so it cannot split across rows.
    if (bytes && end && committed.back() != ' ' && committed.back() != '\n') {
      const size_t separator = committed.find_last_of(" \n\t");
      end = separator == std::string::npos ? emitted[channel] : separator + 1;
    }
    end = std::max(end, emitted[channel]);
    const std::string delta = committed.substr(emitted[channel], end - emitted[channel]);
    emitted[channel] = end;
    const int64_t start = lastCommit[channel];
    const int64_t until = update.audio_committed_ms > 0 ? update.audio_committed_ms : update.input_received_ms;
    if (!delta.empty()) lastCommit[channel] = std::max(start, until);
    std::printf("{\"type\":\"result\",\"id\":%u,\"text\":\"%s\",\"partial\":\"%s\",\"startMs\":%lld,\"endMs\":%lld,\"final\":%s,\"words\":[", id, json(delta).c_str(), json(text.tentative_text ? text.tentative_text : "").c_str(), (long long)start, (long long)std::max(start, until), bytes ? "false" : "true");
    std::istringstream tokens(delta); std::string token; bool firstWord = true;
    struct TimedWord { std::string text; int64_t start = 0, end = 0; };
    std::vector<TimedWord> aligned;
    TimedWord current;
    // The streaming family exposes aligned subword tokens rather than word
    // rows. Whitespace-prefixed pieces form words; punctuation stays attached.
    for (int j = 0; j < transcribe_n_tokens(sessions[channel]); ++j) {
      transcribe_token tk; transcribe_token_init(&tk);
      if (transcribe_get_token(sessions[channel], j, &tk) != TRANSCRIBE_OK || !tk.text) continue;
      for (const unsigned char* c = (const unsigned char*)tk.text; *c; ++c) {
        if (std::isspace(*c)) {
          if (!current.text.empty()) { aligned.push_back(current); current = {}; }
        } else {
          if (current.text.empty()) current.start = tk.t0_ms;
          current.text += *c; current.end = std::max(current.end, tk.t1_ms);
        }
      }
    }
    if (!current.text.empty()) aligned.push_back(current);
    while (tokens >> token) {
      const size_t index = wordsEmitted[channel]++;
      if (index >= aligned.size()) continue;
      const auto& word = aligned[index];
      if (word.text != token || word.start < 0 || word.end < word.start) continue;
      std::printf("%s{\"text\":\"%s\",\"startMs\":%lld,\"endMs\":%lld}", firstWord ? "" : ",", json(token).c_str(), (long long)word.start, (long long)word.end);
      firstWord = false;
    }
    std::printf("]}\n"); std::fflush(stdout);
  }
  for (auto session : sessions) transcribe_session_free(session);
  transcribe_model_free(model);
  return code;
}
