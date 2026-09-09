import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CreatorOperationStorageError,
  clearCreatorOperationKey,
  creatorOperationKey,
} from "~/features/edit-creator-context/model/attempt-storage";

describe("creator context operation identity", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.stubGlobal("crypto", { randomUUID: vi.fn().mockReturnValueOnce("00000000-0000-4000-8000-000000000001").mockReturnValueOnce("00000000-0000-4000-8000-000000000002").mockReturnValueOnce("00000000-0000-4000-8000-000000000003").mockReturnValueOnce("00000000-0000-4000-8000-000000000004") });
  });

  it("restores one idempotency key only for the exact operation, target and body", () => {
    const body = { expectedRevision: 2, sourceTitle: "Exact source" };
    expect(creatorOperationKey("source-context", "p:s:1", body)).toBe("00000000-0000-4000-8000-000000000001");
    expect(creatorOperationKey("source-context", "p:s:1", body)).toBe("00000000-0000-4000-8000-000000000001");
    expect(creatorOperationKey("source-context", "p:s:2", body)).toBe("00000000-0000-4000-8000-000000000002");
    expect(creatorOperationKey("cut-prompt", "p:s:1", body)).toBe("00000000-0000-4000-8000-000000000003");
    expect(creatorOperationKey("source-context", "p:s:1", { ...body, expectedRevision: 3 })).toBe("00000000-0000-4000-8000-000000000004");
  });

  it("drops a completed operation identity", () => {
    creatorOperationKey("profile-update", "profile", { revision: 1 });
    clearCreatorOperationKey("profile-update", "profile");
    expect(sessionStorage.getItem("content-factory.creator-context.profile-update.profile")).toBeNull();
  });

  it("fails closed when browser storage cannot persist a retry identity", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("blocked"); });
    expect(() => creatorOperationKey("profile-create", "new", { name: "A" })).toThrow(CreatorOperationStorageError);
  });
});
