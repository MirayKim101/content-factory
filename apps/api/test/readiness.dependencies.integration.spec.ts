import { createServer, type Socket } from "node:net";

import { Pool } from "pg";
import { describe, expect, it } from "vitest";

import { databaseUrl, loadEnvironment } from "../src/config/environment.js";
import {
  ReadinessResourceFactory,
  readinessPostgresPoolConfig,
} from "../src/readiness/readiness.resources.js";
import { ReadinessService } from "../src/readiness/readiness.service.js";

loadEnvironment();

// Only SELECT 1 / SHOW, Redis INFO and S3 HeadBucket reach the configured
// Content Factory services. Dependency loss uses an owned loopback blackhole;
// working containers, database rows, objects and queues are never changed.
async function blackhole(): Promise<{
  port: number;
  close(): Promise<void>;
}> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.resume();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string" || address.port === 3000) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("READINESS_FIXTURE_PORT_INVALID");
  }
  return {
    port: address.port,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}

describe("readiness against real configured PostgreSQL, Redis and S3", () => {
  it("enforces read-only PostgreSQL connections at the server", async () => {
    const pool = new Pool(readinessPostgresPoolConfig(databaseUrl()));
    try {
      const result = await pool.query<{
        default_transaction_read_only: string;
      }>("SHOW default_transaction_read_only");
      expect(result.rows[0]?.default_transaction_read_only).toBe("on");
    } finally {
      await pool.end();
    }
  });

  for (const dependency of ["postgres", "redis", "s3"] as const) {
    it(`bounds a blackholed ${dependency} probe and recovers without service changes`, async () => {
      const fixture = await blackhole();
      const service = new ReadinessService(new ReadinessResourceFactory());
      const variable =
        dependency === "postgres"
          ? "POSTGRES_PORT"
          : dependency === "redis"
            ? "REDIS_PORT"
            : "S3_ENDPOINT";
      const previous = process.env[variable];
      try {
        await expect(service.isReady()).resolves.toBe(true);
        process.env[variable] =
          dependency === "s3"
            ? `http://127.0.0.1:${fixture.port}`
            : String(fixture.port);
        const started = performance.now();
        await expect(service.isReady()).resolves.toBe(false);
        expect(performance.now() - started).toBeLessThan(2_000);
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        await expect(service.isReady()).resolves.toBe(true);
      } finally {
        if (previous === undefined) delete process.env[variable];
        else process.env[variable] = previous;
        await service.onModuleDestroy();
        await fixture.close();
      }
    }, 8_000);
  }
});
