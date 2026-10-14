import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const image = process.argv[2];
assert.match(image ?? "", /^content-factory-web-edge:diagnostic-[a-f0-9]+$/);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(root, "tmp", `web-edge-runtime-${randomUUID()}`);
await mkdir(output, { mode: 0o700 });
const prefix = `cf-edge-${randomUUID().slice(0, 8)}`;
const node =
  "node:24.15.0-bookworm-slim@sha256:4e6b70dd6cbfc88c8157ba19aa3d9f9cce6ba4703576d55459e45efcbc9c5f5d";
const fixture = resolve(root, "scripts/web-edge-runtime-fixture.mjs");
const safe = [
  "--read-only",
  "--user",
  "1000:1000",
  "--cap-drop",
  "ALL",
  "--security-opt",
  "no-new-privileges",
  "--pids-limit",
  "64",
  "--cpus",
  "1",
  "--memory",
  "192m",
  "--log-driver",
  "local",
  "--log-opt",
  "max-size=5m",
  "--log-opt",
  "max-file=2",
];
const docker = (...args) =>
  execFileSync("docker", args, { encoding: "utf8", timeout: 30000 }).trim();
let network = false;
const created = [];
const proof = {
  image,
  output,
  network: prefix,
  hostPorts: [],
  started: new Date().toISOString(),
};
try {
  docker("network", "create", "--internal", prefix);
  network = true;
  for (const [role, alias, containerImage, command, mounts] of [
    [
      "api",
      "api",
      node,
      ["node", "/fixture.mjs", "server"],
      ["--mount", `type=bind,src=${fixture},dst=/fixture.mjs,readonly`],
    ],
    ["edge", "edge", image, [], []],
  ]) {
    const name = `${prefix}-${role}`;
    docker(
      "run",
      "--detach",
      "--name",
      name,
      "--network",
      prefix,
      "--network-alias",
      alias,
      ...safe,
      ...mounts,
      containerImage,
      ...command,
    );
    created.push(name);
  }
  for (let i = 0; i < 30; i++) {
    const state = JSON.parse(docker("inspect", `${prefix}-edge`))[0].State;
    if (state.Status !== "running") throw Error("Edge stopped before liveness");
    if (state.Health?.Status === "healthy") break;
    if (i === 29) throw Error("Edge never became healthy");
    await new Promise((r) => setTimeout(r, 500));
  }
  proof.edgeInspection = JSON.parse(docker("inspect", `${prefix}-edge`))[0];
  assert.equal(proof.edgeInspection.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(proof.edgeInspection.HostConfig.PortBindings, {});
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      `${prefix}-client`,
      "--network",
      prefix,
      ...safe,
      "--mount",
      `type=bind,src=${fixture},dst=/fixture.mjs,readonly`,
      node,
      "node",
      "/fixture.mjs",
      "client",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  created.push(`${prefix}-client`);
  let stdout = "",
    stderr = "";
  child.stdout.on("data", (b) => {
    stdout += b;
    process.stdout.write(b);
  });
  child.stderr.on("data", (b) => {
    stderr += b;
    process.stderr.write(b);
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 150000);
  const code = await new Promise((r, j) => {
    child.on("error", j);
    child.on("exit", r);
  });
  clearTimeout(timer);
  proof.client = { code, stdout, stderr };
  assert.equal(code, 0, "Runtime fixture failed");
  proof.edgeMemory = docker(
    "exec",
    `${prefix}-edge`,
    "sh",
    "-ec",
    "cat /sys/fs/cgroup/memory.peak; cat /sys/fs/cgroup/memory.max",
  );
  assert.equal(proof.edgeInspection.State.OOMKilled, false);
  docker("stop", "--time", "2", `${prefix}-api`);
  const down = JSON.parse(
    docker(
      "run",
      "--rm",
      "--network",
      prefix,
      ...safe,
      node,
      "node",
      "--input-type=module",
      "-e",
      'const r=await fetch("http://edge:8080/api/v1/echo"); console.log(JSON.stringify({status:r.status,body:await r.text()}));',
    ),
  );
  assert.equal(down.status, 502);
  proof.upstreamDown = down;
  proof.status = "PASS";
} catch (error) {
  proof.status = "FAIL";
  proof.error = String(error);
  process.exitCode = 1;
} finally {
  for (const name of created.filter((n) => !n.endsWith("-client"))) {
    try {
      await writeFile(
        resolve(output, `${name}.log`),
        execFileSync("docker", ["logs", name], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
    } catch {}
  }
  for (const name of [...created].reverse()) {
    try {
      docker("rm", "--force", name);
    } catch {}
  }
  if (network) docker("network", "rm", prefix);
  proof.finished = new Date().toISOString();
  await writeFile(
    resolve(output, "runtime-proof.json"),
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({ output, status: proof.status, error: proof.error }),
  );
}
