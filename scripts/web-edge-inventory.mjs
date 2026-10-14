import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  approvedInput,
  captureOutput,
  isolationArgs,
  sha256File,
} from "./scan-oci-artifact.mjs";

const [image, archiveInput] = process.argv.slice(2);
assert.equal(typeof archiveInput, "string");
assert.equal(
  /(?:^|\/)(?:seanova(?:-new)?|dockerserver)(?:\/|$)/i.test(
    resolve(archiveInput).normalize("NFD").replace(/\p{M}/gu, ""),
  ),
  false,
);
assert.match(image ?? "", /^content-factory-web-edge:diagnostic-[a-f0-9]+$/);
const archive = await approvedInput(archiveInput);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = await mkdtemp(resolve(root, "tmp/web-edge-inventory-"));
const emptyDb = resolve(output, "unused-empty-db");
await mkdir(emptyDb);
const inventory = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "64",
    "--memory",
    "192m",
    image,
    "sh",
    "-ec",
    'caddy version; sha256sum /usr/bin/caddy; cat /etc/alpine-release; caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile; for x in node npm pnpm yarn; do if command -v "$x"; then exit 1; fi; done; test ! -d /workspace; test ! -d /usr/share/caddy/node_modules; cat /lib/apk/db/installed',
  ],
  { encoding: "utf8", timeout: 30000 },
);
await writeFile(resolve(output, "native-inventory.txt"), inventory);
const publicFlags = execFileSync(
  "docker",
  [
    "run",
    "--rm",
    "--network",
    "none",
    "--read-only",
    "--user",
    "1000:1000",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "192m",
    "--pids-limit",
    "64",
    image,
    "sh",
    "-ec",
    'busybox grep -o "apiBasePath[^,}]*\\|aiContextEnabled[^,}]*\\|editorialFramesEnabled[^,}]*" /usr/share/caddy/index.html',
  ],
  { encoding: "utf8", timeout: 30000 },
);
assert.match(publicFlags, /apiBasePath:"\/api\/v1"/);
assert.match(publicFlags, /aiContextEnabled:false/);
assert.match(publicFlags, /editorialFramesEnabled:false/);
const pins = JSON.parse(
  await readFile(new URL("./artifact-scan-pins.json", import.meta.url), "utf8"),
);
const name = `cf-web-edge-sbom-${randomUUID()}`;
const file = await open(resolve(output, "sbom.spdx.json"), "wx", 0o600);
try {
  const child = spawn(
    "docker",
    [
      ...isolationArgs(archive, emptyDb),
      "--name",
      name,
      "--env",
      "SYFT_CHECK_FOR_APP_UPDATE=false",
      "--env",
      "XDG_CACHE_HOME=/cache",
      pins.syft.image,
      "--from",
      "oci-archive",
      "/input/artifact.oci.tar",
      "--platform",
      "linux/amd64",
      "--output",
      "spdx-json",
    ],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 180000);
  const exited = new Promise((r, j) => {
    child.on("error", j);
    child.on("exit", r);
  });
  try {
    await captureOutput(child.stdout, file);
    assert.equal(await exited, 0);
  } finally {
    clearTimeout(timer);
  }
} finally {
  await file.close();
  execFileSync("docker", ["rm", "--force", name], { stdio: "ignore" });
}
const sbom = JSON.parse(
  await readFile(resolve(output, "sbom.spdx.json"), "utf8"),
);
const caddy = sbom.packages.filter((p) => p.name?.includes("caddy"));
const proof = {
  image,
  publicFlags,
  caddyVersion: inventory.split("\n")[0],
  caddyBinarySha256: inventory.split("\n")[1].split(/\s+/)[0],
  alpineVersion: inventory.split("\n")[2],
  archiveSha256: await sha256File(archive),
  sbomSha256: await sha256File(resolve(output, "sbom.spdx.json")),
  nativeInventorySha256: await sha256File(
    resolve(output, "native-inventory.txt"),
  ),
  caddy,
  packageCount: sbom.packages.length,
  fileCount: sbom.files?.length,
  promotionApproved: false,
  vulnerabilityScan: "not performed by inventory step",
};
await writeFile(
  resolve(output, "inventory-proof.json"),
  `${JSON.stringify(proof, null, 2)}\n`,
);
console.log(JSON.stringify({ output, ...proof }));
