import type { PublicationPlatform } from "@content-factory/contracts";

export interface PublishingCapabilities {
  publishingEnabled: boolean;
  localDryRunEnabled: boolean;
  youtubeEnabled: boolean;
  tiktokEnabled: boolean;
}

export function resolvePublishingCapabilities(
  publishingEnabled: boolean,
  youtubeEnabled: boolean,
  tiktokEnabled: boolean,
): PublishingCapabilities {
  return {
    publishingEnabled,
    localDryRunEnabled: publishingEnabled,
    youtubeEnabled: publishingEnabled && youtubeEnabled,
    tiktokEnabled: publishingEnabled && tiktokEnabled,
  };
}

export function publicationPlatformEnabled(
  capabilities: PublishingCapabilities,
  platform: PublicationPlatform,
): boolean {
  if (platform === "LOCAL_DRY_RUN") return capabilities.localDryRunEnabled;
  if (platform === "YOUTUBE") return capabilities.youtubeEnabled;
  return capabilities.tiktokEnabled;
}
