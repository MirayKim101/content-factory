import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

describe("MinIO API least-privilege policy", () => {
  it("keeps the bucket private and limits object access to source and editorial prefixes", async () => {
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

    expect(objectStatements).toHaveLength(2);
    expect(objectStatements.flatMap(({ Resource }) => Resource).sort()).toEqual(
      [
        "arn:aws:s3:::test-bucket/editorial/*",
        "arn:aws:s3:::test-bucket/sources/*",
      ],
    );
    expect(provision).toContain(
      'mc anonymous set none "local/$S3_SOURCE_BUCKET"',
    );
    expect(provision).not.toContain(
      '"Resource": ["arn:aws:s3:::$S3_SOURCE_BUCKET/*"]',
    );
  });
});
