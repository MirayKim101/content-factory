import { describe, expect, it } from "vitest";

import {
  parseOrderedTags,
  validateThumbnailFile,
} from "~/features/edit-editorial-package/model/editorial-package-form";
import {
  idempotencyForEditorialOperation,
  idempotencyForEditorialSave,
  thumbnailFileFingerprint,
  thumbnailUploadFingerprint,
} from "~/features/edit-editorial-package/model/save-identity";

describe("manual editorial package form", () => {
  it("keeps tag order and removes only blank tag rows", () => {
    expect(parseOrderedTags(" first \n\nsecond\n third ")).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("rejects unsupported and over-limit thumbnail files before upload", () => {
    expect(
      validateThumbnailFile(
        new File(["x"], "cover.svg", { type: "image/svg+xml" }),
      ),
    ).toContain("JPEG");
    expect(
      validateThumbnailFile(
        new File([new Uint8Array(10 * 1024 * 1024 + 1)], "cover.png", {
          type: "image/png",
        }),
      ),
    ).toContain("10 МиБ");
    expect(
      validateThumbnailFile(
        new File(["x"], "cover.webp", { type: "image/webp" }),
      ),
    ).toBeUndefined();
  });

  it("reuses the idempotency key only for the exact same save payload", () => {
    const body = {
      expectedRevision: 2,
      processingTemplateRevisionId: "00000000-0000-4000-8000-000000000001",
      title: "Title",
      description: "Description",
      tags: ["first", "second"],
      thumbnailAssetId: null,
    };
    const first = idempotencyForEditorialSave(
      undefined,
      body,
      () => "first-key",
    );
    expect(
      idempotencyForEditorialSave(first, body, () => "second-key"),
    ).toEqual(first);
    expect(
      idempotencyForEditorialSave(
        first,
        { ...body, expectedRevision: 3 },
        () => "second-key",
      ).key,
    ).toBe("second-key");
  });

  it("reuses operation keys only for the same template or thumbnail bytes", async () => {
    const template = idempotencyForEditorialOperation(
      undefined,
      "template:Manual",
      () => "template-key",
    );
    expect(
      idempotencyForEditorialOperation(
        template,
        "template:Manual",
        () => "other",
      ),
    ).toEqual(template);
    const first = await thumbnailFileFingerprint(
      new File(["same bytes"], "first.png", { type: "image/png" }),
    );
    const second = await thumbnailFileFingerprint(
      new File(["same bytes"], "second.png", { type: "image/png" }),
    );
    expect(first).toBe(second);
    expect(
      await thumbnailUploadFingerprint(
        "project-a",
        new File(["same bytes"], "cover.png", { type: "image/png" }),
      ),
    ).not.toBe(
      await thumbnailUploadFingerprint(
        "project-a",
        new File(["same bytes"], "renamed.png", { type: "image/png" }),
      ),
    );
  });
});
