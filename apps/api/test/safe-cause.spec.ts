import { describe, expect, it } from "vitest";

import { safeCause } from "../src/projects/application/safe-cause.js";

describe("safeCause", () => {
  it("keeps useful diagnostics and provider IDs without leaking messages or paths", () => {
    const error = new Error(
      "secret=value object=sources/project/source.mp4 /private/tmp/upload",
    ) as Error & {
      code: string;
      $metadata: {
        httpStatusCode: number;
        requestId: string;
        extendedRequestId: string;
      };
    };
    error.name = "S3ServiceException";
    error.code = "AccessDenied";
    error.$metadata = {
      httpStatusCode: 403,
      requestId: "AWS-REQUEST-123",
      extendedRequestId: "AWS-EXTENDED/456=",
    };
    error.stack = `${error.name}: ${error.message}\n    at uploadSource (/Users/person/project/source-upload.service.ts:42:7)\n    at handler (/private/tmp/secret-handler.ts:9:3)`;

    const result = safeCause(error);

    expect(result).toEqual({
      classification: "S3ServiceException",
      code: "AccessDenied",
      httpStatus: 403,
      providerRequestId: "AWS-REQUEST-123",
      providerExtendedRequestId: "AWS-EXTENDED/456=",
      stackFrames: [
        "at uploadSource (source-upload.service.ts:42:7)",
        "at handler (secret-handler.ts:9:3)",
      ],
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("secret=value");
    expect(serialized).not.toContain("sources/");
    expect(serialized).not.toContain("/Users/");
    expect(serialized).not.toContain("/private/tmp");
  });
});
