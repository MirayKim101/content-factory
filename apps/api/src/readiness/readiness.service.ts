import { Inject, Injectable, type OnModuleDestroy } from "@nestjs/common";
import { HeadBucketCommand } from "@aws-sdk/client-s3";

import {
  READINESS_CLEANUP_TIMEOUT_MS,
  READINESS_RESPONSE_TIMEOUT_MS,
} from "./readiness.constants.js";
import {
  READINESS_RESOURCE_FACTORY,
  type ReadinessPostgresClient,
  type ReadinessResourceFactoryPort,
  type ReadinessResources,
} from "./readiness.resources.js";

@Injectable()
export class ReadinessService implements OnModuleDestroy {
  private closed = false;
  private inFlight: Promise<boolean> | undefined;
  private draining: Promise<void> | undefined;
  private activeAbort: AbortController | undefined;

  constructor(
    @Inject(READINESS_RESOURCE_FACTORY)
    private readonly resourceFactory: ReadinessResourceFactoryPort,
  ) {}

  isReady(): Promise<boolean> {
    if (this.closed) return Promise.resolve(false);
    if (this.inFlight) return this.inFlight;
    if (this.draining) return Promise.resolve(false);
    this.inFlight = this.checkOnce()
      .then((ready) => ready && !this.closed)
      .finally(() => {
        this.inFlight = undefined;
      });
    return this.inFlight;
  }

  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.activeAbort?.abort(new Error("READINESS_SHUTDOWN"));
    if (this.inFlight)
      await settleWithin(this.inFlight, READINESS_CLEANUP_TIMEOUT_MS);
    if (this.draining)
      await settleWithin(this.draining, READINESS_CLEANUP_TIMEOUT_MS);
  }

  private async checkOnce(): Promise<boolean> {
    const controller = new AbortController();
    this.activeAbort = controller;
    let resources: ReadinessResources | undefined;

    try {
      resources = this.resourceFactory.create();
      const work = Promise.all([
        this.probePostgres(resources.postgres, controller.signal),
        this.probeRedis(resources, controller.signal),
        this.probeS3(resources, controller.signal),
      ]);
      void work.catch(() => undefined);
      await rejectAfter(work, READINESS_RESPONSE_TIMEOUT_MS, () => {
        controller.abort(new Error("READINESS_TIMEOUT"));
      });
      return !this.closed;
    } catch {
      return false;
    } finally {
      controller.abort(new Error("READINESS_FINISHED"));
      if (this.activeAbort === controller) this.activeAbort = undefined;
      if (resources) {
        const cleanup = this.closeResources(resources);
        this.draining = cleanup;
        void cleanup.finally(() => {
          if (this.draining === cleanup) this.draining = undefined;
        });
        await settleWithin(cleanup, READINESS_CLEANUP_TIMEOUT_MS);
      }
    }
  }

  private async probePostgres(
    pool: ReadinessResources["postgres"],
    signal: AbortSignal,
  ): Promise<void> {
    let client: ReadinessPostgresClient | undefined;
    let released = false;
    const release = (error?: Error): void => {
      if (!client || released) return;
      released = true;
      client.release(error);
    };
    const abort = (): void => release(new Error("READINESS_ABORTED"));
    signal.addEventListener("abort", abort, { once: true });
    try {
      client = await pool.connect();
      if (signal.aborted) throw signal.reason;
      await client.query("SELECT 1");
    } finally {
      signal.removeEventListener("abort", abort);
      release(signal.aborted ? new Error("READINESS_ABORTED") : undefined);
    }
  }

  private async probeRedis(
    resources: ReadinessResources,
    signal: AbortSignal,
  ): Promise<void> {
    const client = await resources.redis.client;
    if (signal.aborted) throw signal.reason;
    await client.info();
    if (signal.aborted) throw signal.reason;
  }

  private async probeS3(
    resources: ReadinessResources,
    signal: AbortSignal,
  ): Promise<void> {
    await resources.s3.send(
      new HeadBucketCommand({ Bucket: resources.sourceBucket }),
      { abortSignal: signal },
    );
  }

  private async closeResources(resources: ReadinessResources): Promise<void> {
    try {
      resources.s3.destroy();
    } catch {
      // Cleanup must not prevent the remaining readiness clients from closing.
    }
    await Promise.allSettled([
      resources.postgres.end(),
      resources.redis.close(true),
    ]);
  }
}

async function rejectAfter<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onTimeout();
          reject(new Error("READINESS_TIMEOUT"));
        }, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function settleWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      promise.then(
        () => undefined,
        () => undefined,
      ),
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
