import type { PublicationPlatform } from "@content-factory/contracts";

export interface PublicationAccessTokenResolver {
  resolve(input: {
    channelId: string;
    platform: PublicationPlatform;
    externalChannelRef: string;
  }): Promise<string>;
}
