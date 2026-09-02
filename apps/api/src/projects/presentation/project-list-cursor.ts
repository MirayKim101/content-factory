import { BadRequestException } from "@nestjs/common";

import type { ProjectListCursor } from "../domain/project.js";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

export function encodeProjectListCursor(cursor: ProjectListCursor): string {
  return Buffer.from(
    JSON.stringify([cursor.createdAt.toISOString(), cursor.id]),
    "utf8",
  ).toString("base64url");
}

export function decodeProjectListCursor(value: string): ProjectListCursor {
  try {
    if (!BASE64URL_PATTERN.test(value) || value.length > 512) {
      throw new Error("invalid base64url");
    }
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    if (Buffer.from(decoded, "utf8").toString("base64url") !== value) {
      throw new Error("non-canonical base64url");
    }
    const tuple: unknown = JSON.parse(decoded);
    if (
      !Array.isArray(tuple) ||
      tuple.length !== 2 ||
      typeof tuple[0] !== "string" ||
      typeof tuple[1] !== "string" ||
      !UUID_PATTERN.test(tuple[1])
    ) {
      throw new Error("invalid cursor tuple");
    }
    const createdAt = new Date(tuple[0]);
    if (
      !Number.isFinite(createdAt.getTime()) ||
      createdAt.toISOString() !== tuple[0]
    ) {
      throw new Error("invalid cursor timestamp");
    }
    return { createdAt, id: tuple[1] };
  } catch {
    throw new BadRequestException({
      code: "INVALID_CURSOR",
      message: "The project list cursor is invalid.",
    });
  }
}
