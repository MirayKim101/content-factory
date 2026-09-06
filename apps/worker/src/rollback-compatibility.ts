import { ExportScratchReconciler } from "./infrastructure/export-scratch-reconciler.js";
import { PgMediaJobRepository } from "./infrastructure/pg-media-job.repository.js";

interface RollbackFixture {
  terminalExportJobId: string;
  legacyJobs: Array<{ id: string; type: string }>;
}

export async function verifyWorkerRollbackCompatibility(input: {
  databaseUrl: string;
  sourceAuthorizationPolicy: "manual" | "local-auto";
  scratchDirectory: string;
}): Promise<void> {
  const fixture = parseFixture();
  const repository = new PgMediaJobRepository(
    input.databaseUrl,
    input.sourceAuthorizationPolicy,
  );
  try {
    const accounted = await new ExportScratchReconciler(
      repository,
      input.scratchDirectory,
      0,
    ).reconcile();
    if (accounted !== 0n) {
      throw new Error("ROLLBACK_UNEXPECTED_SCRATCH_RESERVATION");
    }
    if (
      (await repository.claim(
        fixture.terminalExportJobId,
        "admission-off-rollback-worker",
        30_000,
      )) !== null
    ) {
      throw new Error("ROLLBACK_TERMINAL_EXPORT_CLAIMED");
    }

    const claimedTypes: string[] = [];
    for (const expected of fixture.legacyJobs) {
      const claimed = await repository.claim(
        expected.id,
        `admission-off-${expected.type.toLowerCase()}`,
        30_000,
      );
      if (!claimed || claimed.type !== expected.type) {
        throw new Error(`ROLLBACK_LEGACY_JOB_NOT_CLAIMED:${expected.type}`);
      }
      claimedTypes.push(claimed.type);
    }
    process.stdout.write(
      `${JSON.stringify({
        event: "admission_off_worker_rollback_compatible",
        claimedTypes,
      })}\n`,
    );
  } finally {
    await repository.close();
  }
}

function parseFixture(): RollbackFixture {
  const raw = process.env.ROLLBACK_COMPATIBILITY_FIXTURE;
  if (!raw) throw new Error("ROLLBACK_COMPATIBILITY_FIXTURE_REQUIRED");
  const value = JSON.parse(raw) as Partial<RollbackFixture>;
  if (
    typeof value.terminalExportJobId !== "string" ||
    !Array.isArray(value.legacyJobs) ||
    value.legacyJobs.length === 0 ||
    value.legacyJobs.some(
      (job) =>
        typeof job !== "object" ||
        job === null ||
        typeof job.id !== "string" ||
        typeof job.type !== "string",
    )
  ) {
    throw new Error("ROLLBACK_COMPATIBILITY_FIXTURE_INVALID");
  }
  return value as RollbackFixture;
}
