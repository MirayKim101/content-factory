import type { INestApplication } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";

import {
  API_SHUTDOWN_SIGNALS,
  enableApiShutdownHooks,
} from "../src/http-lifecycle.js";

describe("API HTTP lifecycle", () => {
  it("enables bounded production shutdown signals", () => {
    const enableShutdownHooks = vi.fn();
    const app = { enableShutdownHooks } as unknown as INestApplication;

    enableApiShutdownHooks(app);

    expect(API_SHUTDOWN_SIGNALS).toEqual(["SIGINT", "SIGTERM"]);
    expect(enableShutdownHooks).toHaveBeenCalledWith(["SIGINT", "SIGTERM"]);
  });
});
