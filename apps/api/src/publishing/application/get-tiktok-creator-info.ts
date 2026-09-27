import { Injectable } from "@nestjs/common";

import { PrismaService } from "../../database/prisma.service.js";
import {
  PublicationNotFoundError,
  PublishingUnavailableError,
  TikTokCreatorInfoUnavailableError,
} from "../domain/publication.js";
import {
  publicationPlatformEnabled,
  resolvePublishingCapabilities,
} from "./publishing-admission.js";

const TOKEN_ENDPOINT = "https://open.tiktokapis.com/v2/oauth/token/";
const CREATOR_INFO_ENDPOINT =
  "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";
const CREATOR_INFO_CACHE_TTL_MS = 30_000;

export interface TikTokCreatorInfoView {
  creatorAvatarUrl: string;
  creatorNickname: string;
  creatorUsername: string;
  privacyLevelOptions: string[];
  commentDisabled: boolean;
  duetDisabled: boolean;
  stitchDisabled: boolean;
  maxVideoPostDurationSec: number;
  fetchedAt: string;
}

@Injectable()
export class GetTikTokCreatorInfo {
  private readonly cache = new Map<
    string,
    { expiresAt: number; value: TikTokCreatorInfoView }
  >();
  private readonly pending = new Map<string, Promise<TikTokCreatorInfoView>>();

  constructor(private readonly prisma: PrismaService) {}

  async execute(
    projectId: string,
    channelId: string,
  ): Promise<TikTokCreatorInfoView> {
    if (
      !publicationPlatformEnabled(
        resolvePublishingCapabilities(
          process.env.PUBLISHING_ENABLED?.trim() === "1",
          process.env.YOUTUBE_PUBLISHING_ENABLED?.trim() === "1",
          process.env.TIKTOK_PUBLISHING_ENABLED?.trim() === "1",
        ),
        "TIKTOK",
      )
    )
      throw new PublishingUnavailableError();
    const channel = await this.prisma.publicationChannel.findFirst({
      where: {
        id: channelId,
        projectId,
        platform: "TIKTOK",
        state: "ENABLED",
      },
      select: { externalChannelRef: true },
    });
    if (!channel) throw new PublicationNotFoundError();
    const config = tiktokApiConfig(process.env);
    const credential = config.credentials.find(
      (item) =>
        item.externalChannelRef === channel.externalChannelRef &&
        (!item.channelId || item.channelId === channelId),
    );
    if (!credential) throw new TikTokCreatorInfoUnavailableError();
    const now = Date.now();
    const cached = this.cache.get(channelId);
    if (cached && cached.expiresAt > now) return cached.value;
    if (cached) this.cache.delete(channelId);
    const existing = this.pending.get(channelId);
    if (existing) return existing;
    const request = queryTikTokCreatorInfo(
      {
        clientKey: config.clientKey,
        clientSecret: config.clientSecret,
        refreshToken: credential.refreshToken,
        expectedOpenId: channel.externalChannelRef,
      },
      fetch,
      new Date(now),
    );
    this.pending.set(channelId, request);
    try {
      const value = await request;
      this.cache.set(channelId, {
        expiresAt: Date.now() + CREATOR_INFO_CACHE_TTL_MS,
        value,
      });
      return value;
    } finally {
      this.pending.delete(channelId);
    }
  }
}

export async function queryTikTokCreatorInfo(
  input: {
    clientKey: string;
    clientSecret: string;
    refreshToken: string;
    expectedOpenId: string;
  },
  request: typeof fetch,
  now: Date,
): Promise<TikTokCreatorInfoView> {
  try {
    const tokenResponse = await request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: input.clientKey,
        client_secret: input.clientSecret,
        grant_type: "refresh_token",
        refresh_token: input.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!tokenResponse.ok) throw new Error("TOKEN_REFRESH_FAILED");
    const token = record(await tokenResponse.json());
    if (
      typeof token.access_token !== "string" ||
      !token.access_token ||
      token.access_token.length > 4096 ||
      /[\r\n]/.test(token.access_token) ||
      token.open_id !== input.expectedOpenId ||
      typeof token.scope !== "string" ||
      !token.scope
        .split(",")
        .map((scope) => scope.trim())
        .includes("video.publish")
    )
      throw new Error("TOKEN_IDENTITY_INVALID");
    const response = await request(CREATOR_INFO_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token.access_token}`,
        "content-type": "application/json; charset=UTF-8",
      },
      body: "{}",
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("CREATOR_INFO_FAILED");
    const payload = record(await response.json());
    const error = record(payload.error);
    const data = record(payload.data);
    if (error.code !== "ok") throw new Error("CREATOR_INFO_REJECTED");
    return {
      creatorAvatarUrl: string(data.creator_avatar_url, 2048),
      creatorNickname: string(data.creator_nickname, 256),
      creatorUsername: string(data.creator_username, 256),
      privacyLevelOptions: stringArray(data.privacy_level_options, 16, 64),
      commentDisabled: boolean(data.comment_disabled),
      duetDisabled: boolean(data.duet_disabled),
      stitchDisabled: boolean(data.stitch_disabled),
      maxVideoPostDurationSec: integer(
        data.max_video_post_duration_sec,
        1,
        3600,
      ),
      fetchedAt: now.toISOString(),
    };
  } catch {
    throw new TikTokCreatorInfoUnavailableError();
  }
}

function tiktokApiConfig(environment: NodeJS.ProcessEnv): {
  clientKey: string;
  clientSecret: string;
  credentials: Array<{
    channelId?: string;
    externalChannelRef: string;
    refreshToken: string;
  }>;
} {
  try {
    const clientKey = environment.TIKTOK_CLIENT_KEY?.trim();
    const clientSecret = environment.TIKTOK_CLIENT_SECRET?.trim();
    if (!clientKey || !clientSecret) throw new Error("INVALID");
    const parsed: unknown = JSON.parse(
      environment.TIKTOK_CHANNEL_CREDENTIALS_JSON ?? "",
    );
    if (!Array.isArray(parsed) || !parsed.length) throw new Error("INVALID");
    const credentials = parsed.map((item) => {
      const value = record(item);
      if (
        typeof value.externalChannelRef !== "string" ||
        !/^[A-Za-z0-9._-]{1,128}$/.test(value.externalChannelRef) ||
        typeof value.refreshToken !== "string" ||
        !value.refreshToken ||
        value.refreshToken.length > 4096 ||
        (value.channelId !== undefined &&
          (typeof value.channelId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              value.channelId,
            )))
      )
        throw new Error("INVALID");
      return {
        ...(typeof value.channelId === "string"
          ? { channelId: value.channelId }
          : {}),
        externalChannelRef: value.externalChannelRef,
        refreshToken: value.refreshToken,
      };
    });
    return { clientKey, clientSecret, credentials };
  } catch {
    throw new TikTokCreatorInfoUnavailableError();
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("INVALID");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value || value.length > max)
    throw new Error("INVALID");
  return value;
}
function stringArray(
  value: unknown,
  maxItems: number,
  maxLength: number,
): string[] {
  if (!Array.isArray(value) || !value.length || value.length > maxItems)
    throw new Error("INVALID");
  return value.map((item) => string(item, maxLength));
}
function boolean(value: unknown): boolean {
  if (typeof value !== "boolean") throw new Error("INVALID");
  return value;
}
function integer(value: unknown, min: number, max: number): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < min ||
    value > max
  )
    throw new Error("INVALID");
  return value;
}
