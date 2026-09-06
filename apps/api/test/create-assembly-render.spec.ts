import { describe, expect, it, vi } from "vitest";

import type { AssemblyRenderRepository } from "../src/editorial-content/application/assembly-render-repository.port.js";
import { CreateAssemblyRender } from "../src/editorial-content/application/create-assembly-render.js";
import type { JobDispatch } from "../src/media-pipeline/application/job-dispatch.port.js";

describe("CreateAssemblyRender", () => {
  it("persists the durable intent before dispatch and returns it when dispatch is unavailable", async () => {
    const events: string[] = [];
    const view = { id: "render-id" } as never;
    const delivery = { jobId: "job-id", attemptNumber: 1 };
    const repository = {
      create: vi.fn(async (input) => {
        events.push("persist");
        expect(input.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
        expect(input.intentId).toMatch(/^[a-f0-9-]{36}$/);
        return { view, delivery };
      }),
    } as unknown as AssemblyRenderRepository;
    const dispatch = {
      dispatch: vi.fn(async () => {
        events.push("dispatch");
        throw new Error("redis unavailable");
      }),
    } as unknown as JobDispatch;
    const useCase = new CreateAssemblyRender(repository, dispatch, true);

    await expect(
      useCase.execute({
        cutPipelineJobId: "ef703380-656e-4f15-9c5e-f722c7bbe01b",
        recipeRevision: 3,
        idempotencyKey: "render-request-1",
      }),
    ).resolves.toBe(view);
    expect(events).toEqual(["persist", "dispatch"]);
    expect(dispatch.dispatch).toHaveBeenCalledWith(delivery);
  });

  it("does not dispatch when admission fails", async () => {
    const repository = {
      create: vi.fn(async () => {
        throw new Error("admission failed");
      }),
    } as unknown as AssemblyRenderRepository;
    const dispatch = { dispatch: vi.fn() } as unknown as JobDispatch;
    const useCase = new CreateAssemblyRender(repository, dispatch, true);

    await expect(
      useCase.execute({
        cutPipelineJobId: "ef703380-656e-4f15-9c5e-f722c7bbe01b",
        recipeRevision: 3,
        idempotencyKey: "render-request-1",
      }),
    ).rejects.toThrow("admission failed");
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });

  it("does not persist or dispatch while rollout admission is disabled", async () => {
    const repository = {
      create: vi.fn(),
    } as unknown as AssemblyRenderRepository;
    const dispatch = { dispatch: vi.fn() } as unknown as JobDispatch;
    const useCase = new CreateAssemblyRender(repository, dispatch, false);
    await expect(
      useCase.execute({
        cutPipelineJobId: "ef703380-656e-4f15-9c5e-f722c7bbe01b",
        recipeRevision: 3,
        idempotencyKey: "render-request-1",
      }),
    ).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });
});
