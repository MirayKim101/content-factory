import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import {
  parseTwitchEventEnvelope,
  TWITCH_EVENT_MAX_AGE_MS,
  type TwitchEventEnvelopeV1,
} from "@content-factory/contracts";
import { Injectable } from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";
import { PrismaService } from "../../database/prisma.service.js";
import {
  TwitchChannelNotAllowedError,
  TwitchEventConflictError,
  TwitchEventInvalidError,
  TwitchIngestionDisabledError,
  TwitchSignatureInvalidError,
  TwitchVodConflictError,
  TwitchVodAutoIngestDisabledError,
  TwitchVodIdempotencyConflictError,
  TwitchVodProjectNameInvalidError,
} from "../domain/twitch-ingestion.js";

interface TwitchHeaders {
  messageId: string | undefined;
  messageTimestamp: string | undefined;
  messageType: string | undefined;
  signature: string | undefined;
  subscriptionType: string | undefined;
  subscriptionVersion: string | undefined;
}

@Injectable()
export class TwitchIngestionService {
  constructor(private readonly prisma: PrismaService) {}

  capabilities() {
    const config = apiEnvironment();
    return {
      ingestionEnabled: config.twitchIngestionEnabled,
      autoIngestEnabled:
        config.twitchIngestionEnabled && config.twitchVodAutoIngestEnabled,
    };
  }

