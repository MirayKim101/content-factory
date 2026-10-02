import { describe, expect, it, vi } from "vitest";

import type { ClipGenerationProvider } from "../src/application/clip-generation-provider.port.js";
import { PgClipGenerationWorker } from "../src/infrastructure/pg-clip-generation-worker.js";

describe("PgClipGenerationWorker", () => {
  it("aborts provider I/O and releases the lease without spending retry budget on shutdown", async () => {
    let providerSignal: AbortSignal | undefined;
    const provider: ClipGenerationProvider = {
      provider: "TEST",
      generate: vi.fn(
        async (_request, signal) =>
          new Promise<never>((_resolve, reject) => {
            providerSignal = signal;
            signal?.addEventListener("abort", () => reject(signal.reason), {
              once: true,
            });
          }),
      ),
    };
    const clientQuery = vi.fn(async (sql: string) => {
      if (sql.includes('SELECT i.* FROM "ClipGenerationIntent"'))
        return {
          rowCount: 1,
          rows: [
            {
              id: "00000000-0000-4000-8000-000000000001",
              state: "QUEUED",
              leaseExpiresAt: null,
              attemptCount: 0,
              sourceTitle: "Test stream",
              sourceDurationMs: 120_000,
              transcript: [
                { startMs: 0, endMs: 120_000, text: "Complete moment" },
              ],
              language: "en",
              maximumSuggestions: 2,
              minimumClipDurationMs: 10_000,
              maximumClipDurationMs: 60_000,
            },
          ],
        };
      if (sql.includes('JOIN "Project"'))
        return { rowCount: 1, rows: [{ id: "source-current" }] };
      return { rowCount: 1, rows: [] };
    });
    const client = { query: clientQuery, release: vi.fn() };
    const poolQuery = vi.fn(async (_sql: string, _values?: unknown[]) => ({
      rowCount: 1,
      rows: [],
    }));
    const pool = {
      connect: vi.fn(async () => client),
      query: poolQuery,
      end: vi.fn(async () => undefined),
    };
    const worker = new PgClipGenerationWorker(
      "postgresql://unused",
      provider,
      30_000,
    );
    Object.assign(worker as unknown as { pool: unknown }, { pool });

    const processing = worker.process("00000000-0000-4000-8000-000000000001");
    await vi.waitFor(() => expect(provider.generate).toHaveBeenCalledOnce());
    worker.abortAll();

    await expect(processing).resolves.toBeUndefined();
    expect(providerSignal?.aborted).toBe(true);
    expect(poolQuery).toHaveBeenCalledOnce();
    expect(String(poolQuery.mock.calls[0]?.[0])).toContain(
      '"attemptCount"=GREATEST("attemptCount"-1,0)',
    );
    expect(client.release).toHaveBeenCalledOnce();
  });
});
