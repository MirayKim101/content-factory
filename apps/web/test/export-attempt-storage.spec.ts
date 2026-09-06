import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  clearExportAttempt,
  exportIdempotency,
  loadExportAttempt,
  saveExportAttempt,
} from "~/features/export-editorial-package/model/export-attempt-storage";

const approval = "00000000-0000-4000-8000-000000000001";

describe("editorial export attempt storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: () => "stable-export-key" });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("reuses the exact idempotency key after a response-lost retry", () => {
    expect(exportIdempotency(approval)).toBe("stable-export-key");
    saveExportAttempt(approval, "saved-key");
    expect(exportIdempotency(approval)).toBe("saved-key");
    clearExportAttempt(approval);
    expect(loadExportAttempt(approval)).toBeUndefined();
  });

  it("removes malformed or server-invalid browser storage and makes a new safe key", () => {
    window.localStorage.setItem(
      `content-factory:editorial-export-attempt:v1:${approval}`,
      "not-json",
    );
    expect(loadExportAttempt(approval)).toBeUndefined();
    expect(
      window.localStorage.getItem(
        `content-factory:editorial-export-attempt:v1:${approval}`,
      ),
    ).toBeNull();
    window.localStorage.setItem(
      `content-factory:editorial-export-attempt:v1:${approval}`,
      JSON.stringify({ idempotencyKey: "x" }),
    );
    expect(exportIdempotency(approval)).toBe("stable-export-key");
    expect(
      window.localStorage.getItem(
        `content-factory:editorial-export-attempt:v1:${approval}`,
      ),
    ).toBeNull();
  });
});
