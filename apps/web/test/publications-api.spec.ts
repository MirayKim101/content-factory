import { describe, expect, it, vi } from "vitest";

import {
  createPublicationsApi,
  PublicationsApiError,
} from "~/shared/api/publications";

const projectId = "00000000-0000-4000-8000-000000000001";
const channelId = "00000000-0000-4000-8000-000000000002";
const intentId = "00000000-0000-4000-8000-000000000003";

function channel() {
  return {
    id: channelId,
    projectId,
    platform: "LOCAL_DRY_RUN",
    displayName: "Локальная проверка",
    externalChannelRef: `local:${projectId}`,
    timezone: "Asia/Novosibirsk",
    state: "ENABLED",
    createdAt: "2026-09-27T10:00:00.000Z",
    updatedAt: "2026-09-27T10:00:00.000Z",
  };
}

describe("publications api", () => {
  it("requests a publication retry without creating a second intent", async () => {
    const failed = {
      ...channel(),
      id: intentId,
      channelId,
      contentKind: "EDITORIAL_EXPORT",
      approvalId: null,
      exportIntentId: null,
      exportResultId: null,
      verticalApprovalId: null,
      verticalResultId: null,
      scheduledAt: "2026-09-28T12:00:00.000Z",
      metadataSnapshot: {},
      state: "QUEUED",
      attemptCount: 0,
      retryBudget: 3,
      remotePublicationId: null,
      remoteStatus: null,
      failure: null,
      latestMetrics: null,
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(failed), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );

    await createPublicationsApi("/api/v1", fetchMock as typeof fetch).retry(
      intentId,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/publications/${intentId}/retry`,
      { method: "POST" },
    );
  });

  it("explains why an unsafe retry is blocked", async () => {
    const rejected = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "PUBLICATION_RETRY_UNSAFE" } }),
          { status: 409, headers: { "Content-Type": "application/json" } },
        ),
    );

    await expect(
      createPublicationsApi("/api/v1", rejected as typeof fetch).retry(
        intentId,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicationsApiError>>({
        code: "PUBLICATION_RETRY_UNSAFE",
        status: 409,
        message:
          "Повтор заблокирован: сначала подтвердите итог операции на площадке.",
      }),
    );
  });

  it("loads bounded TikTok creator capabilities without credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            creatorAvatarUrl: "https://example.test/avatar",
            creatorNickname: "Creator",
            creatorUsername: "creator",
            privacyLevelOptions: ["SELF_ONLY"],
            commentDisabled: false,
            duetDisabled: true,
            stitchDisabled: false,
            maxVideoPostDurationSec: 600,
            fetchedAt: "2026-09-28T00:00:00.000Z",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    const result = await createPublicationsApi(
      "/api/v1",
      fetchMock as typeof fetch,
    ).getTikTokCreatorInfo(projectId, channelId);
    expect(result.creatorUsername).toBe("creator");
    expect(result).not.toHaveProperty("accessToken");
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/publication-channels/${channelId}/tiktok-creator-info`,
      {},
    );
  });

  it("creates a bounded local channel without exposing credentials", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(channel()), {
          status: 201,
          headers: { "Content-Type": "application/json" },
        }),
    );
    const api = createPublicationsApi("/api/v1", fetchMock as typeof fetch);
    await api.createDryRunChannel(projectId, {
      displayName: "Локальная проверка",
      timezone: "Asia/Novosibirsk",
    });
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/projects/${projectId}/publication-channels`,
      expect.objectContaining({ method: "POST" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string);
    expect(body).toEqual({
      platform: "LOCAL_DRY_RUN",
      externalChannelRef: `local:${projectId}`,
      displayName: "Локальная проверка",
      timezone: "Asia/Novosibirsk",
    });
  });

  it("sends the idempotency key and translates disabled admission", async () => {
    const accepted = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: intentId,
            projectId,
            channelId,
            approvalId: "00000000-0000-4000-8000-000000000004",
            exportIntentId: "00000000-0000-4000-8000-000000000005",
            exportResultId: "00000000-0000-4000-8000-000000000006",
            platform: "LOCAL_DRY_RUN",
            scheduledAt: "2026-10-01T09:00:00.000Z",
            timezone: "Asia/Novosibirsk",
            metadataSnapshot: { title: "Release" },
            state: "SCHEDULED",
            attemptCount: 0,
            retryBudget: 0,
            remotePublicationId: null,
            remoteStatus: null,
            failure: null,
            createdAt: "2026-09-27T10:00:00.000Z",
            updatedAt: "2026-09-27T10:00:00.000Z",
          }),
          { status: 202, headers: { "Content-Type": "application/json" } },
        ),
    );
    const api = createPublicationsApi("/api/v1", accepted as typeof fetch);
    await api.create(
      projectId,
      {
        platform: "LOCAL_DRY_RUN",
        channelId,
        approvalId: "00000000-0000-4000-8000-000000000004",
        exportResultId: "00000000-0000-4000-8000-000000000006",
        scheduledAt: "2026-10-01T09:00:00.000Z",
        timezone: "Asia/Novosibirsk",
        metadataSnapshot: { title: "Release" },
      },
      "publication-test-1",
    );
    expect(accepted.mock.calls[0]![1].headers).toMatchObject({
      "Idempotency-Key": "publication-test-1",
    });

    const rejected = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "PUBLISHING_DISABLED" } }),
          {
            status: 503,
            headers: { "Content-Type": "application/json" },
          },
        ),
    );
    await expect(
      createPublicationsApi("/api/v1", rejected as typeof fetch).list(
        projectId,
      ),
    ).rejects.toEqual(
      expect.objectContaining<Partial<PublicationsApiError>>({
        code: "PUBLISHING_DISABLED",
        status: 503,
        message: "Публикации выключены в конфигурации сервера.",
      }),
    );
  });
});
