import { afterEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  clipGenerationEnabled: false,
  clipGenerationModel: "fixture-model" as string | null,
  mediaQueueDisabled: false,
}));
vi.mock("../src/config/environment.js", () => ({
  apiEnvironment: () => runtime,
}));
vi.mock("bullmq", () => ({
  Queue: class {
    close = vi.fn();
  },
}));

import { ClipGenerationController } from "../src/ai-content/clip-generation/clip-generation.controller.js";

afterEach(() => {
  runtime.clipGenerationEnabled = false;
  runtime.clipGenerationModel = "fixture-model";
  runtime.mediaQueueDisabled = false;
});

function setup() {
  const service = {
    list: vi.fn().mockResolvedValue([{ id: "historical-intent" }]),
    detail: vi.fn().mockResolvedValue({ id: "historical-intent" }),
    create: vi.fn(),
    resolveAcceptance: vi.fn(),
  };
  const cuts = { execute: vi.fn() };
  return {
    service,
    cuts,
    controller: new ClipGenerationController(service as never, cuts as never),
  };
}

describe("ClipGenerationController rollback admission", () => {
  it("retains list/detail history with writes disabled before touching persistence", async () => {
    const { controller, service, cuts } = setup();
    expect(await controller.list("project")).toEqual({
      items: [{ id: "historical-intent" }],
      generationEnabled: false,
    });
    expect(await controller.detail("historical-intent")).toEqual({
      id: "historical-intent",
    });
    await expect(
      controller.create("project", "create-key", {} as never),
    ).rejects.toMatchObject({ response: { code: "CLIP_GENERATION_DISABLED" } });
    await expect(
      controller.accept("intent", "accept-key", {
        suggestionIds: ["suggestion"],
      }),
    ).rejects.toMatchObject({ response: { code: "CLIP_GENERATION_DISABLED" } });
    expect(service.create).not.toHaveBeenCalled();
    expect(service.resolveAcceptance).not.toHaveBeenCalled();
    expect(cuts.execute).not.toHaveBeenCalled();
  });

  it.each(["model", "queue"])(
    "reports effective disabled capability when %s is unavailable",
    async (reason) => {
      runtime.clipGenerationEnabled = true;
      if (reason === "model") runtime.clipGenerationModel = null;
      else runtime.mediaQueueDisabled = true;
      const { controller } = setup();
      expect((await controller.list("project")).generationEnabled).toBe(false);
      await controller.onModuleDestroy();
    },
  );

  it("reports true only for admitted generation", async () => {
    runtime.clipGenerationEnabled = true;
    const { controller } = setup();
    expect((await controller.list("project")).generationEnabled).toBe(true);
    await controller.onModuleDestroy();
  });
});
