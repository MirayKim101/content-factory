export interface ScheduledPublicationSource {
  due(): Promise<string[]>;
}

export interface ScheduledPublicationProcessor {
  execute(intentId: string): Promise<boolean>;
}

export class ReconcileScheduledPublications {
  constructor(
    private readonly source: ScheduledPublicationSource,
    private readonly processor: ScheduledPublicationProcessor,
    private readonly onFailure: (
      intentId: string,
      error: unknown,
    ) => void = () => undefined,
  ) {}

  async execute(): Promise<number> {
    const intentIds = await this.source.due();
    let processed = 0;
    for (const intentId of intentIds) {
      try {
        if (await this.processor.execute(intentId)) processed += 1;
      } catch (error) {
        this.onFailure(intentId, error);
      }
    }
    return processed;
  }
}
