export class SingleFlightTask {
  private current?: Promise<void>;

  constructor(private readonly task: () => Promise<void>) {}

  run(): Promise<void> {
    if (this.current) return this.current;
    const execution = this.task().finally(() => {
      if (this.current === execution) this.current = undefined;
    });
    this.current = execution;
    return execution;
  }

  wait(): Promise<void> {
    return this.current ?? Promise.resolve();
  }
}
