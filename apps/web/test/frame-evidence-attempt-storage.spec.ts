import { webcrypto } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginFrameRequest,
  finishFrameRequest,
  readPendingFrameRequest,
} from "~/features/frame-evidence/model/attempt-storage";
import { frameBody, scope } from "./frame-evidence-fixtures";
describe("durable frame request identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("crypto", webcrypto);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  it("retains the exact original request after reload and changed context", () => {
    const first = beginFrameRequest(scope, frameBody);
    expect(readPendingFrameRequest(scope)).toEqual(first);
    expect(
      beginFrameRequest(scope, {
        ...frameBody,
        cutPromptRevisionId: scope.sourceId,
      }),
    ).toEqual(first);
  });
  it("retains another cut's pending request and only retires a matching key", () => {
    const first = beginFrameRequest(scope, frameBody);
    const otherScope = { ...scope, cutPipelineJobId: scope.sourceId };
    const other = beginFrameRequest(otherScope, frameBody);
    finishFrameRequest({ ...first, key: other.key });
    expect(readPendingFrameRequest(scope)).toEqual(first);
    finishFrameRequest(first);
    expect(readPendingFrameRequest(scope)).toBeNull();
    expect(readPendingFrameRequest(otherScope)).toEqual(other);
    expect(beginFrameRequest(scope, frameBody).key).not.toBe(first.key);
  });
  it("fails closed if browser storage cannot preserve an unknown request", () => {
    vi.spyOn(sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(() => beginFrameRequest(scope, frameBody)).toThrow("хранилищу");
  });
});
