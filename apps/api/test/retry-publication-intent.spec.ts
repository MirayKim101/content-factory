import { describe, expect, it, vi } from "vitest";

import { RetryPublicationIntent } from "../src/publishing/application/retry-publication-intent.js";
import type { PublicationRepository } from "../src/publishing/application/publication-repository.port.js";
import {
  PublicationNotFoundError,
  PublishingUnavailableError,
} from "../src/publishing/domain/publication.js";

const id = "00000000-0000-4000-8000-000000000001";
const scheduledAt = new Date("2026-09-28T12:00:00.000Z");

function repository(
  platform: "LOCAL_DRY_RUN" | "YOUTUBE" | "TIKTOK" = "LOCAL_DRY_RUN",
): PublicationRepository {
  const intent = { id, platform, scheduledAt } as never;
  return {
    createChannel: vi.fn(),
    listChannels: vi.fn(),
    create: vi.fn(),
    get: vi.fn(async () => intent),
    listProject: vi.fn(),
    cancel: vi.fn(),
    retry: vi.fn(async () => intent),
  };
}

describe("RetryPublicationIntent", () => {
  it("requeues and dispatches a safe local retry", async () => {
    const repo = repository();
    const dispatch = { dispatch: vi.fn(async () => undefined) };
    const now = () => scheduledAt;
    const useCase = new RetryPublicationIntent(
      repo,
      true,
      false,
      false,
      dispatch,
      now,
    );

    await useCase.execute(id);

    expect(repo.retry).toHaveBeenCalledWith(id, scheduledAt);
    expect(dispatch.dispatch).toHaveBeenCalledWith({ id, scheduledAt });
  });

  it("fails closed for a disabled external provider", async () => {
    const repo = repository("YOUTUBE");
    const dispatch = { dispatch: vi.fn(async () => undefined) };
    const useCase = new RetryPublicationIntent(
      repo,
      true,
      false,
      false,
      dispatch,
    );

    await expect(useCase.execute(id)).rejects.toBeInstanceOf(
      PublishingUnavailableError,
    );
    expect(repo.retry).not.toHaveBeenCalled();
  });

  it("does not create state for an unknown intent", async () => {
    const repo = repository();
    vi.mocked(repo.get).mockResolvedValue(null);
    const useCase = new RetryPublicationIntent(repo, true, false, false, {
      dispatch: vi.fn(),
    });

    await expect(useCase.execute(id)).rejects.toBeInstanceOf(
      PublicationNotFoundError,
    );
    expect(repo.retry).not.toHaveBeenCalled();
  });
});
