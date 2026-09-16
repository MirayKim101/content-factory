import { describe, it, expect, vi } from "vitest";
import {
  createCreatorContextApi,
  CreatorContextApiError,
} from "~/shared/api/creator-context";
import {
  profileFormSchema,
  sourceContextFormSchema,
} from "~/features/edit-creator-context/model/forms";
import {
  ids,
  profile,
  reference,
  context,
  summary,
} from "./creator-context-fixtures";
function response(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
describe("Creator context API boundary", () => {
  it("redacts unexpected private fields from summaries but preserves editable private detail and PUT", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          items: [
            {
              ...summary(),
              editorialNotes: "PRIVATE",
              restrictions: ["PRIVATE"],
              objectKey: "SECRET",
            },
          ],
          nextCursor: null,
        }),
      )
      .mockResolvedValueOnce(response(profile()))
      .mockResolvedValueOnce(response(profile(ids.a, 2)));
    const api = createCreatorContextApi("/api/v1", fetcher);
    const list = await api.listProfiles();
    expect(list[0]).not.toHaveProperty("editorialNotes");
    expect(list[0]).not.toHaveProperty("objectKey");
    const detail = await api.getProfile(ids.a);
    await api.updateProfile(
      ids.a,
      {
        ...detail.revision.editableRevision,
        expectedRevision: detail.currentRevision,
      },
      ids.b,
    );
    const init = fetcher.mock.calls[2]![1]!;
    expect(JSON.parse(init.body as string)).toEqual({
      ...profile().revision.editableRevision,
      expectedRevision: 1,
    });
    expect(init.headers).toEqual(
      expect.objectContaining({ "Idempotency-Key": ids.b }),
    );
  });
  it("sends multipart without overriding boundary and uses only private content URL", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(response(reference()));
    const api = createCreatorContextApi("/api/v1", fetcher);
    await api.uploadReference(
      ids.a,
      new File(["image"], "test.png", { type: "image/png" }),
      ids.b,
    );
    const init = fetcher.mock.calls[0]![1]!;
    expect(init.body).toBeInstanceOf(FormData);
    expect(init.headers).toEqual({ "Idempotency-Key": ids.b });
    expect(api.referenceContentUrl(ids.a, ids.asset)).toBe(
      `/api/v1/creator-profiles/${ids.a}/reference-assets/${ids.asset}/content`,
    );
  });
  it("retains exact sourceVersion and typed conflict identity", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(response(context(1, 2)))
      .mockResolvedValueOnce(
        response(
          {
            error: {
              code: "CREATOR_PROFILE_OFFICIAL_URL_CONFLICT",
              message: "conflict",
              existingProfileId: ids.b,
            },
          },
          409,
        ),
      );
    const api = createCreatorContextApi("/api/v1", fetcher);
    await api.getSourceContext(ids.a, ids.source, 2);
    expect(fetcher.mock.calls[0]![0]).toContain(
      `/versions/2/editorial-context`,
    );
    await expect(
      api.createProfile(profile().revision.editableRevision, ids.a),
    ).rejects.toMatchObject({
      code: "CREATOR_PROFILE_OFFICIAL_URL_CONFLICT",
      status: 409,
      existingProfileId: ids.b,
    });
  });
  it("keeps authorization and default selection independent typed mutations", async () => {
    const asset = reference("CLEARED", 2);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        response({
          assetId: ids.asset,
          creatorProfileId: ids.a,
          current: asset.currentAuthorization,
          history: [asset.currentAuthorization],
        }),
      )
      .mockResolvedValueOnce(response(profile(ids.a, 2)));
    const api = createCreatorContextApi("/api/v1", fetcher);
    await api.updateAuthorization(
      ids.a,
      ids.asset,
      {
        expectedRevision: 1,
        decision: "CLEARED",
        declarationVersion: "creator-likeness-rights-v1",
        commercialAiImageUseAttested: true,
        basis: "consent",
        scope: "commercial",
        externalProviderTransferAllowed: false,
      },
      ids.b,
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
    await api.setDefault(
      ids.a,
      {
        expectedProfileRevision: 1,
        action: "SET",
        assetId: ids.asset,
        authorizationRevisionId: ids.auth,
        authorizationRevision: 2,
      },
      ids.a,
    );
    expect(JSON.parse(fetcher.mock.calls[1]![1]!.body as string)).toEqual({
      expectedProfileRevision: 1,
      action: "SET",
      assetId: ids.asset,
      authorizationRevisionId: ids.auth,
      authorizationRevision: 2,
    });
  });
  it("maps network/503/malformed errors to bounded outcomes", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("private transport detail"))
      .mockResolvedValueOnce(
        response(
          {
            error: { code: "AI_CONTEXT_DISABLED", message: "Context disabled" },
          },
          503,
        ),
      )
      .mockResolvedValueOnce(
        new Response("private bad gateway detail", { status: 502 }),
      );
    const api = createCreatorContextApi("/api/v1", fetcher);
    await expect(api.getProfile(ids.a)).rejects.toEqual(
      new CreatorContextApiError(
        "NETWORK_ERROR",
        "Не удалось связаться с API.",
        0,
      ),
    );
    await expect(api.getProfile(ids.a)).rejects.toMatchObject({
      code: "AI_CONTEXT_DISABLED",
      status: 503,
    });
    await expect(api.getProfile(ids.a)).rejects.toMatchObject({
      code: "API_RESPONSE_INVALID",
      status: 502,
    });
  });
});
describe("Creator context form trust boundary", () => {
  const fields = {
    ...profile().revision.editableRevision,
    topicsText: "Games",
    restrictionsText: "No claims",
  };
  it.each([
    "http://example.com",
    "javascript:alert(1)",
    "https://user:password@example.com",
    "https://example.com/?q=x",
    "https://example.com/#anchor",
  ])("rejects unsafe/unsupported official URL %s", (officialUrl) => {
    expect(
      profileFormSchema.safeParse({ ...fields, officialUrl }).success,
    ).toBe(false);
  });
  it("validates per-item bounds and exact positive profile revision", () => {
    expect(
      profileFormSchema.safeParse({ ...fields, topicsText: "x".repeat(101) })
        .success,
    ).toBe(false);
    expect(
      sourceContextFormSchema.safeParse({
        ...context().revision.editableRevision,
        restrictionsText: "",
        creatorProfileRevision: 0,
      }).success,
    ).toBe(false);
  });
});
