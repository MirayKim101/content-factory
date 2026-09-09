export interface StartupBarrier {
  connectDatabase(): Promise<void>;
  reconcile(): Promise<void>;
  waitForConsumer(): Promise<void>;
}

export async function passStartupBarrier(
  barrier: StartupBarrier,
): Promise<void> {
  await barrier.connectDatabase();
  await barrier.reconcile();
  await barrier.waitForConsumer();
}

export function observeConsumer(
  consumer: Promise<void>,
  onFatal: (error: unknown) => Promise<void>,
): void {
  void consumer.catch(onFatal);
}
