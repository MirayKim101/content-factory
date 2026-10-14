import supertest from "supertest";

/** Explicit native-client contract; never used by browser adapters. */
export default function nativeApiRequest(
  server: Parameters<typeof supertest>[0],
) {
  return supertest.agent(server).set("X-Content-Factory-Client", "native-v1");
}
