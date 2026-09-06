import { describe, expect, it } from "vitest";

import {
  aiContextAdmissionEnabled,
  editorialExportAdmissionEnabled,
} from "../src/config/environment.js";

describe("editorial export rollout flag", () => {
  it.each([
    [{}, false],
    [{ EDITORIAL_EXPORT_ENABLED: "0" }, false],
    [{ EDITORIAL_EXPORT_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(editorialExportAdmissionEnabled(environment)).toBe(expected);
  });
});

describe("creator context rollout flag", () => {
  it.each([
    [{}, false],
    [{ AI_CONTEXT_ENABLED: "0" }, false],
    [{ AI_CONTEXT_ENABLED: "1" }, true],
  ] as const)("resolves %o to %s", (environment, expected) => {
    expect(aiContextAdmissionEnabled(environment)).toBe(expected);
  });
});
