import { apiEnvironment } from "./config/environment.js";
import { PrismaService } from "./database/prisma.service.js";
import { PrismaEditorialExportRepository } from "./editorial-content/infrastructure/prisma-editorial-export.repository.js";
import { PrismaPipelineRepository } from "./media-pipeline/infrastructure/prisma-pipeline.repository.js";

interface RollbackFixture {
  exportIntentId: string;
  terminalExportJobId: string;
  runnableJobIds: string[];
  projectId: string;
  sourceId: string;
  cutJobId: string;
  editorialPackageId: string;
  montageAssetId: string;
  assemblyRecipeId: string;
  assemblyRenderIntentId: string;
}

export async function verifyAdmissionOffRollbackCompatibility(): Promise<void> {
  const configuration = apiEnvironment();
  if (configuration.editorialExportEnabled) {
    throw new Error("ROLLBACK_EXPORT_ADMISSION_MUST_BE_DISABLED");
  }
  if (configuration.aiContextEnabled) {
    throw new Error("ROLLBACK_AI_CONTEXT_ADMISSION_MUST_BE_DISABLED");
  }
  const fixture = parseFixture();
  const prisma = new PrismaService();
  await prisma.onModuleInit();
  try {
    const historical = await new PrismaEditorialExportRepository(prisma).get(
      fixture.exportIntentId,
    );
    if (
      !historical ||
      historical.job.id !== fixture.terminalExportJobId ||
      !["READY", "FAILED_FINAL"].includes(historical.job.state)
    ) {
      throw new Error("ROLLBACK_TERMINAL_EXPORT_NOT_READABLE");
    }

    const runnable = await new PrismaPipelineRepository(prisma).getRunnableJobs(
      100,
    );
    const runnableIds = new Set(runnable.map((job) => job.jobId));
    if (runnableIds.has(fixture.terminalExportJobId)) {
      throw new Error("ROLLBACK_TERMINAL_EXPORT_DISPATCHED");
    }
    if (!fixture.runnableJobIds.every((jobId) => runnableIds.has(jobId))) {
      throw new Error("ROLLBACK_LEGACY_JOB_NOT_RECONCILED");
    }

    const compatibleRows = await Promise.all([
      prisma.project.count({ where: { id: fixture.projectId } }),
      prisma.videoSource.count({ where: { id: fixture.sourceId } }),
      prisma.pipelineJob.count({
        where: { id: fixture.cutJobId, type: "CUT_SEGMENT" },
      }),
      prisma.editorialPackage.count({
        where: { id: fixture.editorialPackageId },
      }),
      prisma.montageAsset.count({ where: { id: fixture.montageAssetId } }),
      prisma.assemblyRecipe.count({ where: { id: fixture.assemblyRecipeId } }),
      prisma.assemblyRenderIntent.count({
        where: { id: fixture.assemblyRenderIntentId },
      }),
    ]);
    if (compatibleRows.some((count) => count !== 1)) {
      throw new Error("ROLLBACK_LEGACY_PATH_ROW_MISSING");
    }

    process.stdout.write(
      `${JSON.stringify({
        event: "admission_off_api_rollback_compatible",
        exportIntentId: fixture.exportIntentId,
        legacyPaths: [
          "source",
          "cut",
          "editorial",
          "montage",
          "recipe",
          "render",
        ],
      })}\n`,
    );
  } finally {
    await prisma.onModuleDestroy();
  }
}

function parseFixture(): RollbackFixture {
  const raw = process.env.ROLLBACK_COMPATIBILITY_FIXTURE;
  if (!raw) throw new Error("ROLLBACK_COMPATIBILITY_FIXTURE_REQUIRED");
  const value = JSON.parse(raw) as Partial<RollbackFixture>;
  const scalarKeys = [
    "exportIntentId",
    "terminalExportJobId",
    "projectId",
    "sourceId",
    "cutJobId",
    "editorialPackageId",
    "montageAssetId",
    "assemblyRecipeId",
    "assemblyRenderIntentId",
  ] as const;
  if (
    scalarKeys.some(
      (key) => typeof value[key] !== "string" || value[key]?.length === 0,
    ) ||
    !Array.isArray(value.runnableJobIds) ||
    value.runnableJobIds.length === 0 ||
    value.runnableJobIds.some((jobId) => typeof jobId !== "string")
  ) {
    throw new Error("ROLLBACK_COMPATIBILITY_FIXTURE_INVALID");
  }
  return value as RollbackFixture;
}
