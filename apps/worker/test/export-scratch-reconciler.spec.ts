import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MediaJobRepository } from "../src/application/ports.js";
import { ExportScratchReconciler } from "../src/infrastructure/export-scratch-reconciler.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("export scratch reconciliation", () => {
  it("preserves another worker active lease and removes only confirmed expired orphan after grace", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-export-reconcile-"));
    roots.push(root);
    const active = await marker(root, 7_000n, Date.now() - 120_000);
    const orphan = await marker(root, 9_000n, Date.now() - 120_000);
    const malformed = join(root, "export-unrecognized");
    await mkdir(malformed);
    await writeFile(join(malformed, "attempt.json"), "{}\n");
    const repository = {
      listActiveExportScratchReservations: vi.fn(async () => []),
      inspectExportScratchLease: vi.fn(async ({ directoryName }) =>
        directoryName === active.name ? "ACTIVE" : "INACTIVE",
      ),
      clearReconciledExportScratch: vi.fn(async () => undefined),
    } as unknown as MediaJobRepository;
    const reconciler = new ExportScratchReconciler(repository, root, 30_000);
    expect(await reconciler.reconcile()).toBe(7_000n);
    expect((await stat(join(root, active.name))).isDirectory()).toBe(true);
    await expect(stat(join(root, orphan.name))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await stat(malformed)).isDirectory()).toBe(true);
    expect(repository.clearReconciledExportScratch).toHaveBeenCalledTimes(1);
  });

  it("keeps recognized scratch when PostgreSQL outcome is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-export-reconcile-"));
    roots.push(root);
    const value = await marker(root, 5_000n, Date.now() - 120_000);
    const repository = {
      listActiveExportScratchReservations: vi.fn(async () => []),
      inspectExportScratchLease: vi.fn(async () => "UNKNOWN"),
      clearReconciledExportScratch: vi.fn(async () => undefined),
    } as unknown as MediaJobRepository;
    expect(
      await new ExportScratchReconciler(repository, root, 30_000).reconcile(),
    ).toBe(5_000n);
    expect(
      JSON.parse(
        await readFile(join(root, value.name, "attempt.json"), "utf8"),
      ),
    ).toMatchObject({
      reservedBytes: "5000",
    });
  });

  it("rebuilds accounting after SIGKILL before upload, preserves the active lease, then removes the expired orphan", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-export-reconcile-"));
    roots.push(root);
    const jobId = randomUUID();
    const attemptNumber = 1;
    const leaseIdentityHash = "b".repeat(64);
    const name = `export-${jobId}-${attemptNumber}-${leaseIdentityHash.slice(0, 16)}`;
    const reservedBytes = 12_345n;
    const markerValue = JSON.stringify({
      markerVersion: "editorial-export-scratch-v1",
      jobId,
      attemptNumber,
      leaseIdentityHash,
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      reservedBytes: reservedBytes.toString(),
    });
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const fs=require("node:fs");const path=require("node:path");const root=process.argv[1];const name=process.argv[2];const marker=process.argv[3];const dir=path.join(root,name);fs.mkdirSync(dir,{mode:0o700});fs.writeFileSync(path.join(dir,"attempt.json"),marker+"\\n",{mode:0o600,flag:"wx"});fs.writeFileSync(path.join(dir,"editorial-package.zip"),"closed-before-upload");process.stdout.write("READY\\n");setInterval(()=>{},1000);`,
        root,
        name,
        markerValue,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await once(child.stdout!, "data");
    expect(child.kill("SIGKILL")).toBe(true);
    const [exitCode, signal] = await once(child, "exit");
    expect(exitCode).toBeNull();
    expect(signal).toBe("SIGKILL");

    let leaseState: "ACTIVE" | "INACTIVE" = "ACTIVE";
    const repository = {
      listActiveExportScratchReservations: vi.fn(async () => []),
      inspectExportScratchLease: vi.fn(async () => leaseState),
      clearReconciledExportScratch: vi.fn(async () => undefined),
    } as unknown as MediaJobRepository;
    const reconciler = new ExportScratchReconciler(repository, root, 30_000);
    await expect(reconciler.reconcile()).resolves.toBe(reservedBytes);
    expect((await stat(join(root, name))).isDirectory()).toBe(true);

    leaseState = "INACTIVE";
    await expect(reconciler.reconcile()).resolves.toBe(0n);
    await expect(stat(join(root, name))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(repository.clearReconciledExportScratch).toHaveBeenCalledWith({
      jobId,
      attemptNumber,
      directoryName: name,
      leaseHash: leaseIdentityHash,
    });
  });

  it("rebuilds admission accounting from an active PostgreSQL reservation without a marker", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-export-reconcile-"));
    roots.push(root);
    const repository = {
      listActiveExportScratchReservations: vi.fn(async () => [
        {
          jobId: randomUUID(),
          attemptNumber: 3,
          directoryName: `export-${randomUUID()}-3-${"c".repeat(16)}`,
          leaseHash: "c".repeat(64),
          reservedBytes: 77_777n,
        },
      ]),
      inspectExportScratchLease: vi.fn(async () => "INACTIVE"),
      clearReconciledExportScratch: vi.fn(async () => undefined),
    } as unknown as MediaJobRepository;

    await expect(
      new ExportScratchReconciler(repository, root, 30_000).reconcile(),
    ).resolves.toBe(77_777n);
    expect(repository.inspectExportScratchLease).not.toHaveBeenCalled();
  });

  it("fails startup accounting closed when PostgreSQL reservations cannot be read", async () => {
    const root = await mkdtemp(join(tmpdir(), "cf-export-reconcile-"));
    roots.push(root);
    const value = await marker(root, 5_000n, Date.now() - 120_000);
    const repository = {
      listActiveExportScratchReservations: vi.fn(async () => {
        throw new Error("postgres unavailable");
      }),
      inspectExportScratchLease: vi.fn(async () => "UNKNOWN"),
      clearReconciledExportScratch: vi.fn(async () => undefined),
    } as unknown as MediaJobRepository;

    await expect(
      new ExportScratchReconciler(repository, root, 30_000).reconcile(),
    ).rejects.toThrow("postgres unavailable");
    expect((await stat(join(root, value.name))).isDirectory()).toBe(true);
  });
});

async function marker(root: string, reserved: bigint, created: number) {
  const jobId = randomUUID();
  const attemptNumber = 1;
  const leaseIdentityHash = "a".repeat(64);
  const name = `export-${jobId}-${attemptNumber}-${leaseIdentityHash.slice(0, 16)}`;
  const directory = join(root, name);
  await mkdir(directory, { mode: 0o700 });
  await writeFile(
    join(directory, "attempt.json"),
    `${JSON.stringify({
      markerVersion: "editorial-export-scratch-v1",
      jobId,
      attemptNumber,
      leaseIdentityHash,
      createdAt: new Date(created).toISOString(),
      reservedBytes: reserved.toString(),
    })}\n`,
    { mode: 0o600 },
  );
  return { name, jobId };
}
