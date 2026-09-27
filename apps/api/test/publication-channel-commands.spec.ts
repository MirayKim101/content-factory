import { describe, expect, it, vi } from "vitest";

import {
  CreatePublicationChannel,
  GetPublishingCapabilities,
} from "../src/publishing/application/publication-channel-commands.js";
import type { PublicationRepository } from "../src/publishing/application/publication-repository.port.js";
import {
  PublicationMetadataInvalidError,
  PublishingUnavailableError,
} from "../src/publishing/domain/publication.js";

function repository(): PublicationRepository {
  return {
    createChannel: vi.fn(async (input) => input as never),
    listChannels: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    listProject: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(),
  };
}

const input = {
  projectId: "00000000-0000-4000-8000-000000000001",
  platform: "LOCAL_DRY_RUN" as const,
  displayName: "Local verification",
  externalChannelRef: "local:project-1",
  timezone: "Asia/Novosibirsk",
};

describe("CreatePublicationChannel", () => {
  it("fails before persistence when publishing admission is disabled", async () => {
    const repo = repository();

    await expect(
      new CreatePublicationChannel(repo, false, false, false).execute(input),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.createChannel).not.toHaveBeenCalled();
  });

  it("does not admit external channels before their provider gate exists", async () => {
    const repo = repository();

    await expect(
      new CreatePublicationChannel(repo, true, false, false).execute({
        ...input,
        platform: "YOUTUBE",
      }),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.createChannel).not.toHaveBeenCalled();
  });

  it("creates only the bounded local dry-run channel", async () => {
    const repo = repository();

    await new CreatePublicationChannel(repo, true, false, false).execute(input);

    expect(repo.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        platform: "LOCAL_DRY_RUN",
        displayName: "Local verification",
        timezone: "Asia/Novosibirsk",
      }),
    );
  });

  it("admits a YouTube channel only behind its dedicated gate", async () => {
    const repo = repository();

    await new CreatePublicationChannel(repo, true, true, false).execute({
      ...input,
      platform: "YOUTUBE",
      externalChannelRef: "UC1234567890123456789012",
    });

    expect(repo.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "YOUTUBE" }),
    );
  });

  it("rejects a YouTube handle where an immutable UC channel id is required", async () => {
    const repo = repository();

    await expect(
      new CreatePublicationChannel(repo, true, true, false).execute({
        ...input,
        platform: "YOUTUBE",
        externalChannelRef: "@display-handle",
      }),
    ).rejects.toBeInstanceOf(PublicationMetadataInvalidError);
    expect(repo.createChannel).not.toHaveBeenCalled();
  });

  it("admits a TikTok open_id only behind its dedicated gate", async () => {
    const repo = repository();
    await new CreatePublicationChannel(repo, true, false, true).execute({
      ...input,
      platform: "TIKTOK",
      externalChannelRef: "723f24d7-e717-40f8-a2b6-cb8464cd23b4",
    });
    expect(repo.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "TIKTOK" }),
    );
  });
});

describe("GetPublishingCapabilities", () => {
  it("reports effective provider admission without exposing configuration", () => {
    expect(new GetPublishingCapabilities(true, true, false).execute()).toEqual({
      publishingEnabled: true,
      localDryRunEnabled: true,
      youtubeEnabled: true,
      tiktokEnabled: false,
    });
    expect(new GetPublishingCapabilities(false, true, true).execute()).toEqual({
      publishingEnabled: false,
      localDryRunEnabled: false,
      youtubeEnabled: false,
      tiktokEnabled: false,
    });
  });
});
