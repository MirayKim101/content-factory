import type {
  TwitchIngestionWorkerRepository,
  TwitchVideoProvider,
} from "./twitch-reconciliation.port.js";

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
    const channels = await this.repository.dueChannels();
    const failedChannels: string[] = [];
    for (const channel of channels) {
      try {
        const page = await this.provider.listArchives(
          channel.broadcasterId,
          channel.cursor,
        );
        await this.repository.applyVodPage(channel, page, this.clock());
      } catch {
        failedChannels.push(channel.id);
      }
    }
    return { events, channels: channels.length, failedChannels };
  }
}
