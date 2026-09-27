import { randomUUID } from "node:crypto";
import { chmod, mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  parseMediaJobReference,
  parsePublicationJobReference,
  parseVerticalJobReference,
  PUBLICATION_QUEUE_NAME,
  VERTICAL_QUEUE_NAME,
} from "@content-factory/contracts";
import { Worker } from "bullmq";

import { ProcessMediaJob } from "./application/process-media-job.js";
import { ProcessFrameJob } from "./application/process-frame-job.js";
import { PgFrameJobRepository } from "./infrastructure/pg-frame-job.repository.js";
import { FfmpegFrameExtractor } from "./infrastructure/ffmpeg-frame-extractor.js";
import { workerConfig, youtubePublishingConfig } from "./config.js";
import { FfmpegMediaProcessor } from "./infrastructure/ffmpeg-media-processor.js";
import { FfmpegAssemblyRenderer } from "./infrastructure/ffmpeg-assembly-renderer.js";
import { LocalSourceCache } from "./infrastructure/local-source-cache.js";
import { PgMediaJobRepository } from "./infrastructure/pg-media-job.repository.js";
import { S3WorkerObjectStorage } from "./infrastructure/s3-worker-object-storage.js";
import { StreamingZip64PackageExporter } from "./infrastructure/streaming-zip64-package-exporter.js";
import { ExportScratchReconciler } from "./infrastructure/export-scratch-reconciler.js";
import { MediaScratchReconciler } from "./infrastructure/media-scratch-reconciler.js";
import { verifyWorkerRollbackCompatibility } from "./rollback-compatibility.js";
import { PgTranscriptWorker } from "./infrastructure/pg-transcript-worker.js";
import { PgResearchWorker } from "./infrastructure/pg-research-worker.js";
import { PgImageSuggestionWorker } from "./infrastructure/pg-image-suggestion-worker.js";
import { ProcessPublicationIntent } from "./application/process-publication-intent.js";
import { ReconcilePublicationOutcomes } from "./application/reconcile-publication-outcomes.js";
import { LocalDryRunPublicationAdapter } from "./infrastructure/local-dry-run-publication-adapter.js";
import { PgPublicationWorkerRepository } from "./infrastructure/pg-publication-worker.repository.js";
import { ReconcileTwitchIngestion } from "./application/reconcile-twitch-ingestion.js";
import { PgTwitchIngestionWorkerRepository } from "./infrastructure/pg-twitch-ingestion-worker.repository.js";
import { TwitchHelixClient } from "./infrastructure/twitch-helix-client.js";
import { ProcessVerticalRender } from "./application/process-vertical-render.js";
import { FfmpegVerticalRenderer } from "./infrastructure/ffmpeg-vertical-renderer.js";
import { PgVerticalRenderRepository } from "./infrastructure/pg-vertical-render.repository.js";
import type { PublicationProvider } from "./application/publication.port.js";
import { PgPublicationSessionRepository } from "./infrastructure/pg-publication-session.repository.js";
import { PublicationSessionCipher } from "./infrastructure/publication-session-cipher.js";
import { YoutubeResumableTransport } from "./infrastructure/youtube-resumable-transport.js";
import { YoutubePublicationAdapter } from "./infrastructure/youtube-publication-adapter.js";
import { GoogleOAuthAccessTokenResolver } from "./infrastructure/google-oauth-access-token-resolver.js";

if (process.argv.includes("--verify-admission-off-rollback")) {
  const rollbackConfig = workerConfig();
  await mkdir(rollbackConfig.scratchDirectory, { recursive: true });
  await chmod(rollbackConfig.scratchDirectory, 0o700);
  await verifyWorkerRollbackCompatibility({
    databaseUrl: rollbackConfig.databaseUrl,
    sourceAuthorizationPolicy: rollbackConfig.sourceAuthorizationPolicy,
    scratchDirectory: rollbackConfig.scratchDirectory,
  });
} else {
  await (process.env.WORKER_ROLE === "ai"
    ? startAiWorker()
    : process.env.WORKER_ROLE === "publication"
      ? startPublicationWorker()
      : process.env.WORKER_ROLE === "twitch"
        ? startTwitchWorker()
        : process.env.WORKER_ROLE === "vertical"
          ? startVerticalWorker()
          : startWorker());
}

