// Keep a row short enough to follow a voice handoff, and preserve actual speech
// intervals rather than using the time inference finished. Incomplete alignment
// falls back to the complete transcript; it must never silently lose words.
function groupMeetingTimedWords(
  text,
  words,
  anchor,
  maxDurationMs = 1500,
  speakerForInterval = null
) {
  if (!Array.isArray(words) || !words.length || !Number.isFinite(anchor)) return [];
  const normalize = (value) => value.trim().replace(/\s+/g, " ");
  if (normalize(words.map((w) => w.text).join(" ")) !== normalize(text)) return [];
  const groups = [];
  for (const word of words) {
    if (
      !Number.isFinite(word.startMs) ||
      !Number.isFinite(word.endMs) ||
      word.startMs < 0 ||
      word.endMs < word.startMs
    )
      return [];
    const timestamp = anchor + word.startMs;
    const endTimestamp = anchor + word.endMs;
    const speakerHint = speakerForInterval?.(timestamp, endTimestamp) || null;
    const previous = groups.at(-1);
    if (previous && timestamp < previous.timestamp) return [];
    if (
      previous &&
      previous.speakerHint === speakerHint &&
      endTimestamp - previous.timestamp <= maxDurationMs &&
      timestamp - previous.endTimestamp < 500
    ) {
      previous.text += ` ${word.text}`;
      previous.endTimestamp = endTimestamp;
      previous.durationMs = endTimestamp - previous.timestamp;
    } else
      groups.push({
        success: true,
        speakerHint,
        text: word.text,
        timestamp,
        endTimestamp,
        durationMs: endTimestamp - timestamp,
      });
  }
  return groups;
}
module.exports = { groupMeetingTimedWords };
