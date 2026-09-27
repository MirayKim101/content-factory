import { describe, expect, it } from "vitest";

import {
  parseTwitchEventEnvelope,
  TWITCH_EVENT_MAX_AGE_MS,
} from "../src/twitch-ingestion.js";

const now = new Date("2026-09-27T12:00:00.000Z");
const base = {
  messageId: "opaque-message-1",
  messageTimestamp: now.toISOString(),
  subscriptionType: "stream.online",
  subscriptionVersion: "1",
  event: {
    id: "stream-1",
    broadcasterUserId: "1337",
    broadcasterUserLogin: "creator",
    broadcasterUserName: "Creator",
    startedAt: "2026-09-27T11:55:00.000Z",
  },
};

describe("parseTwitchEventEnvelope", () => {
  it("normalizes an allowlisted stream event without credentials", () => {
    expect(parseTwitchEventEnvelope(base, now)).toEqual(base);
  });

  it("rejects unknown types, versions, stale messages and missing online time", () => {
    expect(() =>
      parseTwitchEventEnvelope(
        { ...base, subscriptionType: "channel.follow" },
        now,
      ),
    ).toThrow("TWITCH_EVENT_INVALID");
    expect(() =>
      parseTwitchEventEnvelope({ ...base, subscriptionVersion: "2" }, now),
    ).toThrow("TWITCH_EVENT_INVALID");
    expect(() =>
      parseTwitchEventEnvelope(
        {
          ...base,
          messageTimestamp: new Date(
            now.getTime() - TWITCH_EVENT_MAX_AGE_MS - 1,
          ).toISOString(),
        },
        now,
      ),
    ).toThrow("TWITCH_EVENT_REPLAY_WINDOW_INVALID");
    expect(() =>
      parseTwitchEventEnvelope(
        { ...base, event: { ...base.event, startedAt: undefined } },
        now,
      ),
    ).toThrow("TWITCH_EVENT_INVALID");
  });

  it("accepts offline events without a started timestamp", () => {
    const { startedAt: _startedAt, ...event } = base.event;
    expect(
      parseTwitchEventEnvelope(
        { ...base, subscriptionType: "stream.offline", event },
        now,
      ).event,
    ).toEqual(event);
  });
});
