import type { PublicationIntent } from "~/shared/api/publications";

const PENDING_PUBLICATION_STATES = new Set([
  "SCHEDULED",
  "QUEUED",
  "PROCESSING",
]);

export function hasPendingPublication(
  publications: readonly Pick<PublicationIntent, "state">[],
): boolean {
  return publications.some((item) =>
    PENDING_PUBLICATION_STATES.has(item.state),
  );
}
