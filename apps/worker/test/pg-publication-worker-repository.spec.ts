import { describe, expect, it, vi } from "vitest";
import type { Pool } from "pg";

import { PgPublicationWorkerRepository } from "../src/infrastructure/pg-publication-worker.repository.js";

describe("PgPublicationWorkerRepository stale external recovery", () => {
  it("quarantines an expired external attempt without a durable provider session", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            platform: "TIKTOK",
            state: "PROCESSING",
            startedAt: new Date("2026-09-28T00:00:00.000Z"),
            attemptCount: 1,
            providerSessionExists: false,
          },
        ],
      })
      .mockResolvedValueOnce({ rowCount: 1 })
      .mockResolvedValueOnce({});
    const release = vi.fn();
    const pool = {
      connect: vi.fn().mockResolvedValue({ query, release }),
    } as unknown as Pool;
    const repository = new PgPublicationWorkerRepository(
      "postgresql://unused",
      pool,
    );

    await expect(
      repository.claim(
        "00000000-0000-4000-8000-000000000001",
        new Date("2026-09-28T00:10:00.000Z"),
      ),
    ).resolves.toBeNull();

    expect(String(query.mock.calls[1]![0])).toContain(
      `i."platform" = 'LOCAL_DRY_RUN'`,
    );
    expect(String(query.mock.calls[2]![0])).toContain(
      "PUBLICATION_STALE_PROCESSING_OUTCOME_UNKNOWN",
    );
    expect(String(query.mock.calls[2]![0])).toContain(
      "stale_processing_without_session",
    );
    expect(query.mock.calls[3]![0]).toBe("COMMIT");
    expect(release).toHaveBeenCalledOnce();
  });
});
