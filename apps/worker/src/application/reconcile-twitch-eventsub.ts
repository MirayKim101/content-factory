export interface TwitchEventSubProvider {
  listWebhookSubscriptions(): Promise<
    Array<{ id: string; type: string; broadcasterId: string; callback: string }>
  >;
  createWebhookSubscription(
    type: "stream.online" | "stream.offline",
    broadcasterId: string,
  ): Promise<void>;
  deleteWebhookSubscription(id: string): Promise<void>;
}

export class ReconcileTwitchEventSub {
  constructor(
    private readonly provider: TwitchEventSubProvider,
    private readonly callback: string,
  ) {}

  async execute(
    broadcasterIds: string[],
  ): Promise<{ created: number; deleted: number }> {
    const allowed = new Set(broadcasterIds);
    const managed = (await this.provider.listWebhookSubscriptions()).filter(
      (item) => item.callback === this.callback,
    );
    let deleted = 0;
    for (const item of managed) {
      if (allowed.has(item.broadcasterId)) continue;
      await this.provider.deleteWebhookSubscription(item.id);
      deleted += 1;
    }
    const existing = new Set(
      managed
        .filter((item) => allowed.has(item.broadcasterId))
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
    return { created, deleted };
  }
}
