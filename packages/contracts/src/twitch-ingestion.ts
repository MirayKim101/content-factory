export const TWITCH_EVENTSUB_TYPES = [
  "stream.online",
  "stream.offline",
] as const;
export type TwitchEventSubType = (typeof TWITCH_EVENTSUB_TYPES)[number];

export const TWITCH_EVENTSUB_VERSION = "1" as const;
export const TWITCH_EVENT_MAX_AGE_MS = 10 * 60 * 1000;

export interface TwitchEventEnvelopeV1 {
  messageId: string;
  messageTimestamp: string;
  subscriptionType: TwitchEventSubType;
  subscriptionVersion: typeof TWITCH_EVENTSUB_VERSION;
  event: {
    id: string;
    broadcasterUserId: string;
    broadcasterUserLogin: string;
    broadcasterUserName: string;
    startedAt?: string;
  };
}

export function parseTwitchEventEnvelope(
  value: unknown,
  now = new Date(),
): TwitchEventEnvelopeV1 {
  if (!value || typeof value !== "object")
    throw new Error("TWITCH_EVENT_INVALID");
  const input = value as Record<string, unknown>;
  const event = input.event as Record<string, unknown> | undefined;
  if (
    typeof input.messageId !== "string" ||
    input.messageId.length < 1 ||
    input.messageId.length > 255 ||
    typeof input.messageTimestamp !== "string" ||
    !TWITCH_EVENTSUB_TYPES.includes(
      input.subscriptionType as TwitchEventSubType,
    ) ||
    input.subscriptionVersion !== TWITCH_EVENTSUB_VERSION ||
    !event ||
    typeof event.id !== "string" ||
    typeof event.broadcasterUserId !== "string" ||
    typeof event.broadcasterUserLogin !== "string" ||
    typeof event.broadcasterUserName !== "string"
  )
    throw new Error("TWITCH_EVENT_INVALID");
  const timestamp = new Date(input.messageTimestamp);
  if (
    Number.isNaN(timestamp.getTime()) ||
    timestamp.getTime() < now.getTime() - TWITCH_EVENT_MAX_AGE_MS ||
    timestamp.getTime() > now.getTime() + 60_000
  )
    throw new Error("TWITCH_EVENT_REPLAY_WINDOW_INVALID");
  if (
    input.subscriptionType === "stream.online" &&
    (typeof event.startedAt !== "string" ||
      Number.isNaN(new Date(event.startedAt).getTime()))
  )
    throw new Error("TWITCH_EVENT_INVALID");
  return {
    messageId: input.messageId,
    messageTimestamp: timestamp.toISOString(),
    subscriptionType: input.subscriptionType as TwitchEventSubType,
    subscriptionVersion: TWITCH_EVENTSUB_VERSION,
    event: {
      id: event.id,
      broadcasterUserId: event.broadcasterUserId,
      broadcasterUserLogin: event.broadcasterUserLogin,
      broadcasterUserName: event.broadcasterUserName,
      ...(typeof event.startedAt === "string"
        ? { startedAt: new Date(event.startedAt).toISOString() }
        : {}),
    },
  };
}
