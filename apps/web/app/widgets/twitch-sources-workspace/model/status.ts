import type { TwitchVodCandidate } from "~/shared/api/twitch-sources";

const ACTIVE_INGEST_STATES = new Set([
  "QUEUED",
  "DOWNLOADING",
  "UPLOADING",
  "RETRY_WAIT",
]);

export function hasActiveTwitchImport(
  candidates: readonly TwitchVodCandidate[],
): boolean {
  return candidates.some(
    (candidate) =>
      candidate.ingestIntent &&
      ACTIVE_INGEST_STATES.has(candidate.ingestIntent.state),
  );
}
