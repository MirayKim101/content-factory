import type {
  PublicationChannelView,
  PublicationIntentView,
} from "../domain/publication.js";

export function publicationChannelResponse(value: PublicationChannelView) {
  return {
    ...value,
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}

export function publicationIntentResponse(value: PublicationIntentView) {
  return {
    ...value,
    latestMetrics: value.latestMetrics
      ? {
          ...value.latestMetrics,
          observedAt: value.latestMetrics.observedAt.toISOString(),
        }
      : null,
    scheduledAt: value.scheduledAt.toISOString(),
    createdAt: value.createdAt.toISOString(),
    updatedAt: value.updatedAt.toISOString(),
  };
}
