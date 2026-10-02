export interface TwitchEventSubProvider {
  listWebhookSubscriptions(
    signal?: AbortSignal,
  ): Promise<
    Array<{
      id: string;
      type: string;
      broadcasterId: string;
      callback: string;
      active?: boolean;
    }>
  >;
  createWebhookSubscription(
    type: "stream.online" | "stream.offline",
    broadcasterId: string,
    signal?: AbortSignal,
  ): Promise<boolean>;
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
    options: {
      recreateAll?: boolean;
      onProgress?: () => Promise<void>;
    } = {},
  ): Promise<{ created: number; deleted: number }> {
    signal?.throwIfAborted();
    const allowed = new Set(broadcasterIds);
    let managed = (await this.provider.listWebhookSubscriptions(signal)).filter(
      (item) => item.callback === this.callback,
    );
    await options.onProgress?.();
    let deleted = 0;
    for (const item of managed) {
      signal?.throwIfAborted();
      if (
        !options.recreateAll &&
        item.active !== false &&
        allowed.has(item.broadcasterId)
      )
        continue;
      await options.onProgress?.();
      await this.provider.deleteWebhookSubscription(item.id, signal);
      await options.onProgress?.();
      deleted += 1;
    }
    if (options.recreateAll) managed = [];
    const existing = new Set(
      managed
        .filter(
          (item) => item.active !== false && allowed.has(item.broadcasterId),
        )
        .map((item) => `${item.type}:${item.broadcasterId}`),
    );
    let created = 0;
    for (const broadcasterId of new Set(broadcasterIds)) {
      for (const type of ["stream.online", "stream.offline"] as const) {
        signal?.throwIfAborted();
        const key = `${type}:${broadcasterId}`;
        if (existing.has(key)) continue;
        await options.onProgress?.();
        const createdNow = await this.provider.createWebhookSubscription(
          type,
          broadcasterId,
          signal,
        );
        if (options.recreateAll && !createdNow)
          throw new Error("TWITCH_EVENTSUB_ROTATION_CONFLICT");
        await options.onProgress?.();
        existing.add(key);
        if (createdNow) created += 1;
      }
    }
    return { created, deleted };
  }
}
