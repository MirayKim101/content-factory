export interface TwitchEventSubProvider {
  listWebhookSubscriptions(
    signal?: AbortSignal,
  ): Promise<
    Array<{ id: string; type: string; broadcasterId: string; callback: string }>
  >;
  createWebhookSubscription(
    type: "stream.online" | "stream.offline",
    broadcasterId: string,
    signal?: AbortSignal,
  ): Promise<void>;
  deleteWebhookSubscription(id: string, signal?: AbortSignal): Promise<void>;
}

export class ReconcileTwitchEventSub {
  constructor(
    private readonly provider: TwitchEventSubProvider,
    private readonly callback: string,
  ) {}

  async execute(
    broadcasterIds: string[],
    signal?: AbortSignal,
  ): Promise<{ created: number; deleted: number }> {
    signal?.throwIfAborted();
    const allowed = new Set(broadcasterIds);
    const managed = (
      await this.provider.listWebhookSubscriptions(signal)
    ).filter((item) => item.callback === this.callback);
    let deleted = 0;
    for (const item of managed) {
      signal?.throwIfAborted();
      if (allowed.has(item.broadcasterId)) continue;
      await this.provider.deleteWebhookSubscription(item.id, signal);
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
        signal?.throwIfAborted();
        const key = `${type}:${broadcasterId}`;
        if (existing.has(key)) continue;
        await this.provider.createWebhookSubscription(
          type,
          broadcasterId,
          signal,
        );
        existing.add(key);
        created += 1;
      }
    }
    return { created, deleted };
  }
}
