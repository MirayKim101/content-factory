import { Module, type INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReadinessController } from "../src/readiness/readiness.controller.js";
import {
  READINESS_RESOURCE_FACTORY,
  type ReadinessResourceFactoryPort,
  type ReadinessResources,
} from "../src/readiness/readiness.resources.js";
import { ReadinessService } from "../src/readiness/readiness.service.js";

function resources(available: boolean): ReadinessResources {
  return {
    postgres: {
      async connect() {
        return {
          async query() {
            if (!available) throw new Error("POSTGRES_UNAVAILABLE");
          },
          release() {},
        };
      },
      async end() {},
    },
    redis: {
      client: Promise.resolve({
        async info() {
          if (!available) throw new Error("REDIS_UNAVAILABLE");
          return "# Server";
        },
      }),
      async close() {},
    },
    s3: {
      async send() {
        if (!available) throw new Error("S3_UNAVAILABLE");
      },
      destroy() {},
    },
    sourceBucket: "content-factory-readiness-test",
  };
}

let app: INestApplication;
let available = true;

const fixtureFactory: ReadinessResourceFactoryPort = {
  create: () => resources(available),
};

@Module({
  controllers: [ReadinessController],
  providers: [
    ReadinessService,
    { provide: READINESS_RESOURCE_FACTORY, useValue: fixtureFactory },
  ],
})
class ReadinessHttpFixtureModule {}

beforeAll(async () => {
  app = await NestFactory.create(ReadinessHttpFixtureModule, { logger: false });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe("GET /api/v1/readiness", () => {
  it("returns the documented ready response without caching", async () => {
    available = true;
    const response = await request(app.getHttpServer())
      .get("/api/v1/readiness")
      .expect(200);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({ status: "ready" });
  });

  it("returns the generic unavailable envelope without dependency details", async () => {
    available = false;
    const response = await request(app.getHttpServer())
      .get("/api/v1/readiness")
      .expect(503);

    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      error: {
        code: "DEPENDENCIES_UNAVAILABLE",
        message: "Required dependencies are unavailable.",
      },
    });
    expect(JSON.stringify(response.body)).not.toContain("POSTGRES");
  });

  it("rechecks isolated dependencies after a failure and recovers", async () => {
    available = false;
    await request(app.getHttpServer()).get("/api/v1/readiness").expect(503);

    available = true;
    const response = await request(app.getHttpServer())
      .get("/api/v1/readiness")
      .expect(200);

    expect(response.body).toEqual({ status: "ready" });
  });
});
