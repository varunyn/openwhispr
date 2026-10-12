import type { TranscriptSegment } from "../stores/meetingRecordingStore";
import { normalizeTranscriptSegment } from "./transcriptSpeakerState";

export interface LiveSpeakerIdentification {
  speakerId: string;
  displayName?: string | null;
  startTime: number;
  endTime: number;
  provisional?: boolean;
}

export function applyLiveSpeakerIdentification(
  segment: TranscriptSegment,
  identification: LiveSpeakerIdentification
): TranscriptSegment {
  if (
    segment.source !== "system" ||
    segment.timestamp == null ||
    segment.timestamp < identification.startTime ||
    segment.timestamp > identification.endTime ||
    (segment.speaker && !segment.speakerIsPlaceholder && segment.speakerStatus !== "provisional") ||
    segment.speakerLocked ||
    segment.speakerLockSource === "user"
  )
    return segment;
  return normalizeTranscriptSegment({
    ...segment,
    speaker: identification.speakerId,
    speakerName:
      identification.displayName ??
      (segment.speaker === identification.speakerId ? segment.speakerName : undefined),
    speakerIsPlaceholder: false,
    speakerStatus: identification.provisional ? "provisional" : "confirmed",
  });
}
