export type TwitchVodMediaResponse = Readonly<{
  body: ReadableStream<Uint8Array>;
  contentType: "video/mp4";
  totalSizeBytes: bigint;
  offset: bigint;
  representationEtag: string;
}>;

export interface TwitchVodMediaProvider {
  open(
    providerVideoId: string,
    offset: bigint,
    expectedRepresentationEtag: string | null,
    signal?: AbortSignal,
  ): Promise<TwitchVodMediaResponse>;
}
