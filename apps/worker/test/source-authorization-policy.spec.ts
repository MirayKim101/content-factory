import { describe, expect, it } from "vitest";

import { resolveWorkerSourceAuthorizationPolicy } from "../src/config.js";

describe("worker source authorization policy", () => {
  it("defaults missing and unknown values to manual", () => {
    expect(resolveWorkerSourceAuthorizationPolicy({})).toBe("manual");
    expect(
      resolveWorkerSourceAuthorizationPolicy({
        DEPLOYMENT_PROFILE: "preview",
        SOURCE_AUTHORIZATION_POLICY: "automatic",
        API_HOST: "0.0.0.0",
      }),
    ).toBe("manual");
  });

  it.each(["127.0.0.1", "localhost", "::1"])(
    "allows local-auto on exact loopback host %s",
    (apiHost) => {
      expect(
        resolveWorkerSourceAuthorizationPolicy({
          DEPLOYMENT_PROFILE: "local",
          SOURCE_AUTHORIZATION_POLICY: "local-auto",
          API_HOST: apiHost,
        }),
      ).toBe("local-auto");
    },
  );

  it.each([
    { DEPLOYMENT_PROFILE: "production", API_HOST: "127.0.0.1" },
    { DEPLOYMENT_PROFILE: "local", API_HOST: "0.0.0.0" },
    { DEPLOYMENT_PROFILE: "local", API_HOST: "localhost.example.com" },
  ])("rejects unsafe local-auto config %#", (environment) => {
    expect(() =>
      resolveWorkerSourceAuthorizationPolicy({
        ...environment,
        SOURCE_AUTHORIZATION_POLICY: "local-auto",
      }),
    ).toThrow("CONFIG_SOURCE_AUTHORIZATION_LOCAL_AUTO_UNSAFE");
  });
});
