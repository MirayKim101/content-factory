import { afterEach, describe, expect, it, vi } from "vitest";

import {
  clearAssemblyRecipeAttempt,
  loadAssemblyRecipeAttempt,
  saveAssemblyRecipeAttempt,
} from "~/features/edit-assembly-recipe/model/active-assembly-recipe-attempt-storage";
import { idempotencyForAssemblyRecipeSave } from "~/features/edit-assembly-recipe/model/save-identity";

const jobId = "00000000-0000-4000-8000-000000000001";
const body = {
  expectedRevision: 0,
  introAssetId: null,
  outroAssetId: null,
  advertisement: null,
  banners: [],
  cta: null,
  audioProfileVersion: "youtube-stereo-v1" as const,
  encodingProfileVersion: "youtube-h264-v1" as const,
};

describe("active assembly recipe attempt storage", () => {
  afterEach(() => localStorage.clear());

  it("reuses the key after a component reload for the same canonical payload", () => {
    const initial = idempotencyForAssemblyRecipeSave(
      undefined,
      body,
      () => "stable-key",
    );
    saveAssemblyRecipeAttempt(jobId, initial);
    const recovered = loadAssemblyRecipeAttempt(jobId);
    expect(
      idempotencyForAssemblyRecipeSave(recovered, body, () => "new-key"),
    ).toEqual(initial);
  });

  it("uses a new key for a changed payload and clears only after confirmation", () => {
    const initial = idempotencyForAssemblyRecipeSave(
      undefined,
      body,
      () => "stable-key",
    );
    saveAssemblyRecipeAttempt(jobId, initial);
    expect(
      idempotencyForAssemblyRecipeSave(
        loadAssemblyRecipeAttempt(jobId),
        { ...body, expectedRevision: 1 },
        () => "changed-key",
      ).key,
    ).toBe("changed-key");
    expect(loadAssemblyRecipeAttempt(jobId)).toEqual(initial);
    clearAssemblyRecipeAttempt(jobId);
    expect(loadAssemblyRecipeAttempt(jobId)).toBeUndefined();
  });

  it("does not break saving when browser storage is unavailable", () => {
    const blocked = {
      getItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      setItem: vi.fn(() => {
        throw new Error("blocked");
      }),
      removeItem: vi.fn(),
    } as unknown as Storage;
    expect(loadAssemblyRecipeAttempt(jobId, blocked)).toBeUndefined();
    expect(() =>
      saveAssemblyRecipeAttempt(
        jobId,
        { fingerprint: "{}", key: "stable-key" },
        blocked,
      ),
    ).not.toThrow();
  });

  it("removes a length-valid but API-invalid stored key before creating a new one", () => {
    const key = `content-factory.assembly-recipe-attempt.v1:${jobId}`;
    localStorage.setItem(
      key,
      JSON.stringify({ fingerprint: JSON.stringify(body), key: "!!!!!!!!" }),
    );
    expect(loadAssemblyRecipeAttempt(jobId)).toBeUndefined();
    expect(localStorage.getItem(key)).toBeNull();
    expect(
      idempotencyForAssemblyRecipeSave(
        loadAssemblyRecipeAttempt(jobId),
        body,
        () => "fresh-key",
      ).key,
    ).toBe("fresh-key");
  });
});
