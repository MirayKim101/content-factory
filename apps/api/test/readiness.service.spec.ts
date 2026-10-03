import { createServer } from "node:net";

import { describe, expect, it } from "vitest";

import {
  createReadinessRedisConnection,
  type ReadinessPostgresClient,
  type ReadinessResourceFactoryPort,
  type ReadinessResources,
} from "../src/readiness/readiness.resources.js";
import { ReadinessService } from "../src/readiness/readiness.service.js";

class Deferred<T> {
  readonly promise: Promise<T>;
  private resolvePromise: ((value: T) => void) | undefined;

  constructor() {
    this.promise = new Promise<T>((resolve) => {
      this.resolvePromise = resolve;
    });
  }

  resolve(value: T): void {
    if (!this.resolvePromise) throw new Error("DEFERRED_ALREADY_RESOLVED");
    this.resolvePromise(value);
    this.resolvePromise = undefined;
  }
}

class FixtureFactory implements ReadinessResourceFactoryPort {
  calls = 0;

  constructor(private readonly resources: () => ReadinessResources) {}

  create(): ReadinessResources {
    this.calls += 1;
    return this.resources();
  }
}

function readyResources(): {
  resources: ReadinessResources;
  state: {
    queries: number;
    infos: number;
    heads: number;
    postgresEnds: number;
    redisCloses: number;
    s3Destroys: number;
  };
} {
  const state = {
    queries: 0,
    infos: 0,
    heads: 0,
    postgresEnds: 0,
    redisCloses: 0,
    s3Destroys: 0,
  };
  const client: ReadinessPostgresClient = {
    async query() {
      state.queries += 1;
    },
    release() {},
  };
  return {
    resources: {
      postgres: {
        async connect() {
          return client;
        },
        async end() {
          state.postgresEnds += 1;
        },
      },
      redis: {
        client: Promise.resolve({
          async info() {
            state.infos += 1;
            return "# Server";
          },
        }),
        async close() {
          state.redisCloses += 1;
        },
      },
      s3: {
        async send() {
          state.heads += 1;
        },
        destroy() {
          state.s3Destroys += 1;
        },
      },
      sourceBucket: "content-factory-readiness-test",
    },
    state,
  };
}

async function unusedLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
    throw new Error("READINESS_TEST_PORT_UNAVAILABLE");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (address.port === 3000) return unusedLoopbackPort();
  return address.port;
}

