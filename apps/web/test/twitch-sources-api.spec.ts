import { describe, expect, it, vi } from "vitest";

import { createTwitchSourcesApi } from "~/shared/api/twitch-sources";

const vodCandidate = {
  id: "00000000-0000-4000-8000-000000000001",
  channelId: "00000000-0000-4000-8000-000000000002",
  channel: {
    broadcasterLogin: "creator",
    broadcasterDisplayName: "Creator",
  },
  providerVideoId: "12345",
  streamId: "67890",
  title: "Recent stream",
  vodType: "archive",
  durationSeconds: 600,
  startedAt: "2026-09-28T10:00:00.000Z",
  publishedAt: "2026-09-28T10:10:00.000Z",
  availableForIngestAt: "2026-09-28T10:15:00.000Z",
  state: "IMPORTED",
  importedProjectId: "00000000-0000-4000-8000-000000000003",
  createdAt: "2026-09-28T10:10:00.000Z",
  updatedAt: "2026-09-28T10:20:00.000Z",
};

describe("Twitch sources API adapter", () => {
  it("links a VOD candidate to a manually uploaded project", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => vodCandidate,
    });
    const api = createTwitchSourcesApi("/api/v1", fetchMock);

    const linked = await api.linkVodProject(
      vodCandidate.id,
      vodCandidate.importedProjectId,
      true,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/twitch/vod-candidates/${vodCandidate.id}/link-project`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: vodCandidate.importedProjectId,
          sourceMatchConfirmed: true,
        }),
      },
    );
    expect(linked.state).toBe("IMPORTED");
    expect(linked.importedProjectId).toBe(vodCandidate.importedProjectId);
  });
});
