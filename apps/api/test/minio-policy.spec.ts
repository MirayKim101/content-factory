import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("MinIO API least-privilege policy", () => {
  it("keeps the bucket private and limits object access to owned prefixes", async () => {
    const provision = await readFile(
      new URL("../../../infrastructure/minio/provision", import.meta.url),
      "utf8",
    );
    const policyTemplate = provision.match(
      /cat >"\$policy_file" <<EOF\n([\s\S]*?)\nEOF/,
    )?.[1];
    expect(policyTemplate).toBeDefined();
    const policy = JSON.parse(
      policyTemplate!.replaceAll("$S3_SOURCE_BUCKET", "test-bucket"),
    ) as {
      Statement: Array<{ Action: string[]; Resource: string[] }>;
    };
    const bucketResource = "arn:aws:s3:::test-bucket";
    const bucketActions = [
      "s3:GetBucketLocation",
      "s3:ListBucket",
      "s3:ListBucketMultipartUploads",
    ];
    const expectedObjectActions = [
      "s3:AbortMultipartUpload",
      "s3:DeleteObject",
      "s3:GetObject",
      "s3:ListMultipartUploadParts",
      "s3:PutObject",
    ];
    expect(policy.Statement).toHaveLength(6);
    const bucketStatements = policy.Statement.filter(
      (statement) =>
        statement.Resource.length === 1 &&
        statement.Resource[0] === bucketResource,
    );
    expect(bucketStatements).toHaveLength(1);
    expect([...bucketStatements[0]!.Action].sort()).toEqual(bucketActions);

    const objectStatements = policy.Statement.filter(
      (statement) => statement !== bucketStatements[0],
    );
    const objectResources = objectStatements
      .flatMap(({ Resource }) => Resource)
      .sort();
    expect(objectStatements).toHaveLength(5);
    for (const statement of objectStatements)
      expect([...statement.Action].sort()).toEqual(expectedObjectActions);
    expect(objectResources).toEqual([
      "arn:aws:s3:::test-bucket/ai-content/creator-profiles/*/references/*",
      "arn:aws:s3:::test-bucket/ai-content/frame-evidence/*/attempts/*/frames/*",
      "arn:aws:s3:::test-bucket/ai-content/image-suggestions/*/candidate.png",
      "arn:aws:s3:::test-bucket/ai-content/transcripts/*/transcript.json",
      "arn:aws:s3:::test-bucket/editorial/*",
      "arn:aws:s3:::test-bucket/sources/*",
    ]);
    expect(
      objectResources.some((resource) =>
        resourceAllows(
          resource,
          "arn:aws:s3:::test-bucket/ai-content/frame-evidence/intent-1/attempts/2/frames/0",
        ),
      ),
    ).toBe(true);
    expect(
      objectResources.some((resource) =>
        resourceAllows(
          resource,
          "arn:aws:s3:::test-bucket/ai-content/unrelated-denied-probe",
        ),
      ),
    ).toBe(false);
    expect(
      objectResources.some((resource) =>
        resourceAllows(
          resource,
          "arn:aws:s3:::test-bucket/ai-content/frame-evidence/intent-1/attempts/2/unrelated/0",
        ),
      ),
    ).toBe(false);
    expect(provision).toContain(
      'mc anonymous set none "local/$S3_SOURCE_BUCKET"',
    );
    expect(provision).not.toContain(
      '"Resource": ["arn:aws:s3:::$S3_SOURCE_BUCKET/*"]',
    );
  });
});

function resourceAllows(resource: string, target: string): boolean {
  const expression = resource
    .split("*")
    .map((part) => part.replace(/[|\\{}()[\]^$+?.]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${expression}$`).test(target);
}
