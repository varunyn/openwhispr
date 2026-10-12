/**
 * Pure input-selection policy for post-meeting diarization.
 *
 * A meeting session records two parallel raw PCM captures: the system-audio
 * tap (calls) and the microphone (in-person sessions, kept only until system
 * audio turns audible). At stop, exactly one of them feeds the diarizer and
 * the other is deleted. Call sessions keep today's behavior: any session that
 * heard audible system audio diarizes the system channel.
 */
function resolveDiarizationInput({
  systemPcmPath = null,
  micPcmPath = null,
  systemAudioHeard = false,
  systemStartedAt = null,
  micStartedAt = null,
} = {}) {
  if (systemAudioHeard || !micPcmPath) {
    return {
      pcmPath: systemPcmPath,
      startedAt: systemStartedAt,
      diarizedSource: "system",
      cleanupPcmPaths: micPcmPath ? [micPcmPath] : [],
    };
  }

  return {
    pcmPath: micPcmPath,
    startedAt: micStartedAt,
    diarizedSource: "mic",
    cleanupPcmPaths: systemPcmPath ? [systemPcmPath] : [],
  };
}

function normalizeMeetingDiarizationTimestamps(segments, startedAt) {
  return segments.map((segment) => ({
    ...segment,
    ...(Number.isFinite(segment.endTimestamp)
      ? {
          endTimestamp:
            segment.endTimestamp > 1e9 && startedAt > 1e9
              ? (segment.endTimestamp - startedAt) / 1000
              : segment.endTimestamp,
        }
      : {}),
    timestamp: Number.isFinite(segment.timestamp)
      ? segment.timestamp > 1e9 && startedAt > 1e9
        ? (segment.timestamp - startedAt) / 1000
        : segment.timestamp
      : undefined,
  }));
}

module.exports = { resolveDiarizationInput, normalizeMeetingDiarizationTimestamps };