  listChannels() {
    return this.prisma.twitchIngestChannel.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  async listVodCandidates() {
    const candidates = await this.prisma.twitchVodCandidate.findMany({
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
    return candidates.map((candidate) => ({
      ...candidate,
      ingestIntent: candidate.ingestIntent
        ? this.serializeIngestIntent(candidate.ingestIntent)
        : null,
    }));
  }

  async startVodIngest(
    id: string,
    projectName: string,
    idempotencyKey: string,
  ) {
    const config = apiEnvironment();
    if (!config.twitchIngestionEnabled || !config.twitchVodAutoIngestEnabled)
      throw new TwitchVodAutoIngestDisabledError();
    const normalizedName = projectName.trim();
    if (!normalizedName || normalizedName.length > 160)
      throw new TwitchVodProjectNameInvalidError();
    const requestFingerprint = createHash("sha256")
      .update(JSON.stringify({ candidateId: id, projectName: normalizedName }))
      .digest("hex");
    const existing = await this.prisma.twitchVodIngestIntent.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      if (existing.requestFingerprint !== requestFingerprint)
        throw new TwitchVodIdempotencyConflictError();
      return this.serializeIngestIntent(existing);
    }
    try {
      const created = await this.prisma.$transaction(
        async (tx) => {
          const candidate = await tx.twitchVodCandidate.findUnique({
            where: { id },
            select: {
              id: true,
              state: true,
              importedProjectId: true,
              channel: { select: { state: true } },
            },
          });
          if (!candidate) return null;
          if (
            candidate.state !== "READY_FOR_INGEST" ||
            candidate.importedProjectId ||
            candidate.channel.state !== "ENABLED"
          )
            throw new TwitchVodConflictError();
          return tx.twitchVodIngestIntent.create({
            data: {
              id: randomUUID(),
              idempotencyKey,
              requestFingerprint,
              candidateId: id,
              projectName: normalizedName,
            },
          });
        },
        { isolationLevel: "Serializable" },
      );
      return created ? this.serializeIngestIntent(created) : null;
    } catch (error) {
      if (this.isSerializationConflict(error))
        throw new TwitchVodConflictError();
      if (!this.isUniqueConflict(error)) throw error;
      const raced = await this.prisma.twitchVodIngestIntent.findFirst({
        where: { OR: [{ idempotencyKey }, { candidateId: id }] },
      });
      if (raced?.requestFingerprint === requestFingerprint)
        return this.serializeIngestIntent(raced);
      throw new TwitchVodIdempotencyConflictError();
    }
  }

  async retryVodIngest(id: string) {
    const config = apiEnvironment();
    if (!config.twitchIngestionEnabled || !config.twitchVodAutoIngestEnabled)
      throw new TwitchVodAutoIngestDisabledError();
    const current = await this.prisma.twitchVodIngestIntent.findUnique({
      where: { id },
      include: {
        candidate: {
          select: {
            state: true,
            channel: { select: { state: true } },
          },
        },
      },
    });
    if (!current) return null;
    if (current.state === "QUEUED" || current.state === "RETRY_WAIT")
      return this.serializeIngestIntent(current);
    if (
      current.state !== "FAILED_FINAL" ||
      current.candidate.state !== "READY_FOR_INGEST" ||
      current.candidate.channel.state !== "ENABLED"
    )
      throw new TwitchVodConflictError();
    const reset = await this.prisma.twitchVodIngestIntent.updateMany({
      where: {
        id,
        state: "FAILED_FINAL",
        leaseOwner: null,
        leaseExpiresAt: null,
        candidate: {
          state: "READY_FOR_INGEST",
          importedProjectId: null,
          channel: { state: "ENABLED" },
        },
      },
      data: {
        state: "QUEUED",
        attemptCount: 0,
        nextAttemptAt: null,
        failureCode: null,
        failureMessage: null,
      },
    });
    if (reset.count !== 1) throw new TwitchVodConflictError();
    const retried = await this.prisma.twitchVodIngestIntent.findUnique({
      where: { id },
    });
    if (!retried) throw new TwitchVodConflictError();
    return this.serializeIngestIntent(retried);
  }

  async getVodIngest(id: string) {
    const intent = await this.prisma.twitchVodIngestIntent.findUnique({
      where: { id },
    });
    return intent ? this.serializeIngestIntent(intent) : null;
  }

  private serializeIngestIntent<
    T extends {
      downloadedBytes: bigint;
      totalBytes: bigint | null;
    },
  >(intent: T) {
    return {
      ...intent,
      downloadedBytes: intent.downloadedBytes.toString(),
      totalBytes: intent.totalBytes?.toString() ?? null,
    };
  }

  async ignoreVodCandidate(id: string) {
    const updated = await this.prisma.$transaction(async (tx) => {
      const current = await tx.twitchVodCandidate.findUnique({
        where: { id },
        include: { ingestIntent: true },
      });
      if (!current) return { count: 0 };
      const intent = current.ingestIntent;
      if (intent && intent.state !== "CANCELED") {
        const canceled = await tx.twitchVodIngestIntent.updateMany({
          where: {
            id: intent.id,
            state: { in: ["QUEUED", "RETRY_WAIT", "FAILED_FINAL"] },
            leaseOwner: null,
            leaseExpiresAt: null,
          },
          data: {
            state: "CANCELED",
            nextAttemptAt: null,
            failureCode: null,
            failureMessage: null,
          },
        });
        if (canceled.count !== 1) throw new TwitchVodConflictError();
      }
      return tx.twitchVodCandidate.updateMany({
        where: { id, state: { in: ["WAITING_DELAY", "READY_FOR_INGEST"] } },
        data: { state: "IGNORED" },
      });
    });
    const candidate = await this.prisma.twitchVodCandidate.findUnique({
      where: { id },
      include: {
        channel: {
          select: {
            broadcasterLogin: true,
            broadcasterDisplayName: true,
          },
        },
      },
    });
    if (candidate && updated.count === 0 && candidate.state !== "IGNORED")
      throw new TwitchVodConflictError();
    return candidate;
  }

  async linkVodCandidateToProject(
    id: string,
    projectId: string,
    sourceMatchConfirmed: boolean,
  ) {
    if (!sourceMatchConfirmed) throw new TwitchVodConflictError();
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [candidate, project] = await Promise.all([
          tx.twitchVodCandidate.findUnique({ where: { id } }),
          tx.project.findUnique({
            where: { id: projectId },
            include: { source: { select: { status: true } } },
          }),
        ]);
        if (!candidate) return null;
        if (
          candidate.state === "IMPORTED" &&
          candidate.importedProjectId === projectId
        )
          return tx.twitchVodCandidate.findUnique({
            where: { id },
            include: {
              channel: {
                select: {
                  broadcasterLogin: true,
                  broadcasterDisplayName: true,
                },
              },
            },
          });
        if (
          candidate.state !== "READY_FOR_INGEST" ||
          candidate.importedProjectId ||
          !project ||
          project.status !== "SOURCE_READY" ||
          project.source?.status !== "READY"
        )
          throw new TwitchVodConflictError();
        const linked = await tx.twitchVodCandidate.updateMany({
          where: { id, state: "READY_FOR_INGEST", importedProjectId: null },
          data: { state: "IMPORTED", importedProjectId: projectId },
        });
        if (linked.count !== 1) throw new TwitchVodConflictError();
        return tx.twitchVodCandidate.findUnique({
          where: { id },
          include: {
            channel: {
              select: {
                broadcasterLogin: true,
                broadcasterDisplayName: true,
              },
            },
          },
        });
      });
    } catch (error) {
      if (this.isUniqueConflict(error)) throw new TwitchVodConflictError();
      throw error;
    }
  }

  createChannel(input: {
    broadcasterId: string;
    broadcasterLogin: string;
    broadcasterDisplayName: string;
    ingestDelaySeconds: number;
  }) {
    return this.prisma.twitchIngestChannel.upsert({
      where: { broadcasterId: input.broadcasterId },
      create: { id: randomUUID(), ...input },
      update: {
        broadcasterLogin: input.broadcasterLogin,
        broadcasterDisplayName: input.broadcasterDisplayName,
        ingestDelaySeconds: input.ingestDelaySeconds,
        state: "ENABLED",
      },
    });
  }

  async revokeChannel(id: string) {
    const updated = await this.prisma.twitchIngestChannel.updateMany({
      where: { id, state: "ENABLED" },
      data: { state: "REVOKED" },
    });
    if (updated.count === 0)
      return this.prisma.twitchIngestChannel.findUnique({ where: { id } });
    return this.prisma.twitchIngestChannel.findUnique({ where: { id } });
  }

  async receive(
    headers: TwitchHeaders,
    rawBody: Buffer | undefined,
    body: unknown,
    now = new Date(),
  ): Promise<{ challenge?: string; duplicate?: boolean; messageId?: string }> {
    const config = apiEnvironment();
    if (!config.twitchIngestionEnabled || !config.twitchEventSubSecret)
      throw new TwitchIngestionDisabledError();
    if (
      !rawBody ||
      !this.validSignature(headers, rawBody, config.twitchEventSubSecret)
    )
      throw new TwitchSignatureInvalidError();
    if (headers.messageId) {
      const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
      const existing = await this.prisma.twitchEventInbox.findUnique({
        where: { messageId: headers.messageId },
        select: { payloadSha256: true },
      });
      if (existing) {
        if (existing.payloadSha256 !== payloadSha256)
          throw new TwitchEventConflictError();
        return { duplicate: true, messageId: headers.messageId };
      }
    }
    this.requireFreshTimestamp(headers.messageTimestamp, now);
    if (headers.messageType === "webhook_callback_verification") {
      const challenge = this.challenge(body, headers);
      await this.requireChannel(challenge.broadcasterId);
      return { challenge: challenge.value };
    }
    if (headers.messageType === "revocation")
      return this.receiveRevocation(headers, rawBody, body, now);
    if (headers.messageType !== "notification")
      throw new TwitchEventInvalidError();
    let envelope: TwitchEventEnvelopeV1;
    try {
      envelope = parseTwitchEventEnvelope(this.toEnvelope(body, headers), now);
    } catch {
      throw new TwitchEventInvalidError();
    }
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const existing = await this.prisma.twitchEventInbox.findUnique({
      where: { messageId: envelope.messageId },
      select: { payloadSha256: true },
    });
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256)
        throw new TwitchEventConflictError();
      return { duplicate: true, messageId: envelope.messageId };
    }
    const channel = await this.requireChannel(envelope.event.broadcasterUserId);
    try {
      await this.prisma.twitchEventInbox.create({
        data: {
          id: randomUUID(),
          messageId: envelope.messageId,
          channelId: channel.id,
          subscriptionType: envelope.subscriptionType,
          subscriptionVersion: envelope.subscriptionVersion,
          streamId: envelope.event.id,
          messageTimestamp: new Date(envelope.messageTimestamp),
          payloadSha256,
          payload: envelope as never,
        },
      });
    } catch (error) {
      if (!this.isUniqueConflict(error)) throw error;
      const raced = await this.prisma.twitchEventInbox.findUnique({
        where: { messageId: envelope.messageId },
        select: { payloadSha256: true },
      });
      if (raced?.payloadSha256 !== payloadSha256)
        throw new TwitchEventConflictError();
      return { duplicate: true, messageId: envelope.messageId };
    }
    return { duplicate: false, messageId: envelope.messageId };
  }

  private async receiveRevocation(
    headers: TwitchHeaders,
    rawBody: Buffer,
    body: unknown,
    now: Date,
  ): Promise<{ duplicate: boolean; messageId: string }> {
    const payload = body as {
      subscription?: {
        status?: unknown;
        type?: unknown;
        version?: unknown;
        condition?: { broadcaster_user_id?: unknown };
      };
    };
    const subscription = payload.subscription;
    const broadcasterId = subscription?.condition?.broadcaster_user_id;
    const { type, version } = this.subscriptionIdentity(
      subscription,
      headers,
    );
    if (
      !headers.messageId ||
      typeof broadcasterId !== "string" ||
      !/^\d{1,64}$/.test(broadcasterId) ||
      (type !== "stream.online" && type !== "stream.offline") ||
      version !== "1" ||
      typeof subscription?.status !== "string" ||
      !/^[a-z_]{1,64}$/.test(subscription.status)
    )
      throw new TwitchEventInvalidError();
    const channel = await this.requireKnownChannel(broadcasterId);
    const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
    const existing = await this.prisma.twitchEventInbox.findUnique({
      where: { messageId: headers.messageId },
      select: { payloadSha256: true },
    });
    if (existing) {
      if (existing.payloadSha256 !== payloadSha256)
        throw new TwitchEventConflictError();
      return { duplicate: true, messageId: headers.messageId };
    }
    try {
      await this.prisma.twitchEventInbox.create({
        data: {
          id: randomUUID(),
          messageId: headers.messageId,
          channelId: channel.id,
          subscriptionType: type,
          subscriptionVersion: version,
          streamId: null,
          messageTimestamp: new Date(headers.messageTimestamp as string),
          payloadSha256,
          payload: body as never,
          state: "REJECTED",
          failureCode: "TWITCH_SUBSCRIPTION_REVOKED",
          failureMessage: "Twitch revoked the EventSub subscription.",
          processedAt: now,
        },
      });
    } catch (error) {
      if (!this.isUniqueConflict(error)) throw error;
      const raced = await this.prisma.twitchEventInbox.findUnique({
        where: { messageId: headers.messageId },
        select: { payloadSha256: true },
      });
      if (raced?.payloadSha256 !== payloadSha256)
        throw new TwitchEventConflictError();
      return { duplicate: true, messageId: headers.messageId };
    }
    return { duplicate: false, messageId: headers.messageId };
  }

  private async requireChannel(broadcasterId: string) {
    const channel = await this.requireKnownChannel(broadcasterId);
    if (channel.state !== "ENABLED") throw new TwitchChannelNotAllowedError();
    return channel;
  }

  private async requireKnownChannel(broadcasterId: string) {
    const channel = await this.prisma.twitchIngestChannel.findUnique({
      where: { broadcasterId },
    });
    if (!channel) throw new TwitchChannelNotAllowedError();
    return channel;
  }

  private validSignature(headers: TwitchHeaders, body: Buffer, secret: string) {
    if (!headers.messageId || !headers.messageTimestamp || !headers.signature)
      return false;
    const expected = `sha256=${createHmac("sha256", secret)
      .update(headers.messageId)
      .update(headers.messageTimestamp)
      .update(body)
      .digest("hex")}`;
    const actual = Buffer.from(headers.signature);
    const expectedBytes = Buffer.from(expected);
    return (
      actual.length === expectedBytes.length &&
      timingSafeEqual(actual, expectedBytes)
    );
  }

  private requireFreshTimestamp(value: string | undefined, now: Date): void {
    if (!value) throw new TwitchEventInvalidError();
    const timestamp = new Date(value);
    if (
      Number.isNaN(timestamp.getTime()) ||
      timestamp.getTime() < now.getTime() - TWITCH_EVENT_MAX_AGE_MS ||
      timestamp.getTime() > now.getTime() + 60_000
    )
      throw new TwitchEventInvalidError();
  }

  private isUniqueConflict(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2002",
    );
  }

  private isSerializationConflict(error: unknown): boolean {
    return Boolean(
      error &&
      typeof error === "object" &&
      "code" in error &&
      (error as { code?: unknown }).code === "P2034",
    );
  }

  private toEnvelope(body: unknown, headers: TwitchHeaders) {
    const payload = body as {
      event?: Record<string, unknown>;
      subscription?: { type?: unknown; version?: unknown };
    };
    const event = payload.event ?? {};
    const { type, version } = this.subscriptionIdentity(
      payload.subscription,
      headers,
    );
    return {
      messageId: headers.messageId,
      messageTimestamp: headers.messageTimestamp,
      subscriptionType: type,
      subscriptionVersion: version,
      event: {
        id: event.id,
        broadcasterUserId: event.broadcaster_user_id,
        broadcasterUserLogin: event.broadcaster_user_login,
        broadcasterUserName: event.broadcaster_user_name,
        ...(event.started_at ? { startedAt: event.started_at } : {}),
      },
    };
  }

  private challenge(body: unknown, headers: TwitchHeaders) {
    const payload = body as {
      challenge?: unknown;
      subscription?: {
        type?: unknown;
        version?: unknown;
        condition?: { broadcaster_user_id?: unknown };
      };
    };
    const { type, version } = this.subscriptionIdentity(
      payload.subscription,
      headers,
    );
    if (
      typeof payload.challenge !== "string" ||
      payload.challenge.length > 500 ||
      (type !== "stream.online" && type !== "stream.offline") ||
      version !== "1" ||
      typeof payload.subscription?.condition?.broadcaster_user_id !== "string"
    )
      throw new TwitchEventInvalidError();
    return {
      value: payload.challenge,
      broadcasterId: payload.subscription.condition.broadcaster_user_id,
    };
  }

  private subscriptionIdentity(
    subscription: { type?: unknown; version?: unknown } | undefined,
    headers: TwitchHeaders,
  ): { type: string; version: string } {
    if (
      typeof subscription?.type !== "string" ||
      typeof subscription.version !== "string" ||
      (headers.subscriptionType !== undefined &&
        headers.subscriptionType !== subscription.type) ||
      (headers.subscriptionVersion !== undefined &&
        headers.subscriptionVersion !== subscription.version)
    )
      throw new TwitchEventInvalidError();
    return { type: subscription.type, version: subscription.version };
  }
}
