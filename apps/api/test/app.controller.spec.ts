import { describe, expect, it } from "vitest";

import { AppController } from "../src/app.controller.js";

describe("AppController", () => {
  it("reports that the API is healthy", () => {
    expect(new AppController().health()).toEqual({ status: "ok" });
  });
});
