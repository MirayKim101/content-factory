import type { IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Controller,
  Module,
  Post,
  UseInterceptors,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FileInterceptor } from "@nestjs/platform-express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  browserWriteAllowed,
  browserWriteOrigins,
} from "../src/browser-write-policy.js";
import { configureHttpSecurity } from "../src/http-security.js";

const origin = "http://127.0.0.1:3100";
const allowed = browserWriteOrigins(origin);
function message(headers: string[], method = "POST"): IncomingMessage {
  return { method, rawHeaders: headers } as IncomingMessage;
}

describe("explicit browser-write policy", () => {
  it("canonicalizes origins and default ports without trusting request hosts", () => {
    expect([
      ...browserWriteOrigins("https://EXAMPLE.test:443,http://example.test:80"),
    ]).toEqual(["https://example.test", "http://example.test"]);
    expect(
      browserWriteAllowed(
        message(["Origin", "https://example.test:443"]),
        browserWriteOrigins("https://example.test"),
      ),
    ).toBe(true);
    expect(browserWriteOrigins(undefined).size).toBe(0);
    expect(browserWriteOrigins("").size).toBe(0);
  });

  it.each([
    "*",
    "null",
    "file:///tmp",
    "https://*.example.test",
    "https://user:pass@example.test",
    "https://@example.test",
    "https://:@example.test",
    "https://example.test/",
    "https://example.test/path",
    "https://example.test?x=1",
    "https://example.test#x",
    "https://example.test,",
    "https://example.test,https://EXAMPLE.test:443",
    "https://exa%6dple.test",
    "https://example.test\\evil",
    "https://example.test https://other.test",
  ])("rejects invalid configuration %s", (value) => {
    expect(() => browserWriteOrigins(value)).toThrow(
      "CONFIG_API_BROWSER_ORIGINS_INVALID",
    );
  });

  it("bounds configuration size and list length", () => {
    expect(() => browserWriteOrigins("https://" + "a".repeat(4096))).toThrow();
    expect(() =>
      browserWriteOrigins(
        Array.from(
          { length: 33 },
          (_, index) => `https://host${index}.test`,
        ).join(","),
      ),
    ).toThrow();
  });

  it.each(["GET", "HEAD", "OPTIONS"])(
    "preserves read-only %s without provenance",
    (method) => {
      expect(browserWriteAllowed(message([], method), allowed)).toBe(true);
    },
  );

  it.each(["POST", "PUT", "PATCH", "DELETE", "PROPFIND"])(
    "denies unqualified unsafe %s",
    (method) => {
      expect(browserWriteAllowed(message([], method), allowed)).toBe(false);
    },
  );

  it.each([
    "null",
    "https://attacker.test",
    "http://127.0.0.1:3101",
    "http://127.0.0.1:3100.attacker.test",
    "http://127.0.0.1:3100/",
    "http://user@127.0.0.1:3100",
    "http://@127.0.0.1:3100",
    "http://127.0.0.1:3100 http://attacker.test",
  ])("rejects origin %s even with native marker", (value) => {
    expect(
      browserWriteAllowed(
        message(["Origin", value, "X-Content-Factory-Client", "native-v1"]),
        allowed,
      ),
    ).toBe(false);
  });

  it("requires explicit configured browser origin, never Host or forwarding", () => {
    const forged = [
      "Origin",
      "https://attacker.test",
      "Host",
      "127.0.0.1:3100",
      "Forwarded",
      "host=127.0.0.1:3100",
      "X-Forwarded-Host",
      "127.0.0.1:3100",
      "X-Forwarded-Proto",
      "http",
    ];
    expect(browserWriteAllowed(message(forged), allowed)).toBe(false);
    expect(
      browserWriteAllowed(
        message(["Origin", origin]),
        browserWriteOrigins(undefined),
      ),
    ).toBe(false);
    expect(browserWriteAllowed(message(["Origin", origin]), allowed)).toBe(
      true,
    );
  });

  it.each(["cross-site", "none", "unknown", "same-origin, same-site", ""])(
    "rejects hostile/unknown Fetch Metadata %s",
    (site) => {
      expect(
        browserWriteAllowed(
          message(["Origin", origin, "Sec-Fetch-Site", site]),
          allowed,
        ),
      ).toBe(false);
    },
  );

  it.each(["same-origin", "same-site"])(
    "requires origin in addition to %s",
    (site) => {
      expect(
        browserWriteAllowed(
          message(["Origin", origin, "Sec-Fetch-Site", site]),
          allowed,
        ),
      ).toBe(true);
      expect(
        browserWriteAllowed(
          message(["Origin", "https://sibling.test", "Sec-Fetch-Site", site]),
          allowed,
        ),
      ).toBe(false);
      expect(
        browserWriteAllowed(
          message([
            "Sec-Fetch-Site",
            site,
            "X-Content-Factory-Client",
            "native-v1",
          ]),
          allowed,
        ),
      ).toBe(false);
    },
  );

  it("rejects duplicate provenance and duplicate native markers", () => {
    expect(
      browserWriteAllowed(
        message(["Origin", origin, "oRiGiN", origin]),
        allowed,
      ),
    ).toBe(false);
    expect(
      browserWriteAllowed(
        message([
          "Origin",
          origin,
          "Sec-Fetch-Site",
          "same-origin",
          "sec-fetch-site",
          "same-origin",
        ]),
        allowed,
      ),
    ).toBe(false);
    expect(
      browserWriteAllowed(
        message([
          "X-Content-Factory-Client",
          "native-v1",
          "x-content-factory-client",
          "native-v1",
        ]),
        allowed,
      ),
    ).toBe(false);
  });

  it("native opt-in is exact and cannot override any browser provenance", () => {
    const marker = ["X-Content-Factory-Client", "native-v1"];
    expect(browserWriteAllowed(message(marker), new Set())).toBe(true);
    expect(
      browserWriteAllowed(
        message([...marker, "Sec-Fetch-Mode", "cors"]),
        new Set(),
      ),
    ).toBe(true);
    expect(
      browserWriteAllowed(
        message([
          ...marker,
          "Sec-Fetch-Mode",
          "cors",
          "Sec-Fetch-Mode",
          "cors",
        ]),
        allowed,
      ),
    ).toBe(false);
    expect(
      browserWriteAllowed(
        message([...marker, "Sec-Fetch-Mode", "navigate"]),
        allowed,
      ),
    ).toBe(false);
    expect(
      browserWriteAllowed(
        message(["X-Content-Factory-Client", "native-v2"]),
        allowed,
      ),
    ).toBe(false);
    for (const header of [
      "Referer",
      "Sec-Fetch-Mode",
      "Sec-Fetch-Dest",
      "Sec-Fetch-User",
      "Sec-Fetch-Unknown",
    ]) {
      expect(
        browserWriteAllowed(message([...marker, header, ""]), allowed),
      ).toBe(false);
    }
  });

  it("does not treat Node transport mode as a native credential", () => {
    expect(
      browserWriteAllowed(message(["Sec-Fetch-Mode", "cors"]), allowed),
    ).toBe(false);
    for (const header of ["Sec-Fetch-Site", "Referer", "Sec-Fetch-Unknown"]) {
      expect(
        browserWriteAllowed(
          message([
            "X-Content-Factory-Client",
            "native-v1",
            "Sec-Fetch-Mode",
            "cors",
            header,
            "same-origin",
          ]),
          allowed,
        ),
      ).toBe(false);
    }
  });
});

