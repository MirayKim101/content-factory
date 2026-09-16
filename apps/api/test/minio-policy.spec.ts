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
    const objectStatements = policy.Statement.filter((statement) =>
      statement.Action.includes("s3:GetObject"),
    );

    const objectResources = objectStatements
      .flatMap(({ Resource }) => Resource)
      .sort();
    expect(objectStatements).toHaveLength(3);
    expect(objectResources).toEqual([
      "arn:aws:s3:::test-bucket/ai-content/creator-profiles/*/references/*",
      "arn:aws:s3:::test-bucket/editorial/*",
      "arn:aws:s3:::test-bucket/sources/*",
    ]);
    expect(
      objectResources.some((resource) =>
        resourceAllows(
          resource,
          "arn:aws:s3:::test-bucket/ai-content/unrelated-denied-probe",
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
