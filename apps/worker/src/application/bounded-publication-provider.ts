import type {
  PublicationAdapterResult,
  PublicationClaim,
  PublicationMetricsClaim,
  PublicationMetricsSnapshot,
  PublicationProvider,
  PublicationReconciliationClaim,
  PublicationReconciliationResult,
} from "./publication.port.js";

type Release = () => void;
type Waiter = {
  resolve: (release: Release) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

class AbortAwarePermitPool {
  private available: number;
  private readonly waiters: Waiter[] = [];

  constructor(capacity: number) {
    if (!Number.isSafeInteger(capacity) || capacity < 1 || capacity > 32)
      throw new Error("PUBLICATION_PROVIDER_CONCURRENCY_INVALID");
    this.available = capacity;
  }

  acquire(signal?: AbortSignal): Promise<Release> {
    signal?.throwIfAborted();
    if (this.available > 0) {
      this.available -= 1;
      return Promise.resolve(this.releaseOnce());
    }
    return new Promise<Release>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, signal };
      waiter.onAbort = () => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(signal?.reason);
      };
      signal?.addEventListener("abort", waiter.onAbort, { once: true });
      this.waiters.push(waiter);
    });
  }

  private releaseOnce(): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.available += 1;
        return;
      }
      if (waiter.onAbort)
        waiter.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.resolve(this.releaseOnce());
    };
  }
}

export class BoundedPublicationProvider implements PublicationProvider {
  readonly platform;
  readonly reconcile?: (
    claim: PublicationReconciliationClaim,
    signal?: AbortSignal,
  ) => Promise<PublicationReconciliationResult>;
  readonly metrics?: (
    claim: PublicationMetricsClaim,
    signal?: AbortSignal,
  ) => Promise<PublicationMetricsSnapshot>;
  private readonly pool: AbortAwarePermitPool;
  private consecutiveTransientFailures = 0;
  private circuitOpenedAt: number | null = null;

  constructor(
    private readonly provider: PublicationProvider,
    concurrency: number,
    private readonly circuit: {
      failureThreshold: number;
      cooldownMs: number;
      clock?: () => number;
    } = { failureThreshold: 3, cooldownMs: 60_000 },
  ) {
    if (
      !Number.isSafeInteger(circuit.failureThreshold) ||
      circuit.failureThreshold < 1 ||
      circuit.failureThreshold > 100 ||
      !Number.isSafeInteger(circuit.cooldownMs) ||
      circuit.cooldownMs < 1 ||
      circuit.cooldownMs > 3_600_000
    )
      throw new Error("PUBLICATION_PROVIDER_CIRCUIT_INVALID");
    this.platform = provider.platform;
    this.pool = new AbortAwarePermitPool(concurrency);
    if (provider.reconcile)
      this.reconcile = (claim, signal) =>
        this.run(signal, () => provider.reconcile!(claim, signal));
    if (provider.metrics)
      this.metrics = (claim, signal) =>
        this.run(signal, () => provider.metrics!(claim, signal));
  }

  publish(
    claim: PublicationClaim,
    signal?: AbortSignal,
  ): Promise<PublicationAdapterResult> {
    return this.run(signal, () => this.provider.publish(claim, signal));
  }

  private async run<T>(
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    this.assertCircuitAvailable();
    const release = await this.pool.acquire(signal);
    try {
      this.assertCircuitAvailable();
      signal?.throwIfAborted();
      const result = await operation();
      this.consecutiveTransientFailures = 0;
      this.circuitOpenedAt = null;
      return result;
    } catch (error) {
      if (transientProviderFailure(error)) {
        this.consecutiveTransientFailures += 1;
        if (this.consecutiveTransientFailures >= this.circuit.failureThreshold)
          this.circuitOpenedAt = this.now();
      }
      throw error;
    } finally {
      release();
    }
  }

  private assertCircuitAvailable(): void {
    if (
      this.circuitOpenedAt !== null &&
      this.now() - this.circuitOpenedAt < this.circuit.cooldownMs
    )
      throw new Error("PUBLICATION_PROVIDER_CIRCUIT_OPEN");
  }

  private now(): number {
    return this.circuit.clock?.() ?? Date.now();
  }
}

function transientProviderFailure(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "TypeError") return true;
  return /(?:_5\d\d|TIMEOUT|ECONN|ENET|EAI_AGAIN|NETWORK|fetch failed)$/i.test(
    error.message,
  );
}
