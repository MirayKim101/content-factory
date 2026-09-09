import { describe, expect, it } from "vitest";

import { resolveSourceAuthorizationRuntime } from "../src/config/environment.js";
import { isSourceAuthorizationCleared } from "../src/projects/domain/source-authorization.js";

const localAuthorization = {
  sourceVersion: 1,
  status: "CLEARED" as const,
  basis: "LOCAL_DEVELOPMENT_AUTO" as const,
  declarationVersion: "local-development-auto-v1",
  decidedAt: new Date("2026-09-02T08:00:00.000Z"),
  revision: 2,
};

describe("source authorization runtime policy", () => {
  it("defaults missing and unknown values to manual", () => {
    expect(resolveSourceAuthorizationRuntime({})).toEqual({
      deploymentProfile: "other",
      policy: "manual",
      apiHost: "127.0.0.1",
    });
    expect(
      resolveSourceAuthorizationRuntime({
        DEPLOYMENT_PROFILE: "preview",
        SOURCE_AUTHORIZATION_POLICY: "automatic",
        API_HOST: "0.0.0.0",
      }),
    ).toEqual({
      deploymentProfile: "other",
      policy: "manual",
      apiHost: "0.0.0.0",
    });
  });

  it.each(["127.0.0.1", "localhost", "::1"])(
    "allows local-auto only on exact loopback host %s",
    (apiHost) => {
      expect(
        resolveSourceAuthorizationRuntime({
          DEPLOYMENT_PROFILE: "local",
          SOURCE_AUTHORIZATION_POLICY: "local-auto",
          API_HOST: apiHost,
        }),
      ).toEqual({
        deploymentProfile: "local",
        policy: "local-auto",
        apiHost,
      });
    },
  );

  it.each([
    { DEPLOYMENT_PROFILE: "production", API_HOST: "127.0.0.1" },
    { DEPLOYMENT_PROFILE: "local", API_HOST: "0.0.0.0" },
    { DEPLOYMENT_PROFILE: "local", API_HOST: "127.0.0.1.example.com" },
  ])("rejects unsafe local-auto startup config %#", (environment) => {
    expect(() =>
      resolveSourceAuthorizationRuntime({
        ...environment,
        SOURCE_AUTHORIZATION_POLICY: "local-auto",
      }),
    ).toThrow("CONFIG_SOURCE_AUTHORIZATION_LOCAL_AUTO_UNSAFE");
  });

  it("recognizes local evidence only while local-auto is active", () => {
    expect(isSourceAuthorizationCleared(localAuthorization, 1, "manual")).toBe(
      false,
    );
    expect(
      isSourceAuthorizationCleared(localAuthorization, 1, "local-auto"),
    ).toBe(true);
    expect(
      isSourceAuthorizationCleared(
        { ...localAuthorization, sourceVersion: 2 },
        1,
        "local-auto",
      ),
    ).toBe(false);
  });

  it.each(["LEGACY_ATTESTATION", "OPERATOR_ATTESTATION"] as const)(
    "keeps %s evidence valid in manual policy",
    (basis) => {
      expect(
        isSourceAuthorizationCleared(
          { ...localAuthorization, basis },
          1,
          "manual",
        ),
      ).toBe(true);
    },
  );
});
