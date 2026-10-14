import "reflect-metadata";
import { createRequire } from "node:module";

import {
  Controller,
  Get,
  Module,
  Req,
  type INestApplication,
} from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { configureHttpSecurity } from "../src/http-security.js";

interface AddressRequest {
  ip?: string;
  ips: string[];
  protocol: string;
  secure: boolean;
  hostname: string;
  socket: { remoteAddress?: string };
}

@Controller("forwarding-proof")
class ForwardingProofController {
  @Get()
  address(@Req() incoming: AddressRequest) {
    return {
      ip: incoming.ip,
      peer: incoming.socket.remoteAddress,
      ips: incoming.ips,
      protocol: incoming.protocol,
      secure: incoming.secure,
      hostname: incoming.hostname,
    };
  }
}

@Module({ controllers: [ForwardingProofController] })
class ForwardingProofModule {}

type Trust = (address: string) => boolean;
interface ProxyAddress {
  (
    request: {
      socket: { remoteAddress: string };
      headers: { "x-forwarded-for": string };
    },
    trust: Trust,
  ): string;
  compile(subnet: string | string[]): Trust;
}

function isProxyAddress(value: unknown): value is ProxyAddress {
  return (
    typeof value === "function" &&
    "compile" in value &&
    typeof value.compile === "function"
  );
}

// Resolve through Nest's actual Express installation, not a new direct test
// dependency or a separately installed package that Express might not use.
const apiRequire = createRequire(import.meta.url);
const nestRequire = createRequire(
  apiRequire.resolve("@nestjs/platform-express"),
);
const expressRequire = createRequire(nestRequire.resolve("express"));
const dependency: unknown = expressRequire("proxy-addr");
if (!isProxyAddress(dependency))
  throw new Error("Unexpected Express proxy-addr module");
const proxyAddress = dependency;

describe("actual Nest/Express forwarding boundary", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await NestFactory.create(ForwardingProofModule, { logger: false });
    configureHttpSecurity(app);
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  it("keeps the production trust-proxy default disabled", () => {
    const instance: unknown = app.getHttpAdapter().getInstance();
    if (
      (typeof instance !== "object" && typeof instance !== "function") ||
      instance === null ||
      !("get" in instance) ||
      typeof instance.get !== "function"
    )
      throw new Error("Expected the actual Express application");
    expect(instance.get("trust proxy")).toBe(false);
  });

  it.each([
    "198.51.100.77",
    "198.51.100.77, 10.0.0.1",
    "::ffff:198.51.100.77, ::ffff:10.0.0.1",
    "not-an-address, unknown",
  ])(
    "does not trust spoofed HTTP forwarding metadata: %s",
    async (forwardedFor) => {
      const response = await request(app.getHttpServer())
        .get("/forwarding-proof")
        .set("Host", "content-factory.test")
        .set("Forwarded", "for=198.51.100.77;proto=https;host=attacker.test")
        .set("X-Forwarded-For", forwardedFor)
        .set("X-Forwarded-Host", "attacker.test")
        .set("X-Forwarded-Proto", "https")
        .expect(200);

      const body: unknown = response.body;
      expect(body).toEqual({
        ip: expect.any(String),
        peer: expect.any(String),
        ips: [],
        protocol: "http",
        secure: false,
        hostname: "content-factory.test",
      });
      if (
        body === null ||
        typeof body !== "object" ||
        !("ip" in body) ||
        !("peer" in body)
      ) {
        throw new Error("Malformed address probe response");
      }
      expect(body.ip).toBe(body.peer);
      expect(response.headers["x-content-type-options"]).toBe("nosniff");
    },
  );

  it("uses the reviewed compatible patch through Express's existing dependency range", () => {
    const expressManifest: unknown = expressRequire("./package.json");
    const proxyManifest: unknown = expressRequire("proxy-addr/package.json");
    expect(expressManifest).toMatchObject({
      version: "5.2.1",
      dependencies: { "proxy-addr": "^2.0.7" },
    });
    expect(proxyManifest).toMatchObject({ version: "2.0.8" });
  });
});

describe("CVE-2026-90711 regression in Express's actual address dependency", () => {
  // These pure dependency predicates intentionally exercise the vendor bug;
  // no application enables trust proxy or changes its authentication boundary.
  it.each(
    ["::ffff:10.0.0.0/8", "::/1", ["::ffff:10.0.0.0/8", "2001:db8::/32"]].map(
      (subnet) => ({ subnet }),
    ),
  )(
    "does not turn an IPv6 trust subnet into arbitrary IPv4 trust: $subnet",
    ({ subnet }) => {
      const trust = proxyAddress.compile(subnet);
      for (const peer of ["203.0.113.23", "::ffff:203.0.113.23"]) {
        expect(trust(peer)).toBe(false);
        expect(
          proxyAddress(
            {
              socket: { remoteAddress: peer },
              headers: { "x-forwarded-for": "198.51.100.77" },
            },
            trust,
          ),
        ).toBe(peer);
      }
    },
  );

  it.each(
    [
      "10.0.0.0/8",
      "::ffff:10.0.0.0/104",
      ["::ffff:10.0.0.0/104", "2001:db8::/32"],
    ].map((subnet) => ({ subnet })),
  )(
    "retains correct IPv4/mapped matching for explicit intended networks: $subnet",
    ({ subnet }) => {
      const trust = proxyAddress.compile(subnet);
      expect(trust("10.1.2.3")).toBe(true);
      expect(trust("::ffff:10.1.2.3")).toBe(true);
      expect(trust("203.0.113.23")).toBe(false);
      expect(trust("::ffff:203.0.113.23")).toBe(false);
      expect(trust("::a00:1")).toBe(false);
      expect(trust("not-an-address")).toBe(false);
    },
  );
});
