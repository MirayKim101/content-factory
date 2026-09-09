import { BadRequestException } from "@nestjs/common";
import { describe, expect, it } from "vitest";

import {
  decodeProjectListCursor,
  encodeProjectListCursor,
} from "../src/projects/presentation/project-list-cursor.js";

describe("project list cursor", () => {
  it("round-trips the stable createdAt and id tuple", () => {
    const cursor = {
      createdAt: new Date("2026-09-02T03:04:05.678Z"),
      id: "00000000-0000-4000-8000-000000000042",
    };

    expect(decodeProjectListCursor(encodeProjectListCursor(cursor))).toEqual(
      cursor,
    );
  });

  it.each([
    "not+base64url",
    Buffer.from("{}", "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(["not-a-date", "not-a-uuid"]), "utf8").toString(
      "base64url",
    ),
    Buffer.from(
      JSON.stringify([
        "2026-09-02T03:04:05.678+00:00",
        "00000000-0000-4000-8000-000000000042",
      ]),
      "utf8",
    ).toString("base64url"),
  ])("rejects malformed cursor %s", (value) => {
    expect(() => decodeProjectListCursor(value)).toThrow(BadRequestException);
  });
});
