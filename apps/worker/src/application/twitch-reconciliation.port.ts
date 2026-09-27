export interface TwitchChannelReconciliationTarget {
  id: string;
  broadcasterId: string;
  cursor: string | null;
  ingestDelaySeconds: number;
}

export interface TwitchVodMetadata {
  providerVideoId: string;
  streamId: string | null;
  title: string;
  vodType: "archive" | "highlight" | "upload";
  durationSeconds: number;
  startedAt: Date;
  publishedAt: Date;
}

export interface TwitchVodPage {
  items: TwitchVodMetadata[];
  nextCursor: string | null;
}

export interface TwitchVideoProvider {
  listArchives(
    broadcasterId: string,
    cursor: string | null,
    signal?: AbortSignal,
  ): Promise<TwitchVodPage>;
}

export interface TwitchIngestionWorkerRepository {
  enabledBroadcasterIds(limit?: number): Promise<string[]>;
  processInbox(limit?: number): Promise<number>;
  promoteReady(now: Date): Promise<number>;
  dueChannels(limit?: number): Promise<TwitchChannelReconciliationTarget[]>;
  applyVodPage(
    channel: TwitchChannelReconciliationTarget,
    page: TwitchVodPage,
    now: Date,
  ): Promise<boolean>;
  close(): Promise<void>;
}
