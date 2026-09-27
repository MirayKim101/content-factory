import { createHmac } from "node:crypto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TwitchIngestionService } from "../src/twitch-ingestion/application/twitch-ingestion.service.js";
import { TwitchIngestionController } from "../src/twitch-ingestion/presentation/twitch-ingestion.controller.js";
import {
  TwitchEventConflictError,
  TwitchIngestionDisabledError,
  TwitchSignatureInvalidError,
  TwitchVodConflictError,
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
      findUnique: vi.fn(async () => ({
        id: "vod-1",
        state: "IGNORED",
        importedProjectId: null as string | null,
      })),
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
      service.linkVodCandidateToProject("vod-1", "project-1"),
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
      service.linkVodCandidateToProject("vod-1", "project-1"),
    ).rejects.toBeInstanceOf(TwitchVodConflictError);
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
