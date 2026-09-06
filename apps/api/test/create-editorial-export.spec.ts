import { describe, expect, it, vi } from "vitest";

import type { EditorialExportRepository } from "../src/editorial-content/application/editorial-export-repository.port.js";
import { CreateEditorialExport } from "../src/editorial-content/application/create-editorial-export.js";
import type { JobDispatch } from "../src/media-pipeline/application/job-dispatch.port.js";

describe("CreateEditorialExport", () => {
  it("persists before dispatch and survives disposable queue failure", async () => {
    const order: string[] = [];
    const view = { id: "export-id" } as never;
    const delivery = { jobId: "job-id", attemptNumber: 1 };
    const repository = {
      create: vi.fn(async (input) => {
        order.push("persist");
        expect(input.intentId).toMatch(/^[a-f0-9-]{36}$/);
        expect(input.operationRequestId).toMatch(/^[a-f0-9-]{36}$/);
        return { view, delivery };
      }),
    } as unknown as EditorialExportRepository;
    const dispatch = {
      dispatch: vi.fn(async () => {
        order.push("dispatch");
        throw new Error("redis unavailable");
      }),
    } as unknown as JobDispatch;
    const useCase = new CreateEditorialExport(repository, dispatch, true);
    await expect(
      useCase.execute({
        approvalId: "approval-id",
        idempotencyKey: "export-key",
      }),
    ).resolves.toBe(view);
    expect(order).toEqual(["persist", "dispatch"]);
    expect(dispatch.dispatch).toHaveBeenCalledWith(delivery);
  });

  it("does not persist or dispatch while admission is disabled", async () => {
    const repository = {
      create: vi.fn(),
    } as unknown as EditorialExportRepository;
    const dispatch = { dispatch: vi.fn() } as unknown as JobDispatch;
    const useCase = new CreateEditorialExport(repository, dispatch, false);
    await expect(
      useCase.execute({
        approvalId: "approval-id",
        idempotencyKey: "export-key",
      }),
    ).rejects.toThrow();
    expect(repository.create).not.toHaveBeenCalled();
    expect(dispatch.dispatch).not.toHaveBeenCalled();
  });
});