async function startVerticalWorker(): Promise<void> {
  const config = workerConfig();
  if (process.env.VERTICAL_RENDER_ENABLED !== "1")
    throw new Error("CONFIG_VERTICAL_RENDER_DISABLED");
  const workerId = `vertical-worker-${randomUUID()}`;
  const repository = new PgVerticalRenderRepository(config.databaseUrl);
  const storage = new S3WorkerObjectStorage(
    config.storage.bucket,
    config.storage,
  );
  const renderer = new FfmpegVerticalRenderer(
    config.ffmpegPath,
    config.ffprobePath,
  );
  await renderer.verifyAvailable();
  const processor = new ProcessVerticalRender(
    repository,
    storage,
    renderer,
    config.scratchDirectory,
    config.leaseMs,
  );
  const queue = new Worker(
    VERTICAL_QUEUE_NAME,
    async (delivery) => {
      const reference = parseVerticalJobReference(delivery.data);
      await processor.execute(reference.jobId);
    },
    {
      connection: { ...config.redis, maxRetriesPerRequest: null },
      concurrency: 1,
    },
  );
  let reconciling = false;
  const reconcile = async (): Promise<void> => {
    if (reconciling) return;
    reconciling = true;
    try {
      for (const jobId of await repository.due()) {
        await processor.execute(jobId).catch((error) =>
          console.error(
            JSON.stringify({
              event: "vertical_reconciliation_job_failed",
              workerId,
              jobId,
              error: error instanceof Error ? error.message : "unknown",
            }),
          ),
        );
      }
    } finally {
      reconciling = false;
    }
  };
  await reconcile().catch((error) =>
    console.error(
      JSON.stringify({
        event: "vertical_reconciliation_failed",
        workerId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    ),
  );
  const timer = setInterval(() => {
    void reconcile().catch((error) =>
      console.error(
        JSON.stringify({
          event: "vertical_reconciliation_failed",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    );
  }, 30_000);
  timer.unref();
  queue.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "vertical_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(timer);
    shutdownPromise = Promise.allSettled([
      queue.close(),
      repository.close(),
    ]).then(() => {
      storage.close();
    });
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await queue.waitUntilReady();
  console.log(
    JSON.stringify({
      event: "vertical_worker_started",
      workerId,
      queue: VERTICAL_QUEUE_NAME,
    }),
  );
}

async function startTwitchWorker(): Promise<void> {
  const config = workerConfig();
  if (process.env.TWITCH_INGESTION_ENABLED !== "1")
    throw new Error("CONFIG_TWITCH_INGESTION_DISABLED");
  const clientId = requireWorkerSecret("TWITCH_CLIENT_ID");
  const accessToken = requireWorkerSecret("TWITCH_APP_ACCESS_TOKEN");
  const workerId = `twitch-worker-${randomUUID()}`;
  const repository = new PgTwitchIngestionWorkerRepository(config.databaseUrl);
  const reconciler = new ReconcileTwitchIngestion(
    repository,
    new TwitchHelixClient(clientId, accessToken),
  );
  let running = false;
  const run = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const result = await reconciler.execute();
      if (result.events || result.channels)
        console.log(
          JSON.stringify({
            event: "twitch_reconciliation_completed",
            workerId,
            ...result,
          }),
        );
    } finally {
      running = false;
    }
  };
  await run();
  const timer = setInterval(() => {
    void run().catch((error) =>
      console.error(
        JSON.stringify({
          event: "twitch_reconciliation_failed",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    );
  }, 30_000);
  timer.unref();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(timer);
    shutdownPromise = repository.close();
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  console.log(JSON.stringify({ event: "twitch_worker_started", workerId }));
}

function requireWorkerSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

async function startPublicationWorker(): Promise<void> {
  const config = workerConfig();
  const workerId = `publication-worker-${randomUUID()}`;
  const repository = new PgPublicationWorkerRepository(config.databaseUrl);
  const providers: PublicationProvider[] = [
    new LocalDryRunPublicationAdapter(),
  ];
  const externalClosers: Array<() => void | Promise<void>> = [];
  const youtube = youtubePublishingConfig(process.env);
  if (youtube) {
    const sessionRepository = new PgPublicationSessionRepository(
      config.databaseUrl,
    );
    const storage = new S3WorkerObjectStorage(
      config.storage.bucket,
      config.storage,
    );
    providers.push(
      new YoutubePublicationAdapter(
        new GoogleOAuthAccessTokenResolver(
          youtube.clientId,
          youtube.clientSecret,
          youtube.credentials,
        ),
        storage,
        sessionRepository,
        new PublicationSessionCipher(youtube.currentKeyVersion, youtube.keys),
        new YoutubeResumableTransport(),
      ),
    );
    externalClosers.push(
      () => sessionRepository.close(),
      () => storage.close(),
    );
  }
  const processor = new ProcessPublicationIntent(repository, providers);
  const outcomeReconciler = new ReconcilePublicationOutcomes(
    repository,
    providers,
  );
  let recoveringPublications = false;
  const processDue = async (): Promise<void> => {
    if (recoveringPublications) return;
    recoveringPublications = true;
    try {
      for (const intentId of await repository.due())
        await processor.execute(intentId);
      await outcomeReconciler.execute();
    } finally {
      recoveringPublications = false;
    }
  };
  const worker = new Worker(
    PUBLICATION_QUEUE_NAME,
    async (delivery) => {
      const reference = parsePublicationJobReference(delivery.data);
      await processor.execute(reference.publicationIntentId);
    },
    {
      connection: { ...config.redis, maxRetriesPerRequest: null },
      concurrency: 2,
    },
  );
  worker.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "publication_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  await processDue();
  const recoveryTimer = setInterval(() => {
    void processDue().catch((error) =>
      console.error(
        JSON.stringify({
          event: "publication_reconciliation_failed",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    );
  }, 30_000);
  recoveryTimer.unref();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(recoveryTimer);
    shutdownPromise = Promise.allSettled([
      worker.close(),
      repository.close(),
      ...externalClosers.map((close) => close()),
    ]).then(() => undefined);
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await worker.waitUntilReady();
  console.log(
    JSON.stringify({
      event: "publication_worker_started",
      workerId,
      queue: PUBLICATION_QUEUE_NAME,
      adapters: providers.map((provider) => provider.platform),
    }),
  );
}

async function startAiWorker(): Promise<void> {
  const config = workerConfig();
  const transcriptWorker = new PgTranscriptWorker({
    databaseUrl: config.databaseUrl,
    bucket: config.storage.bucket,
    storage: config.storage,
  });
  const researchWorker = new PgResearchWorker(
    config.databaseUrl,
    config.sourceAuthorizationPolicy,
  );
  const imageStorage = new S3WorkerObjectStorage(
    config.storage.bucket,
    config.storage,
  );
  const imageWorker = new PgImageSuggestionWorker(
    config.databaseUrl,
    config.sourceAuthorizationPolicy,
    imageStorage,
  );
  const workerId = `ai-worker-${randomUUID()}`;
  const transcriptQueue = new Worker(
    "ai-transcript-v1",
    async (delivery) => {
      const intentId = (delivery.data as { intentId?: unknown }).intentId;
      if (typeof intentId !== "string")
        throw new Error("TRANSCRIPT_JOB_INVALID");
      await transcriptWorker.process(intentId);
    },
    {
      connection: { ...config.redis, maxRetriesPerRequest: null },
      concurrency: 1,
    },
  );
  const researchQueue = new Worker(
    "ai-research-v1",
    async (delivery) => {
      const intentId = (delivery.data as { intentId?: unknown }).intentId;
      if (typeof intentId !== "string") throw new Error("RESEARCH_JOB_INVALID");
      await researchWorker.process(intentId);
    },
    {
      connection: { ...config.redis, maxRetriesPerRequest: null },
      concurrency: 1,
    },
  );
  const imageQueue = new Worker(
    "ai-image-suggestion-v1",
    async (delivery) => {
      const intentId = (delivery.data as { intentId?: unknown }).intentId;
      if (typeof intentId !== "string") throw new Error("IMAGE_JOB_INVALID");
      await imageWorker.process(intentId);
    },
    {
      connection: { ...config.redis, maxRetriesPerRequest: null },
      concurrency: 1,
    },
  );
  transcriptQueue.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "ai_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  researchQueue.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "ai_research_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  imageQueue.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "ai_image_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  await Promise.all([
    transcriptWorker.recover(),
    researchWorker.recover(),
    imageWorker.recover(),
  ]);
  const transcriptRecoveryTimer = setInterval(() => {
    void transcriptWorker
      .recover()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_transcript_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  transcriptRecoveryTimer.unref();
  const researchRecoveryTimer = setInterval(() => {
    void researchWorker
      .recover()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_research_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  researchRecoveryTimer.unref();
  const imageRecoveryTimer = setInterval(() => {
    void imageWorker
      .recover()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_image_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  imageRecoveryTimer.unref();
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      clearInterval(researchRecoveryTimer);
      clearInterval(imageRecoveryTimer);
      clearInterval(transcriptRecoveryTimer);
      await transcriptQueue.close().catch(() => undefined);
      await researchQueue.close().catch(() => undefined);
      await imageQueue.close().catch(() => undefined);
      await transcriptWorker.close().catch(() => undefined);
      await researchWorker.close().catch(() => undefined);
      await imageWorker.close().catch(() => undefined);
      imageStorage.close();
    });
  }
  await Promise.all([
    transcriptQueue.waitUntilReady(),
    researchQueue.waitUntilReady(),
    imageQueue.waitUntilReady(),
  ]);
  console.log(
    JSON.stringify({
      event: "ai_worker_started",
      workerId,
      queues: ["ai-transcript-v1", "ai-research-v1", "ai-image-suggestion-v1"],
    }),
  );
}

async function startWorker(): Promise<void> {
  const config = workerConfig();
  await mkdir(config.scratchDirectory, { recursive: true });
  await mkdir(config.sourceCacheDirectory, { recursive: true });
  await chmod(config.scratchDirectory, 0o700);
  await chmod(config.sourceCacheDirectory, 0o700);
  const readinessFile = join(config.scratchDirectory, "worker-ready");
  await unlink(readinessFile).catch(() => undefined);
  const workerId = `media-worker-${randomUUID()}`;
  const repository = new PgMediaJobRepository(
    config.databaseUrl,
    config.sourceAuthorizationPolicy,
  );
  const storage = new S3WorkerObjectStorage(
    config.storage.bucket,
    config.storage,
  );
  const frameRepository = new PgFrameJobRepository(
    config.databaseUrl,
    config.sourceAuthorizationPolicy,
  );
  await frameRepository.initializePool(config.frameExtractionCapacity);
  const frameExtractor = new FfmpegFrameExtractor(
    config.ffmpegPath,
    config.ffprobePath,
  );
  await frameExtractor.verifyAvailable();
  const processFrameJob = new ProcessFrameJob(
    frameRepository,
    storage,
    frameExtractor,
    workerId,
    {
      scratchDirectory: config.scratchDirectory,
      scratchSafetyBytes: Number(config.scratchSafetyBytes),
      leaseMs: config.leaseMs,
      workDeadlineMs: config.frameWorkDeadlineMs,
    },
    (event) => console.log(JSON.stringify(event)),
  );
  await processFrameJob.reconcile();
  const frameReconcileTimer = setInterval(() => {
    void processFrameJob
      .reconcile()
      .catch(() =>
        console.error(JSON.stringify({ event: "frame_reconciliation_failed" })),
      );
  }, 5000);
  frameReconcileTimer.unref();
  const processor = new FfmpegMediaProcessor(
    config.ffmpegPath,
    config.ffprobePath,
  );
  const assemblyRenderer = new FfmpegAssemblyRenderer(
    config.ffmpegPath,
    config.ffprobePath,
    config.ffmpegThreads,
  );
  await assemblyRenderer.verifyCapabilities(config.assemblyFontPath);
  const sourceCache = new LocalSourceCache({
    directory: config.sourceCacheDirectory,
    maxBytes: config.sourceCacheMaxBytes,
    ttlMs: config.sourceCacheTtlMs,
  });
  const packageExporter = new StreamingZip64PackageExporter();
  const processJob = new ProcessMediaJob(
    repository,
    storage,
    processor,
    sourceCache,
    workerId,
    {
      scratchDirectory: config.scratchDirectory,
      scratchSafetyBytes: config.scratchSafetyBytes,
      leaseMs: config.leaseMs,
      jobTimeoutMs: config.jobTimeoutMs,
      assemblyFontPath: config.assemblyFontPath,
    },
    (event) => console.log(JSON.stringify(event)),
    assemblyRenderer,
    packageExporter,
  );
  const exportScratchReconciler = new ExportScratchReconciler(
    repository,
    config.scratchDirectory,
    config.leaseMs,
    (event) => console.log(JSON.stringify(event)),
  );
  processJob.setRecoveredScratchBytes(
    await exportScratchReconciler.reconcile(),
  );
  const mediaScratchReconciler = new MediaScratchReconciler(
    repository,
    config.scratchDirectory,
    config.leaseMs,
    (event) => console.log(JSON.stringify(event)),
  );
  await mediaScratchReconciler.reconcile();
  const exportScratchTimer = setInterval(
    () =>
      void exportScratchReconciler
        .reconcile()
        .then((bytes) => processJob.setRecoveredScratchBytes(bytes))
        .catch((error) =>
          console.error(
            JSON.stringify({
              event: "export_scratch_reconcile_failed",
              error: error instanceof Error ? error.message : "unknown",
            }),
          ),
        ),
    Math.max(config.leaseMs, 30_000),
  );
  exportScratchTimer.unref();
  const mediaScratchTimer = setInterval(
    () =>
      void mediaScratchReconciler.reconcile().catch((error) =>
        console.error(
          JSON.stringify({
            event: "media_scratch_reconcile_failed",
            error: error instanceof Error ? error.message : "unknown",
          }),
        ),
      ),
    Math.max(config.leaseMs, 30_000),
  );
  mediaScratchTimer.unref();

  const worker = new Worker(
    config.mediaQueueName,
    async (delivery) => {
      const reference = parseMediaJobReference(delivery.data);
      console.log(
        JSON.stringify({
          event: "media_job_received",
          workerId,
          jobId: reference.jobId,
          deliveryAttempt: delivery.attemptsMade + 1,
        }),
      );
      if (!(await processFrameJob.execute(reference.jobId)))
        await processJob.execute(reference.jobId);
    },
    {
      connection: {
        ...config.redis,
        maxRetriesPerRequest: null,
      },
      concurrency: config.concurrency,
      autorun: false,
    },
  );
  worker.on("completed", (job) => {
    console.log(
      JSON.stringify({
        event: "media_delivery_completed",
        workerId,
        jobId: job.id,
      }),
    );
  });
  worker.on("failed", (job, error) => {
    console.error(
      JSON.stringify({
        event: "media_delivery_failed",
        workerId,
        jobId: job?.id,
        error: error.message,
      }),
    );
  });
  worker.on("error", (error) => {
    console.error(
      JSON.stringify({
        event: "media_worker_error",
        workerId,
        error: error.message,
      }),
    );
  });

  let closing = false;
  let exitCode = 0;
  let shutdownPromise: Promise<void> | undefined;
  function shutdown(signal: string, requestedExitCode = 0): Promise<void> {
    exitCode = Math.max(exitCode, requestedExitCode);
    process.exitCode = exitCode;
    if (shutdownPromise) return shutdownPromise;
    closing = true;
    shutdownPromise = (async () => {
      await unlink(readinessFile).catch(() => undefined);
      clearInterval(exportScratchTimer);
      clearInterval(mediaScratchTimer);
      clearInterval(frameReconcileTimer);
      processFrameJob.abortAll();
      console.log(
        JSON.stringify({ event: "media_worker_stopping", workerId, signal }),
      );
      await worker.close().catch(() => undefined);
      await processFrameJob.reconcile().catch(() => undefined);
      await Promise.allSettled([
        sourceCache.close(),
        repository.close(),
        frameRepository.close(),
      ]);
      storage.close();
      process.exitCode = exitCode;
    })();
    return shutdownPromise;
  }

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown(signal));
  }

  await worker.waitUntilReady();
  void worker.run().then(
    () => (closing ? undefined : shutdown("WORKER_RUN_STOPPED", 1)),
    async (error: unknown) => {
      console.error(
        JSON.stringify({
          event: "media_worker_stopped_unexpectedly",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      await shutdown("WORKER_RUN_FAILED", 1);
    },
  );
  try {
    await writeFile(readinessFile, `${process.pid}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch (error) {
    await shutdown("READINESS_WRITE_FAILED", 1);
    throw error;
  }
  if (closing) {
    await unlink(readinessFile).catch(() => undefined);
    return;
  }

  console.log(
    JSON.stringify({
      event: "media_worker_started",
      workerId,
      concurrency: config.concurrency,
      capabilities: [
        "SOURCE_PROBE",
        "CUT_SEGMENT",
        "MONTAGE_ASSET_PROBE",
        "ASSEMBLE_HORIZONTAL",
        "EXPORT_EDITORIAL_PACKAGE",
        "EXTRACT_EDITORIAL_FRAMES",
      ],
    }),
  );
}
