export type TwitchVodMediaResponse = Readonly<{
  body: ReadableStream<Uint8Array>;
  contentType: "video/mp4";
  totalSizeBytes: bigint;
  offset: bigint;
}>;

export interface TwitchVodMediaProvider {
  open(
    providerVideoId: string,
    offset: bigint,
    signal?: AbortSignal,
  ): Promise<TwitchVodMediaResponse>;
}