describe("actual Nest/Express boundary precedes parsing and multipart effects", () => {
  let app: INestApplication;
  let directory: string;
  let calls = 0;
  let parsed = 0;
  const previous = process.env.API_BROWSER_ORIGINS;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "cf-browser-write-test-"));
    @Controller("probe")
    class ProbeController {
      @Post("json")
      json() {
        calls += 1;
        return { ok: true };
      }
      @Post("upload")
      @UseInterceptors(
        FileInterceptor("file", {
          dest: directory,
          limits: { fileSize: 1024, files: 1, fields: 0, parts: 1 },
        }),
      )
      upload() {
        calls += 1;
        return { ok: true };
      }
    }
    @Module({ controllers: [ProbeController] })
    class ProbeModule {}
    process.env.API_BROWSER_ORIGINS = origin;
    app = await NestFactory.create(ProbeModule, { logger: false });
    configureHttpSecurity(app);
    app.use((_req: unknown, _res: unknown, next: () => void) => {
      parsed += 1;
      next();
    });
    await app.listen(0, "127.0.0.1");
  });
  afterAll(async () => {
    await app?.close();
    await rm(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.API_BROWSER_ORIGINS;
    else process.env.API_BROWSER_ORIGINS = previous;
  });

  it("denies malformed JSON before parsing or any later middleware", async () => {
    const before = { calls, parsed };
    const response = await request(app.getHttpServer())
      .post("/probe/json")
      .set("Origin", "https://attacker.test")
      .set("Content-Type", "application/json")
      .send("{")
      .expect(403);
    expect(response.body.error.code).toBe("BROWSER_WRITE_FORBIDDEN");
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect({ calls, parsed }).toEqual(before);
    expect(response.text).not.toContain("attacker");
  });

  it("denies a cross-site multipart form before disk staging/handler", async () => {
    const before = { calls, parsed };
    await request(app.getHttpServer())
      .post("/probe/upload")
      .set("Origin", origin)
      .set("Sec-Fetch-Site", "cross-site")
      .attach("file", Buffer.from("media"), "fixture.mp4")
      .expect(403);
    expect({ calls, parsed }).toEqual(before);
    expect(await readdir(directory)).toEqual([]);
  });

  it("denies duplicate actual Origin headers", async () => {
    const before = calls;
    await request(app.getHttpServer())
      .post("/probe/json")
      .set({ Origin: [origin, origin] })
      .send({})
      .expect(403);
    expect(calls).toBe(before);
  });

  it("accepts genuine configured browser JSON and multipart", async () => {
    await request(app.getHttpServer())
      .post("/probe/json")
      .set("Origin", origin)
      .set("Sec-Fetch-Site", "same-origin")
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post("/probe/upload")
      .set("Origin", origin)
      .set("Sec-Fetch-Site", "same-origin")
      .attach("file", Buffer.from("media"), "fixture.mp4")
      .expect(201);
    expect(await readdir(directory)).toHaveLength(1);
  });

  it("preserves explicit native JSON and keeps trust proxy disabled", async () => {
    await request(app.getHttpServer())
      .post("/probe/json")
      .set("X-Content-Factory-Client", "native-v1")
      .send({})
      .expect(201);
    expect(app.getHttpAdapter().getInstance().get("trust proxy")).toBe(false);
  });

  it("supports the real Node fetch transport used by native diagnostic clients", async () => {
    const address = app.getHttpServer().address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${address.port}/probe/json`,
      {
        method: "POST",
        headers: {
          "X-Content-Factory-Client": "native-v1",
          "Content-Type": "application/json",
        },
        body: "{}",
        signal: AbortSignal.timeout(2000),
      },
    );
    await response.text();
    expect(response.status).toBe(201);
  });
});
