import type {
  TwitchIngestionWorkerRepository,
  TwitchVideoProvider,
} from "./twitch-reconciliation.port.js";

const MAX_PAGES_PER_CHANNEL_RUN = 5;

export class ReconcileTwitchIngestion {
  constructor(
    private readonly repository: TwitchIngestionWorkerRepository,
    private readonly provider: TwitchVideoProvider,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async execute(): Promise<{
    events: number;
    channels: number;
    failedChannels: string[];
  }> {
    const events = await this.repository.processInbox();
    await this.repository.promoteReady(this.clock());
    const channels = await this.repository.dueChannels();
    const failedChannels: string[] = [];
    for (const channel of channels) {
      try {
        const seenCursors = new Set<string>();
        for (
          let pageNumber = 0;
          pageNumber < MAX_PAGES_PER_CHANNEL_RUN;
          pageNumber++
        ) {
          const requestedCursor = channel.cursor;
          if (requestedCursor && seenCursors.has(requestedCursor))
            throw new Error("TWITCH_CURSOR_CYCLE");
          if (requestedCursor) seenCursors.add(requestedCursor);
          const page = await this.provider.listArchives(
            channel.broadcasterId,
            requestedCursor,
          );
          const applied = await this.repository.applyVodPage(
            channel,
            page,
            this.clock(),
          );
          if (!applied) break;
          channel.cursor = page.nextCursor;
          if (!page.nextCursor) break;
        }
      } catch {
        failedChannels.push(channel.id);
      }
    }
    return { events, channels: channels.length, failedChannels };
  }
}
