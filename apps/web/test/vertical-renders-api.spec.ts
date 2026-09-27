import { describe, expect, it, vi } from "vitest";

import { createVerticalRendersApi } from "~/shared/api/vertical-renders";

describe("vertical renders API adapter", () => {
  it("reads effective render admission from the server", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ renderEnabled: false }),
    }));
    const api = createVerticalRendersApi("/api/v1", fetchMock as never);

    await expect(api.capabilities()).resolves.toEqual({
      renderEnabled: false,
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/v1/vertical-renders/capabilities",
      {},
    );
  });
});
