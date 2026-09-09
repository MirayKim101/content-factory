import { mount } from "@vue/test-utils";
import { describe, expect, it } from "vitest";

import MontageAssetCard from "~/entities/montage-asset/ui/montage-asset-card.vue";

const baseAsset = {
  id: "00000000-0000-4000-8000-000000000001",
  projectId: "00000000-0000-4000-8000-000000000002",
  sourceId: "00000000-0000-4000-8000-000000000003",
  sourceVersion: 1,
  kind: "ADVERTISEMENT" as const,
  status: "READY" as const,
  revision: 1,
  originalFilename: "advertisement.mp4",
  contentType: "video/mp4" as const,
  sizeBytes: "1048576",
  sha256: "a".repeat(64),
  width: 1920,
  height: 1080,
  durationMs: 30_000,
  hasAudio: true,
  probeJobId: "00000000-0000-4000-8000-000000000004",
  probe: {
    attempt: 1,
    retryBudget: 3,
    revision: 1,
    state: "READY" as const,
    failure: null,
  },
  failure: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("MontageAssetCard", () => {
  it("shows a READY video preview and rounds duration for display", () => {
    const wrapper = mount(MontageAssetCard, {
      props: { asset: baseAsset, contentUrl: "/montage-content" },
      global: {
        stubs: {
          Card: { template: "<article><slot name='content' /></article>" },
          Tag: true,
        },
      },
    });
    expect(wrapper.get("video").attributes("src")).toBe("/montage-content");
    expect(wrapper.text()).toContain("00:00:30");
    expect(wrapper.text()).not.toContain(".000");
  });

  it("does not expose a preview when the probe failed", () => {
    const wrapper = mount(MontageAssetCard, {
      props: {
        asset: {
          ...baseAsset,
          status: "FAILED_FINAL",
          failure: {
            code: "INVALID_MP4",
            message: "Некорректный MP4.",
            retryable: false,
          },
        },
        contentUrl: "/montage-content",
      },
      global: {
        stubs: {
          Card: { template: "<article><slot name='content' /></article>" },
          Tag: true,
        },
      },
    });
    expect(wrapper.find("video").exists()).toBe(false);
    expect(wrapper.text()).toContain("Некорректный MP4.");
  });
});
