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
    retry: vi.fn(),
  };
}
function dispatcher() {
  return { dispatch: vi.fn(async () => undefined) };
}

describe("CreatePublicationIntent", () => {
  it("fails closed before touching persistence", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(
      repo,
      false,
      false,
      false,
      dispatch,
    );
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
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      false,
      false,
      dispatch,
      now,
    );
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

  it("preserves approved vertical lineage in the durable request", async () => {
    const repo = repository();
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      false,
      false,
      dispatcher(),
      () => new Date("2026-09-27T00:00:00.000Z"),
    );
    await useCase.execute({
      ...base,
      contentKind: "VERTICAL_RESULT",
      approvalId: undefined,
      exportResultId: undefined,
      verticalApprovalId: "00000000-0000-4000-8000-000000000005",
      verticalResultId: "00000000-0000-4000-8000-000000000006",
    });
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        contentKind: "VERTICAL_RESULT",
        approvalId: undefined,
        exportResultId: undefined,
        verticalApprovalId: "00000000-0000-4000-8000-000000000005",
        verticalResultId: "00000000-0000-4000-8000-000000000006",
      }),
    );
  });

  it("rejects past schedules, invalid timezones, and non-object metadata", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      false,
      false,
      dispatch,
      () => new Date("2026-09-27T00:00:00.000Z"),
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
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      false,
      false,
      dispatch,
    );
    await expect(
      useCase.execute({ ...base, platform: "YOUTUBE" }),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it("admits a YouTube intent only behind its dedicated gate", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      true,
      false,
      dispatch,
      () => new Date("2026-09-27T00:00:00.000Z"),
    );

    await useCase.execute({
      ...base,
      platform: "YOUTUBE",
      contentKind: "VERTICAL_RESULT",
      approvalId: undefined,
      exportResultId: undefined,
      verticalApprovalId: "00000000-0000-4000-8000-000000000005",
      verticalResultId: "00000000-0000-4000-8000-000000000006",
    });

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "YOUTUBE" }),
    );
  });

  it("requires fresh explicit TikTok consent before persistence", async () => {
    const repo = repository();
    const dispatch = dispatcher();
    const now = () => new Date("2026-09-28T00:10:00.000Z");
    const useCase = new CreatePublicationIntent(
      repo,
      true,
      false,
      true,
      dispatch,
      now,
    );
    const tiktok = {
      ...base,
      platform: "TIKTOK" as const,
      contentKind: "VERTICAL_RESULT" as const,
      approvalId: undefined,
      exportResultId: undefined,
      verticalApprovalId: "00000000-0000-4000-8000-000000000005",
      verticalResultId: "00000000-0000-4000-8000-000000000006",
      metadataSnapshot: {
        title: "Release",
        privacyLevel: "SELF_ONLY",
        disableComment: false,
        disableDuet: true,
        disableStitch: false,
        brandContentToggle: false,
        brandOrganicToggle: false,
        consent: {
          version: "tiktok-direct-post-consent-v1",
          creatorUsername: "creator",
          creatorInfoFetchedAt: "2026-09-28T00:08:00.000Z",
          confirmedAt: "2026-09-28T00:09:00.000Z",
        },
      },
    };
    await useCase.execute(tiktok);
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "TIKTOK" }),
    );

    await expect(
      useCase.execute({
        ...tiktok,
        metadataSnapshot: {
          ...tiktok.metadataSnapshot,
          consent: {
            ...tiktok.metadataSnapshot.consent,
            creatorInfoFetchedAt: "2026-09-27T00:00:00.000Z",
          },
        },
      }),
    ).rejects.toBeInstanceOf(PublicationMetadataInvalidError);
  });
});
