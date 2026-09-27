export interface TwitchEventSubProvider {
  listWebhookSubscriptions(): Promise<
    Array<{ type: string; broadcasterId: string; callback: string }>
  >;
  createWebhookSubscription(
    type: "stream.online" | "stream.offline",
    broadcasterId: string,
  ): Promise<void>;
}

export class ReconcileTwitchEventSub {
  constructor(
    private readonly provider: TwitchEventSubProvider,
    private readonly callback: string,
  ) {}

  async execute(broadcasterIds: string[]): Promise<number> {
    const existing = new Set(
      (await this.provider.listWebhookSubscriptions())
        .filter((item) => item.callback === this.callback)
        .map((item) => `${item.type}:${item.broadcasterId}`),
    );
    let created = 0;
    for (const broadcasterId of new Set(broadcasterIds)) {
      for (const type of ["stream.online", "stream.offline"] as const) {
        const key = `${type}:${broadcasterId}`;
        if (existing.has(key)) continue;
        await this.provider.createWebhookSubscription(type, broadcasterId);
        existing.add(key);
        created += 1;
      }
    }
    return created;
  }
}
