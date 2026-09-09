import { beforeEach, describe, expect, it } from "vitest";

import {
  loadLastSourceGate,
  saveLastSourceGate,
} from "~/features/upload-source/model/last-source-gate-storage";

describe("last source gate storage", () => {
  beforeEach(() => localStorage.clear());

  it("restores a valid project pointer after reload", () => {
    const projectId = "00000000-0000-4000-8000-000000000001";
    saveLastSourceGate(projectId);
    expect(loadLastSourceGate()).toBe(projectId);
  });

  it("fails closed for malformed browser data", () => {
    localStorage.setItem("content-factory:last-source-gate:v1", "not-json");
    expect(loadLastSourceGate()).toBeNull();
  });

  it("never interrupts the workflow when browser storage is denied", () => {
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
      saveLastSourceGate("00000000-0000-4000-8000-000000000001", denied);
      loadLastSourceGate(denied);
    }).not.toThrow();
    expect(loadLastSourceGate(denied)).toBeNull();
  });
});
