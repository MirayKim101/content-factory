import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwitchIngestionService } from "../src/twitch-ingestion/application/twitch-ingestion.service.js";
import { TwitchIngestionController } from "../src/twitch-ingestion/presentation/twitch-ingestion.controller.js";
import {
  TwitchEventConflictError,
  TwitchEventInvalidError,
  TwitchIngestionDisabledError,
  TwitchSignatureInvalidError,
  TwitchVodConflictError,
  TwitchVodProjectNameInvalidError,
} from "../src/twitch-ingestion/domain/twitch-ingestion.js";

const now = new Date("2026-09-27T12:00:00.000Z");
const secret = "test-eventsub-secret";
const body = {
  subscription: { type: "stream.online", version: "1" },
  event: {
    id: "stream-1",
    broadcaster_user_id: "1337",
    broadcaster_user_login: "creator",
    broadcaster_user_name: "Creator",
    started_at: "2026-09-27T11:58:00.000Z",
  },
};
const rawBody = Buffer.from(JSON.stringify(body));

function repository(existingHash?: string) {
  const prisma = {
    twitchIngestChannel: {
      findUnique: vi.fn(async () => ({ id: "channel-1", state: "ENABLED" })),
      findMany: vi.fn(),
      upsert: vi.fn(),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    twitchEventInbox: {
      findUnique: vi.fn(async () =>
        existingHash ? { payloadSha256: existingHash } : null,
      ),
      create: vi.fn(
        async (_input: { data: { payloadSha256: string } }) => undefined,
      ),
    },
    twitchVodCandidate: {
      findMany: vi.fn(async () => []),
      updateMany: vi.fn(async () => ({ count: 1 })),
      findUnique: vi.fn(
        async (): Promise<{
          id: string;
          state: string;
          importedProjectId: string | null;
          ingestIntent?: { id: string; state: string } | null;
        }> => ({
          id: "vod-1",
          state: "IGNORED",
          importedProjectId: null,
        }),
      ),
    },
    twitchVodIngestIntent: {
      findUnique: vi.fn(async () => null),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async (input: { data: Record<string, unknown> }) => ({
        ...input.data,
        state: "QUEUED",
        downloadedBytes: 0n,
        totalBytes: null,
      })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    project: {
      findUnique: vi.fn(async () => ({
        id: "project-1",
        status: "SOURCE_READY",
        source: { status: "READY" },
      })),
    },
  };
  return Object.assign(prisma, {
    $transaction: vi.fn(async (work: (tx: typeof prisma) => unknown) =>
      work(prisma),
    ),
  });
}

function headers(signature = sign(rawBody)) {
  return {
    messageId: "opaque-message-1",
    messageTimestamp: now.toISOString(),
    messageType: "notification",
    signature,
    subscriptionType: "stream.online",
    subscriptionVersion: "1",
  };
}

function sign(bytes: Buffer): string {
  return `sha256=${createHmac("sha256", secret)
    .update("opaque-message-1")
    .update(now.toISOString())
    .update(bytes)
    .digest("hex")}`;
}

describe("TwitchIngestionService", () => {
  const originalEnabled = process.env.TWITCH_INGESTION_ENABLED;
  const originalSecret = process.env.TWITCH_EVENTSUB_SECRET;

  beforeEach(() => {
    process.env.TWITCH_INGESTION_ENABLED = "1";
    process.env.TWITCH_EVENTSUB_SECRET = secret;
  });

  it("admits one idempotent automatic VOD import only when explicitly enabled", async () => {
    const originalAuto = process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
    const prisma = repository();
    prisma.twitchVodCandidate.findUnique.mockResolvedValue({
      id: "00000000-0000-4000-8000-000000000001",
      state: "READY_FOR_INGEST",
      importedProjectId: null,
    });
    const service = new TwitchIngestionService(prisma as never);
    try {
      process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = "1";
      const result = await service.startVodIngest(
        "00000000-0000-4000-8000-000000000001",
        "  Creator stream  ",
        "twitch-import:test-1",
      );
      expect(result).toMatchObject({
        projectName: "Creator stream",
        state: "QUEUED",
        downloadedBytes: "0",
      });
      expect(prisma.twitchVodIngestIntent.create).toHaveBeenCalledOnce();
    } finally {
      if (originalAuto === undefined)
        delete process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
      else process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = originalAuto;
    }
  });
  it("rejects a blank project name before reading or writing ingest state", async () => {
    const originalAuto = process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
    const prisma = repository();
    try {
      process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = "1";
      await expect(
        new TwitchIngestionService(prisma as never).startVodIngest(
          "00000000-0000-4000-8000-000000000001",
          "   ",
          "twitch-import:blank",
        ),
      ).rejects.toBeInstanceOf(TwitchVodProjectNameInvalidError);
      expect(prisma.twitchVodIngestIntent.findUnique).not.toHaveBeenCalled();
      expect(prisma.twitchVodIngestIntent.create).not.toHaveBeenCalled();
    } finally {
      if (originalAuto === undefined)
        delete process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
      else process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = originalAuto;
    }
  });
  it("requeues a terminal VOD import for an explicit operator retry", async () => {
    const originalAuto = process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
    const prisma = repository();
    const failed = {
      id: "00000000-0000-4000-8000-000000000009",
      candidateId: "00000000-0000-4000-8000-000000000001",
      projectName: "Creator stream",
      state: "FAILED_FINAL",
      attemptCount: 3,
      downloadedBytes: 1024n,
      totalBytes: 2048n,
      leaseOwner: null,
      leaseExpiresAt: null,
      candidate: { state: "READY_FOR_INGEST" },
    };
    prisma.twitchVodIngestIntent.findUnique
      .mockResolvedValueOnce(failed as never)
      .mockResolvedValueOnce({
        ...failed,
        state: "QUEUED",
        attemptCount: 0,
      } as never);
    try {
      process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = "1";
      await expect(
        new TwitchIngestionService(prisma as never).retryVodIngest(failed.id),
      ).resolves.toMatchObject({
        state: "QUEUED",
        attemptCount: 0,
        downloadedBytes: "1024",
      });
      expect(prisma.twitchVodIngestIntent.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ state: "FAILED_FINAL" }),
          data: expect.objectContaining({ state: "QUEUED", attemptCount: 0 }),
        }),
      );
    } finally {
      if (originalAuto === undefined)
        delete process.env.TWITCH_VOD_AUTO_INGEST_ENABLED;
      else process.env.TWITCH_VOD_AUTO_INGEST_ENABLED = originalAuto;
    }
  });
  afterEach(() => {
    if (originalEnabled === undefined)
      delete process.env.TWITCH_INGESTION_ENABLED;
    else process.env.TWITCH_INGESTION_ENABLED = originalEnabled;
    if (originalSecret === undefined) delete process.env.TWITCH_EVENTSUB_SECRET;
    else process.env.TWITCH_EVENTSUB_SECRET = originalSecret;
  });

  it("fails before persistence when admission is disabled or HMAC is invalid", async () => {
    const prisma = repository();
    const service = new TwitchIngestionService(prisma as never);
    process.env.TWITCH_INGESTION_ENABLED = "0";
    await expect(
      service.receive(headers(), rawBody, body, now),
    ).rejects.toBeInstanceOf(TwitchIngestionDisabledError);
    process.env.TWITCH_INGESTION_ENABLED = "1";
    await expect(
      service.receive(headers("sha256=invalid"), rawBody, body, now),
    ).rejects.toBeInstanceOf(TwitchSignatureInvalidError);
    expect(prisma.twitchEventInbox.create).not.toHaveBeenCalled();
  });

  it("persists one validated envelope and treats exact replay as duplicate", async () => {
    const prisma = repository();
    const service = new TwitchIngestionService(prisma as never);
    await expect(
      service.receive(headers(), rawBody, body, now),
    ).resolves.toEqual({
      duplicate: false,
      messageId: "opaque-message-1",
    });
    expect(prisma.twitchEventInbox.create).toHaveBeenCalledOnce();

    const hash =
      prisma.twitchEventInbox.create.mock.calls[0]![0].data.payloadSha256;
    const replay = repository(hash);
    await expect(
      new TwitchIngestionService(replay as never).receive(
        headers(),
        rawBody,
        body,
        now,
      ),
    ).resolves.toEqual({ duplicate: true, messageId: "opaque-message-1" });
    expect(replay.twitchEventInbox.create).not.toHaveBeenCalled();
  });

  it("rejects a reused message id with different raw bytes", async () => {
    const prisma = repository("0".repeat(64));
    await expect(
      new TwitchIngestionService(prisma as never).receive(
        headers(),
        rawBody,
        body,
        now,
      ),
    ).rejects.toBeInstanceOf(TwitchEventConflictError);
  });

  it("rejects unsigned subscription headers that disagree with the signed body", async () => {
    const prisma = repository();
    await expect(
      new TwitchIngestionService(prisma as never).receive(
        { ...headers(), subscriptionType: "stream.offline" },
        rawBody,
        body,
        now,
      ),
    ).rejects.toBeInstanceOf(TwitchEventInvalidError);
    expect(prisma.twitchEventInbox.create).not.toHaveBeenCalled();
  });

  it("accepts a signed revocation as a durable audit record", async () => {
    const revocationBody = {
      subscription: {
        id: "subscription-1",
        status: "notification_failures_exceeded",
        type: "stream.offline",
        version: "1",
        condition: { broadcaster_user_id: "1337" },
      },
    };
    const bytes = Buffer.from(JSON.stringify(revocationBody));
    const prisma = repository();

    await expect(
      new TwitchIngestionService(prisma as never).receive(
        {
          ...headers(sign(bytes)),
          messageType: "revocation",
          subscriptionType: "stream.offline",
        },
        bytes,
        revocationBody,
        now,
      ),
    ).resolves.toEqual({
      duplicate: false,
      messageId: "opaque-message-1",
    });
    expect(prisma.twitchEventInbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        state: "REJECTED",
        failureCode: "TWITCH_SUBSCRIPTION_REVOKED",
        subscriptionType: "stream.offline",
        streamId: null,
        processedAt: now,
      }),
    });
  });

  it("acknowledges a signed revocation for an already revoked channel", async () => {
    const revocationBody = {
      subscription: {
        status: "authorization_revoked",
        type: "stream.online",
        version: "1",
        condition: { broadcaster_user_id: "1337" },
      },
    };
    const bytes = Buffer.from(JSON.stringify(revocationBody));
    const prisma = repository();
    prisma.twitchIngestChannel.findUnique.mockResolvedValue({
      id: "channel-1",
      state: "REVOKED",
    });

    await expect(
      new TwitchIngestionService(prisma as never).receive(
        {
          ...headers(sign(bytes)),
          messageType: "revocation",
          subscriptionType: "stream.online",
        },
        bytes,
        revocationBody,
        now,
      ),
    ).resolves.toEqual({
      duplicate: false,
      messageId: "opaque-message-1",
    });
    expect(prisma.twitchEventInbox.create).toHaveBeenCalledOnce();
  });

  it("revokes admission without deleting channel history", async () => {
    const prisma = repository();
    prisma.twitchIngestChannel.findUnique.mockResolvedValue({
      id: "channel-1",
      state: "REVOKED",
    });
    const service = new TwitchIngestionService(prisma as never);

    await expect(service.revokeChannel("channel-1")).resolves.toEqual({
      id: "channel-1",
      state: "REVOKED",
    });
    expect(prisma.twitchIngestChannel.updateMany).toHaveBeenCalledWith({
      where: { id: "channel-1", state: "ENABLED" },
      data: { state: "REVOKED" },
    });
  });

  it("exposes a bounded operational VOD queue with channel context", async () => {
    const prisma = repository();
    const service = new TwitchIngestionService(prisma as never);
    await expect(service.listVodCandidates()).resolves.toEqual([]);
    expect(prisma.twitchVodCandidate.findMany).toHaveBeenCalledWith({
      include: {
        channel: {
          select: {
            broadcasterLogin: true,
            broadcasterDisplayName: true,
          },
        },
        ingestIntent: true,
      },
      orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
      take: 200,
    });
  });

  it("ignores a pending VOD without deleting its history", async () => {
    const prisma = repository();
    const service = new TwitchIngestionService(prisma as never);
    await expect(service.ignoreVodCandidate("vod-1")).resolves.toEqual({
      id: "vod-1",
      state: "IGNORED",
      importedProjectId: null,
    });
    expect(prisma.twitchVodCandidate.updateMany).toHaveBeenCalledWith({
      where: {
        id: "vod-1",
        state: { in: ["WAITING_DELAY", "READY_FOR_INGEST"] },
      },
      data: { state: "IGNORED" },
    });
  });

  it("refuses to ignore a VOD while its media lease is active", async () => {
    const prisma = repository();
    prisma.twitchVodCandidate.findUnique.mockResolvedValueOnce({
      id: "vod-1",
      state: "READY_FOR_INGEST",
      importedProjectId: null,
      ingestIntent: {
        id: "intent-1",
        state: "DOWNLOADING",
      },
    });
    prisma.twitchVodIngestIntent.updateMany.mockResolvedValueOnce({ count: 0 });
    const service = new TwitchIngestionService(prisma as never);

    await expect(service.ignoreVodCandidate("vod-1")).rejects.toBeInstanceOf(
      TwitchVodConflictError,
    );
    expect(prisma.twitchVodCandidate.updateMany).not.toHaveBeenCalled();
  });

  it("links a ready VOD to an existing source-ready project", async () => {
    const prisma = repository();
    prisma.twitchVodCandidate.findUnique
      .mockResolvedValueOnce({
        id: "vod-1",
        state: "READY_FOR_INGEST",
        importedProjectId: null,
      })
      .mockResolvedValueOnce({
        id: "vod-1",
        state: "IMPORTED",
        importedProjectId: "project-1",
      });
    const service = new TwitchIngestionService(prisma as never);
    await expect(
      service.linkVodCandidateToProject("vod-1", "project-1", true),
    ).resolves.toEqual({
      id: "vod-1",
      state: "IMPORTED",
      importedProjectId: "project-1",
    });
    expect(prisma.twitchVodCandidate.updateMany).toHaveBeenCalledWith({
      where: {
        id: "vod-1",
        state: "READY_FOR_INGEST",
        importedProjectId: null,
      },
      data: { state: "IMPORTED", importedProjectId: "project-1" },
    });
  });

  it("returns a domain conflict when a project is already linked elsewhere", async () => {
    const prisma = repository();
    prisma.twitchVodCandidate.findUnique.mockResolvedValueOnce({
      id: "vod-1",
      state: "READY_FOR_INGEST",
      importedProjectId: null,
    });
    prisma.$transaction.mockRejectedValueOnce({ code: "P2002" });
    const service = new TwitchIngestionService(prisma as never);

    await expect(
      service.linkVodCandidateToProject("vod-1", "project-1", true),
    ).rejects.toBeInstanceOf(TwitchVodConflictError);
  });

  it("rejects a VOD link without exact-source confirmation", async () => {
    const prisma = repository();

    await expect(
      new TwitchIngestionService(prisma as never).linkVodCandidateToProject(
        "vod-1",
        "project-1",
        false,
      ),
    ).rejects.toBeInstanceOf(TwitchVodConflictError);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe("TwitchIngestionController", () => {
  it("overrides the default accepted status with 200 for a verification challenge", async () => {
    const service = {
      receive: vi.fn(async () => ({ challenge: "raw-challenge" })),
    };
    const response = { status: vi.fn() };

    await expect(
      new TwitchIngestionController(service as never).event(
        { rawBody: Buffer.from("{}") },
        response,
        {},
        "message-id",
        now.toISOString(),
        "webhook_callback_verification",
        "signature",
        "stream.online",
        "1",
      ),
    ).resolves.toBe("raw-challenge");
    expect(response.status).toHaveBeenCalledWith(200);
  });
});