describe("ReadinessService", () => {
  it("returns a boolean unavailable result if resource creation fails", async () => {
    const service = new ReadinessService(
      new FixtureFactory(() => {
        throw new Error("READINESS_FACTORY_FAILED");
      }),
    );
    await expect(service.isReady()).resolves.toBe(false);
  });

  it("coalesces a healthy generation while its clients are closing", async () => {
    const close = new Deferred<void>();
    const fixture = readyResources();
    fixture.resources.postgres.end = () => close.promise;
    const factory = new FixtureFactory(() => fixture.resources);
    const service = new ReadinessService(factory);
    const first = service.isReady();
    await new Promise((resolve) => setImmediate(resolve));
    const second = service.isReady();
    expect(second).toBe(first);
    close.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(factory.calls).toBe(1);
  });

  it("does not report ready if shutdown begins during successful cleanup", async () => {
    const close = new Deferred<void>();
    const fixture = readyResources();
    fixture.resources.postgres.end = () => close.promise;
    const service = new ReadinessService(
      new FixtureFactory(() => fixture.resources),
    );
    const inFlight = service.isReady();
    await new Promise((resolve) => setImmediate(resolve));
    await service.onModuleDestroy();
    await expect(inFlight).resolves.toBe(false);
    await expect(service.isReady()).resolves.toBe(false);
    close.resolve();
  });

  it("runs the three read-only probes once and closes their dedicated clients", async () => {
    const fixture = readyResources();
    const service = new ReadinessService(
      new FixtureFactory(() => fixture.resources),
    );

    await expect(service.isReady()).resolves.toBe(true);
    expect(fixture.state).toEqual({
      queries: 1,
      infos: 1,
      heads: 1,
      postgresEnds: 1,
      redisCloses: 1,
      s3Destroys: 1,
    });
  });

  it("coalesces concurrent requests into one probe generation", async () => {
    const query = new Deferred<void>();
    const fixture = readyResources();
    fixture.resources.postgres = {
      async connect() {
        return {
          query: () => query.promise,
          release() {},
        };
      },
      async end() {
        fixture.state.postgresEnds += 1;
      },
    };
    const factory = new FixtureFactory(() => fixture.resources);
    const service = new ReadinessService(factory);

    const first = service.isReady();
    const second = service.isReady();
    expect(factory.calls).toBe(1);
    query.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(fixture.state).toMatchObject({ queries: 0, infos: 1, heads: 1 });
  });

  it("returns unavailable and tears down all resources when one probe fails", async () => {
    const fixture = readyResources();
    fixture.resources.redis = {
      client: Promise.resolve({
        async info() {
          throw new Error("REDIS_UNAVAILABLE");
        },
      }),
      async close() {
        fixture.state.redisCloses += 1;
      },
    };
    const service = new ReadinessService(
      new FixtureFactory(() => fixture.resources),
    );

    await expect(service.isReady()).resolves.toBe(false);
    expect(fixture.state).toMatchObject({
      postgresEnds: 1,
      redisCloses: 1,
      s3Destroys: 1,
    });
  });

  it("recovers after an actual refused Redis connection without an unhandled error", async () => {
    const refusedPort = await unusedLoopbackPort();
    const refused = readyResources();
    refused.resources.redis = createReadinessRedisConnection({
      host: "127.0.0.1",
      port: refusedPort,
      password: "readiness-test",
    });
    const recovered = readyResources();
    let generation = 0;
    const service = new ReadinessService(
      new FixtureFactory(() => {
        generation += 1;
        return generation === 1 ? refused.resources : recovered.resources;
      }),
    );

    await expect(service.isReady()).resolves.toBe(false);
    await expect(service.isReady()).resolves.toBe(true);
  }, 4_000);

  it("does not start another generation while a timed-out generation drains", async () => {
    const query = new Deferred<void>();
    const close = new Deferred<void>();
    const fixture = readyResources();
    let releases = 0;
    fixture.resources.postgres = {
      async connect() {
        return {
          query: () => query.promise,
          release(error?: Error) {
            releases += 1;
            if (error) query.resolve();
          },
        };
      },
      end: () => close.promise,
    };
    const factory = new FixtureFactory(() => fixture.resources);
    const service = new ReadinessService(factory);
    const startedAt = Date.now();

    await expect(service.isReady()).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    await expect(service.isReady()).resolves.toBe(false);
    expect(factory.calls).toBe(1);
    expect(releases).toBeGreaterThan(0);

    close.resolve();
    await new Promise((resolve) => setImmediate(resolve));
  }, 4_000);

  it("becomes unready and closes active probe resources during shutdown", async () => {
    const query = new Deferred<void>();
    const fixture = readyResources();
    fixture.resources.postgres = {
      async connect() {
        return {
          query: () => query.promise,
          release(error?: Error) {
            if (error) query.resolve();
          },
        };
      },
      async end() {
        fixture.state.postgresEnds += 1;
      },
    };
    const service = new ReadinessService(
      new FixtureFactory(() => fixture.resources),
    );

    const inFlight = service.isReady();
    await new Promise((resolve) => setImmediate(resolve));
    await service.onModuleDestroy();

    await expect(inFlight).resolves.toBe(false);
    await expect(service.isReady()).resolves.toBe(false);
    expect(fixture.state).toMatchObject({
      postgresEnds: 1,
      redisCloses: 1,
      s3Destroys: 1,
    });
  });
});
