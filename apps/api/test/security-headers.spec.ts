import {
  Controller,
  Get,
  type INestApplication,
  Module,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureHttpSecurity } from "../src/http-security.js";

let app: INestApplication;

@Controller()
class ProbeController {
  @Get("health")
  health() {
    return { status: "ok" };
  }

  @Get("docs")
  docs() {
    return "documentation";
  }
}

@Module({ controllers: [ProbeController] })
class ProbeModule {}

beforeAll(async () => {
  app = await NestFactory.create(ProbeModule, { logger: false });
  configureHttpSecurity(app);
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("HTTP security headers", () => {
  it("protects API and documentation responses with a shared baseline", async () => {
    for (const path of ["/health", "/docs"]) {
      const response = await request(app.getHttpServer()).get(path).expect(200);
      expect(response.headers).toMatchObject({
        "cross-origin-opener-policy": "same-origin",
        "referrer-policy": "no-referrer",
        "strict-transport-security": "max-age=31536000; includeSubDomains",
        "x-content-type-options": "nosniff",
        "x-frame-options": "SAMEORIGIN",
      });
      expect(response.headers["content-security-policy"]).toContain(
        "default-src 'self'",
      );
    }
  });
});
