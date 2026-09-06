import { describe, expect, it, vi } from "vitest";

import type { AssemblyRecipeRepository } from "../src/editorial-content/application/assembly-recipe-repository.port.js";
import { SaveAssemblyRecipe } from "../src/editorial-content/application/save-assembly-recipe.js";

describe("SaveAssemblyRecipe", () => {
  it("canonicalizes optional fields and fingerprints the exact request", async () => {
    const repository: AssemblyRecipeRepository = {
      save: vi.fn(async () => ({}) as never),
      getCurrent: vi.fn(),
      getRevision: vi.fn(),
      listProject: vi.fn(),
    };
    const useCase = new SaveAssemblyRecipe(repository);
    await useCase.execute({
      pipelineJobId: "0b37b97c-747d-401f-916a-8d731c709c6e",
      expectedRevision: 0,
      idempotencyKey: "assembly-test-01",
      introAssetId: null,
      outroAssetId: null,
      advertisement: null,
      banners: [],
      cta: null,
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
    });
    expect(repository.save).toHaveBeenCalledOnce();
    const value = vi.mocked(repository.save).mock.calls[0]![0];
    expect(value.configuration).toEqual({
      introAssetId: null,
      outroAssetId: null,
      advertisement: null,
      banners: [],
      cta: null,
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
    });
    expect(value.requestFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(value.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(value.assetReferenceIds).toEqual([]);
  });

  it("allocates one immutable reference identity per selected asset", async () => {
    const repository: AssemblyRecipeRepository = {
      save: vi.fn(async () => ({}) as never),
      getCurrent: vi.fn(),
      getRevision: vi.fn(),
      listProject: vi.fn(),
    };
    await new SaveAssemblyRecipe(repository).execute({
      pipelineJobId: "0b37b97c-747d-401f-916a-8d731c709c6e",
      expectedRevision: 4,
      idempotencyKey: "assembly-test-02",
      introAssetId: "8c70f28d-f60b-445c-9e71-392ec28853b0",
      outroAssetId: "b55b98f2-ea87-442e-b7a8-39b2fdc5dd1c",
      advertisement: {
        assetId: "201be95b-f809-4c8f-bbf0-051162442ccb",
        insertAtMs: 10_000,
      },
      banners: [
        {
          clientItemId: "banner-1",
          assetId: "10d27a09-5c09-4ceb-bc36-b0a5979d11fd",
          startMs: 0,
          endMs: 5_000,
          position: "TOP_RIGHT",
        },
      ],
      cta: null,
      audioProfileVersion: "youtube-stereo-v1",
      encodingProfileVersion: "youtube-h264-v1",
    });
    const value = vi.mocked(repository.save).mock.calls[0]![0];
    expect(value.assetReferenceIds).toHaveLength(4);
    expect(new Set(value.assetReferenceIds).size).toBe(4);
  });
});
