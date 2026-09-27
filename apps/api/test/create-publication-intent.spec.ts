import { describe, expect, it, vi } from "vitest";

import { CreatePublicationIntent } from "../src/publishing/application/create-publication-intent.js";
import type { PublicationRepository } from "../src/publishing/application/publication-repository.port.js";
import {
  PublicationMetadataInvalidError,
  PublicationScheduleInvalidError,
  PublicationTimezoneInvalidError,
  PublishingUnavailableError,
} from "../src/publishing/domain/publication.js";

const base = {
  idempotencyKey: "publish-1",
  projectId: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  approvalId: "00000000-0000-4000-8000-000000000003",
  exportResultId: "00000000-0000-4000-8000-000000000004",
  platform: "LOCAL_DRY_RUN" as const,
  scheduledAt: "2026-10-01T09:00:00.000Z",
  timezone: "Asia/Novosibirsk",
  metadataSnapshot: { title: "Release", tags: ["one"] },
};

function repository(): PublicationRepository {
  return {
    create: vi.fn(async (input) => input as never),
    createChannel: vi.fn(),
    listChannels: vi.fn(),
    get: vi.fn(),
    listProject: vi.fn(),
    cancel: vi.fn(),
  };
}
function dispatcher() {
  return { dispatch: vi.fn(async () => undefined) };
}

describe("CreatePublicationIntent", () => {
  it("fails closed before touching persistence", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(repo, false, dispatch);
    await expect(useCase.execute(base)).rejects.toBeInstanceOf(
      PublishingUnavailableError,
    );
    expect(repo.create).not.toHaveBeenCalled();
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it("canonicalizes the instant and produces a stable fingerprint", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const now = () => new Date("2026-09-27T00:00:00.000Z");
    const useCase = new CreatePublicationIntent(repo, true, dispatch, now);
    await useCase.execute(base);
    await useCase.execute({
      ...base,
      metadataSnapshot: { tags: ["one"], title: "Release" },
    });
    const calls = vi.mocked(repo.create).mock.calls;
    expect(calls[0]?.[0].requestFingerprint).toBe(
      calls[1]?.[0].requestFingerprint,
    );
    expect(calls[0]?.[0].scheduledAt.toISOString()).toBe(
      "2026-10-01T09:00:00.000Z",
    );
    expect(dispatch.dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.dispatch).toHaveBeenLastCalledWith({
      id: expect.any(String),
      scheduledAt: new Date("2026-10-01T09:00:00.000Z"),
    });
  });

  it("rejects past schedules, invalid timezones, and non-object metadata", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(repo, true, dispatch, () =>
      new Date("2026-09-27T00:00:00.000Z"),
    );
    await expect(
      useCase.execute({ ...base, scheduledAt: "2020-01-01T00:00:00Z" }),
    ).rejects.toBeInstanceOf(PublicationScheduleInvalidError);
    await expect(
      useCase.execute({ ...base, timezone: "Mars/Olympus" }),
    ).rejects.toBeInstanceOf(PublicationTimezoneInvalidError);
    await expect(
      useCase.execute({ ...base, metadataSnapshot: [] }),
    ).rejects.toBeInstanceOf(PublicationMetadataInvalidError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("keeps external providers unavailable in the dry-run slice", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(repo, true, dispatch);
    await expect(
      useCase.execute({ ...base, platform: "YOUTUBE" }),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.create).not.toHaveBeenCalled();
  });
});
