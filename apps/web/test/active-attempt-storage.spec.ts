import { describe, expect, it } from "vitest";
import {
  clearActiveAttempt,
  loadActiveAttempt,
  saveActiveAttempt,
} from "~/features/upload-source/model/active-attempt-storage";

const attempt = {
  idempotencyKey: "attempt-0001",
  name: "source",
  fingerprint: { size: 10, lastModified: 1, type: "video/mp4" },
  status: "SENDING" as const,
};
function storage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
    values,
  };
}

describe("active upload attempt storage", () => {
  it("round-trips only safe recovery data", () => {
    const value = storage();
    saveActiveAttempt(attempt, value);
    expect(loadActiveAttempt(value)).toEqual(attempt);
    expect(JSON.stringify([...value.values.values()])).not.toContain("blob");
  });
  it("clears corrupt data and never throws when storage access is denied", () => {
    const value = storage();
    value.setItem("content-factory.active-source-upload.v1", "{");
    expect(loadActiveAttempt(value)).toBeNull();
    const denied = {
      getItem: () => {
        throw new DOMException("denied");
      },
      setItem: () => {
        throw new DOMException("denied");
      },
      removeItem: () => {
        throw new DOMException("denied");
      },
    } as unknown as Storage;
    expect(() => {
      saveActiveAttempt(attempt, denied);
      clearActiveAttempt(denied);
      loadActiveAttempt(denied);
    }).not.toThrow();
  });
});
