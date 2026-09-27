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

  listChannels() {
    return this.prisma.twitchIngestChannel.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    });
  }

  listVodCandidates() {
    return this.prisma.twitchVodCandidate.findMany({
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
  }

  async ignoreVodCandidate(id: string) {
    const updated = await this.prisma.twitchVodCandidate.updateMany({
      where: { id, state: { in: ["WAITING_DELAY", "READY_FOR_INGEST"] } },
      data: { state: "IGNORED" },
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

  async linkVodCandidateToProject(id: string, projectId: string) {
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
    this.requireFreshTimestamp(headers.messageTimestamp, now);
    if (headers.messageType === "webhook_callback_verification") {
      const challenge = this.challenge(body, headers);
      await this.requireChannel(challenge.broadcasterId);
      return { challenge: challenge.value };
    }
    if (headers.messageType !== "notification")
      throw new TwitchEventInvalidError();
    let envelope: TwitchEventEnvelopeV1;
    try {
      envelope = parseTwitchEventEnvelope(this.toEnvelope(body, headers), now);
    } catch {
      throw new TwitchEventInvalidError();
    }
    const channel = await this.requireChannel(envelope.event.broadcasterUserId);
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

  private async requireChannel(broadcasterId: string) {
    const channel = await this.prisma.twitchIngestChannel.findUnique({
      where: { broadcasterId },
    });
    if (!channel || channel.state !== "ENABLED")
      throw new TwitchChannelNotAllowedError();
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

  private toEnvelope(body: unknown, headers: TwitchHeaders) {
    const payload = body as {
      event?: Record<string, unknown>;
      subscription?: { type?: unknown; version?: unknown };
    };
    const event = payload.event ?? {};
    return {
      messageId: headers.messageId,
      messageTimestamp: headers.messageTimestamp,
      subscriptionType: headers.subscriptionType ?? payload.subscription?.type,
      subscriptionVersion:
        headers.subscriptionVersion ?? payload.subscription?.version,
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
    if (
      typeof payload.challenge !== "string" ||
      payload.challenge.length > 500 ||
      ((headers.subscriptionType ?? payload.subscription?.type) !==
        "stream.online" &&
        (headers.subscriptionType ?? payload.subscription?.type) !==
          "stream.offline") ||
      (headers.subscriptionVersion ?? payload.subscription?.version) !== "1" ||
      typeof payload.subscription?.condition?.broadcaster_user_id !== "string"
    )
      throw new TwitchEventInvalidError();
    return {
      value: payload.challenge,
      broadcasterId: payload.subscription.condition.broadcaster_user_id,
    };
  }
}
