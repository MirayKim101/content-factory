import { describe, expect, it, vi } from "vitest";

import { CreatePublicationChannel } from "../src/publishing/application/publication-channel-commands.js";
import type { PublicationRepository } from "../src/publishing/application/publication-repository.port.js";
import { PublishingUnavailableError } from "../src/publishing/domain/publication.js";

function repository(): PublicationRepository {
  return {
    createChannel: vi.fn(async (input) => input as never),
    listChannels: vi.fn(),
    create: vi.fn(),
    get: vi.fn(),
    listProject: vi.fn(),
    cancel: vi.fn(),
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
      new CreatePublicationChannel(repo, false, false).execute(input),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.createChannel).not.toHaveBeenCalled();
  });

  it("does not admit external channels before their provider gate exists", async () => {
    const repo = repository();

    await expect(
      new CreatePublicationChannel(repo, true, false).execute({
        ...input,
        platform: "YOUTUBE",
      }),
    ).rejects.toBeInstanceOf(PublishingUnavailableError);
    expect(repo.createChannel).not.toHaveBeenCalled();
  });

  it("creates only the bounded local dry-run channel", async () => {
    const repo = repository();

    await new CreatePublicationChannel(repo, true, false).execute(input);

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

    await new CreatePublicationChannel(repo, true, true).execute({
      ...input,
      platform: "YOUTUBE",
      externalChannelRef: "UC1234567890123456789012",
    });

    expect(repo.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ platform: "YOUTUBE" }),
    );
  });
});
