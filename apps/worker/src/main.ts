import { randomUUID } from "node:crypto";
import { chmod, mkdir } from "node:fs/promises";

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
import {
  openAiClipGenerationConfig,
  publicationWorkerAdmissionEnabled,
  twitchVodAutoIngestConfig,
  tiktokPublishingConfig,
  workerConfig,
  youtubePublishingConfig,
} from "./config.js";
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
import { BoundedPublicationProvider } from "./application/bounded-publication-provider.js";
import { ReconcilePublicationOutcomes } from "./application/reconcile-publication-outcomes.js";
import { CollectPublicationMetrics } from "./application/collect-publication-metrics.js";
import { LocalDryRunPublicationAdapter } from "./infrastructure/local-dry-run-publication-adapter.js";
import { PgPublicationWorkerRepository } from "./infrastructure/pg-publication-worker.repository.js";
import { ReconcileTwitchIngestion } from "./application/reconcile-twitch-ingestion.js";
import { ReconcileTwitchEventSub } from "./application/reconcile-twitch-eventsub.js";
import { PgTwitchIngestionWorkerRepository } from "./infrastructure/pg-twitch-ingestion-worker.repository.js";
import { TwitchHelixClient } from "./infrastructure/twitch-helix-client.js";
import { TwitchAppAccessTokenResolver } from "./infrastructure/twitch-app-access-token-resolver.js";
import { TwitchEventSubClient } from "./infrastructure/twitch-eventsub-client.js";
import { ProcessVerticalRender } from "./application/process-vertical-render.js";
import { FfmpegVerticalRenderer } from "./infrastructure/ffmpeg-vertical-renderer.js";
import { PgVerticalRenderRepository } from "./infrastructure/pg-vertical-render.repository.js";
import type { PublicationProvider } from "./application/publication.port.js";
import { PgPublicationSessionRepository } from "./infrastructure/pg-publication-session.repository.js";
import { PublicationSessionCipher } from "./infrastructure/publication-session-cipher.js";
import { YoutubeResumableTransport } from "./infrastructure/youtube-resumable-transport.js";
import { YoutubePublicationAdapter } from "./infrastructure/youtube-publication-adapter.js";
import { GoogleOAuthAccessTokenResolver } from "./infrastructure/google-oauth-access-token-resolver.js";
import { TikTokOAuthAccessTokenResolver } from "./infrastructure/tiktok-oauth-access-token-resolver.js";
import { TikTokDirectPostTransport } from "./infrastructure/tiktok-direct-post-transport.js";
import { TikTokPublicationAdapter } from "./infrastructure/tiktok-publication-adapter.js";
import { OpenAiClipGenerationAdapter } from "./infrastructure/openai-clip-generation-adapter.js";
import { PgClipGenerationWorker } from "./infrastructure/pg-clip-generation-worker.js";
import { HttpTwitchVodMediaProvider } from "./infrastructure/http-twitch-vod-media-provider.js";
import { ProcessTwitchVodIngest } from "./application/process-twitch-vod-ingest.js";
import { SingleFlightTask } from "./application/single-flight-task.js";
import { ReconcileScheduledPublications } from "./application/reconcile-scheduled-publications.js";
import {
  clearWorkerReadiness,
  markWorkerReady,
  prepareWorkerReadiness,
} from "./application/worker-readiness.js";

const TWITCH_EVENTSUB_RECONCILIATION_INTERVAL_MS = 5 * 60_000;

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
  const readinessFile = await prepareWorkerReadiness(config.scratchDirectory);
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
  const reconciliation = new SingleFlightTask(async () => {
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
  });
  await reconciliation.run().catch((error) =>
    console.error(
      JSON.stringify({
        event: "vertical_reconciliation_failed",
        workerId,
        error: error instanceof Error ? error.message : "unknown",
      }),
    ),
  );
  const timer = setInterval(() => {
    void reconciliation.run().catch((error) =>
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
    processor.abortAll();
    shutdownPromise = (async () => {
      await clearWorkerReadiness(readinessFile);
      await queue.close().catch(() => undefined);
      await reconciliation.wait().catch(() => undefined);
      await repository.close().catch(() => undefined);
      storage.close();
    })();
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await queue.waitUntilReady();
  await markWorkerReady(readinessFile);
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
  const readinessFile = await prepareWorkerReadiness(config.scratchDirectory);
  if (process.env.TWITCH_INGESTION_ENABLED !== "1")
    throw new Error("CONFIG_TWITCH_INGESTION_DISABLED");
  const clientId = requireWorkerSecret("TWITCH_CLIENT_ID");
  const clientSecret = process.env.TWITCH_CLIENT_SECRET?.trim();
  const staticAccessToken = process.env.TWITCH_APP_ACCESS_TOKEN?.trim();
  const eventSubCallback = process.env.TWITCH_EVENTSUB_CALLBACK_URL?.trim();
  const eventSubSecret = process.env.TWITCH_EVENTSUB_SECRET?.trim();
  if (!clientSecret && !staticAccessToken)
    throw new Error("CONFIG_TWITCH_CLIENT_SECRET_OR_APP_ACCESS_TOKEN_REQUIRED");
  const tokenResolver = clientSecret
    ? new TwitchAppAccessTokenResolver(clientId, clientSecret)
    : undefined;
  const workerId = `twitch-worker-${randomUUID()}`;
  const repository = new PgTwitchIngestionWorkerRepository(config.databaseUrl);
  const mediaGateway = twitchVodAutoIngestConfig(process.env);
  const ingestStorage = mediaGateway
    ? new S3WorkerObjectStorage(config.storage.bucket, config.storage)
    : undefined;
  const ingestProcessor =
    mediaGateway && ingestStorage
      ? new ProcessTwitchVodIngest(
          repository,
          new HttpTwitchVodMediaProvider(mediaGateway),
          ingestStorage,
          config.scratchDirectory,
          twitchVodMaximumBytes(process.env),
          Math.max(config.leaseMs, 7_200_000),
        )
      : undefined;
  const tokenProvider = tokenResolver ?? {
    resolve: () => Promise.resolve(staticAccessToken as string),
  };
  const reconciler = new ReconcileTwitchIngestion(
    repository,
    new TwitchHelixClient(clientId, tokenProvider),
  );
  if (Boolean(eventSubCallback) !== Boolean(eventSubSecret))
    throw new Error("CONFIG_TWITCH_EVENTSUB_CALLBACK_AND_SECRET_REQUIRED");
  const eventSubReconciler =
    eventSubCallback && eventSubSecret
      ? new ReconcileTwitchEventSub(
          new TwitchEventSubClient(
            clientId,
            tokenProvider,
            eventSubCallback,
            eventSubSecret,
          ),
          new URL(eventSubCallback).toString(),
        )
      : undefined;
  let nextEventSubReconciliationAt = 0;
  const controlReconciliation = new SingleFlightTask(async () => {
    let subscriptionChanges = { created: 0, deleted: 0 };
    if (eventSubReconciler && Date.now() >= nextEventSubReconciliationAt) {
      try {
        subscriptionChanges = await eventSubReconciler.execute(
          await repository.enabledBroadcasterIds(),
        );
        nextEventSubReconciliationAt =
          Date.now() + TWITCH_EVENTSUB_RECONCILIATION_INTERVAL_MS;
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "twitch_eventsub_reconciliation_failed",
            workerId,
            error: error instanceof Error ? error.message : "unknown",
          }),
        );
      }
    }
    const result = await reconciler.execute();
    if (
      subscriptionChanges.created ||
      subscriptionChanges.deleted ||
      result.events ||
      result.channels
    )
      console.log(
        JSON.stringify({
          event: "twitch_reconciliation_completed",
          workerId,
          subscriptionsCreated: subscriptionChanges.created,
          subscriptionsDeleted: subscriptionChanges.deleted,
          ...result,
        }),
      );
  });
  const ingestReconciliation = new SingleFlightTask(async () => {
    if (ingestProcessor && (await ingestProcessor.execute(workerId)))
      console.log(
        JSON.stringify({ event: "twitch_vod_ingest_completed", workerId }),
      );
  });
  let stopping = false;
  const runControlReconciliation = () => {
    if (stopping) return;
    void controlReconciliation.run().catch((error) =>
      console.error(
        JSON.stringify({
          event: "twitch_reconciliation_failed",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    );
  };
  const runIngestReconciliation = () => {
    if (stopping) return;
    void ingestReconciliation.run().catch((error) =>
      console.error(
        JSON.stringify({
          event: "twitch_vod_ingest_reconciliation_failed",
          workerId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
    );
  };
  await controlReconciliation.run();
  const controlTimer = setInterval(runControlReconciliation, 30_000);
  controlTimer.unref();
  const ingestTimer = setInterval(runIngestReconciliation, 30_000);
  ingestTimer.unref();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearInterval(controlTimer);
    clearInterval(ingestTimer);
    ingestProcessor?.abortAll();
    shutdownPromise = (async () => {
      await clearWorkerReadiness(readinessFile);
      await Promise.allSettled([
        controlReconciliation.wait(),
        ingestReconciliation.wait(),
      ]);
      await repository.close().catch(() => undefined);
      ingestStorage?.close();
    })();
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await markWorkerReady(readinessFile);
  console.log(JSON.stringify({ event: "twitch_worker_started", workerId }));
  runIngestReconciliation();
}

function twitchVodMaximumBytes(environment: NodeJS.ProcessEnv): bigint {
  const raw = environment.TWITCH_VOD_MAX_BYTES?.trim() || "107374182400";
  if (!/^\d+$/.test(raw))
    throw new Error("CONFIG_TWITCH_VOD_MAX_BYTES_INVALID");
  const value = BigInt(raw);
  if (value < 1n || value > 1_099_511_627_776n)
    throw new Error("CONFIG_TWITCH_VOD_MAX_BYTES_INVALID");
  return value;
}

function requireWorkerSecret(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`CONFIG_${name}_REQUIRED`);
  return value;
}

async function startPublicationWorker(): Promise<void> {
  if (!publicationWorkerAdmissionEnabled(process.env))
    throw new Error("CONFIG_PUBLISHING_DISABLED");
  const config = workerConfig();
  const readinessFile = await prepareWorkerReadiness(config.scratchDirectory);
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
      new BoundedPublicationProvider(
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
        1,
      ),
    );
    externalClosers.push(
      () => sessionRepository.close(),
      () => storage.close(),
    );
  }
  const tiktok = tiktokPublishingConfig(process.env);
  if (tiktok) {
    const sessionRepository = new PgPublicationSessionRepository(
      config.databaseUrl,
    );
    const storage = new S3WorkerObjectStorage(
      config.storage.bucket,
      config.storage,
    );
    providers.push(
      new BoundedPublicationProvider(
        new TikTokPublicationAdapter(
          new TikTokOAuthAccessTokenResolver(
            tiktok.clientKey,
            tiktok.clientSecret,
            tiktok.credentials,
          ),
          storage,
          sessionRepository,
          new PublicationSessionCipher(tiktok.currentKeyVersion, tiktok.keys),
          new TikTokDirectPostTransport(),
        ),
        1,
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
    undefined,
    (intentId, error) =>
      console.error(
        JSON.stringify({
          event: "publication_outcome_reconciliation_failed",
          workerId,
          intentId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
  );
  const metricsCollector = new CollectPublicationMetrics(
    repository,
    providers,
    undefined,
    (intentId, error) =>
      console.error(
        JSON.stringify({
          event: "publication_metrics_collection_failed",
          workerId,
          intentId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
  );
  const scheduledReconciler = new ReconcileScheduledPublications(
    repository,
    processor,
    (intentId, error) =>
      console.error(
        JSON.stringify({
          event: "scheduled_publication_reconciliation_failed",
          workerId,
          intentId,
          error: error instanceof Error ? error.message : "unknown",
        }),
      ),
  );
  const reconciliation = new SingleFlightTask(async () => {
    await scheduledReconciler.execute();
    await outcomeReconciler.execute();
    await metricsCollector.execute();
  });
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
  await reconciliation.run();
  const recoveryTimer = setInterval(() => {
    void reconciliation.run().catch((error) =>
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
    shutdownPromise = (async () => {
      await clearWorkerReadiness(readinessFile);
      await worker.close().catch(() => undefined);
      await reconciliation.wait().catch(() => undefined);
      await Promise.allSettled([
        repository.close(),
        ...externalClosers.map((close) => close()),
      ]);
    })();
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await worker.waitUntilReady();
  await markWorkerReady(readinessFile);
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
  const readinessFile = await prepareWorkerReadiness(config.scratchDirectory);
  const clipConfig = openAiClipGenerationConfig(process.env);
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
  const clipWorker = clipConfig
    ? new PgClipGenerationWorker(
        config.databaseUrl,
        new OpenAiClipGenerationAdapter(clipConfig),
        clipConfig.timeoutMs + 30_000,
      )
    : null;
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
  const clipQueue = clipWorker
    ? new Worker(
        "ai-clip-generation-v1",
        async (delivery) => {
          const intentId = (delivery.data as { intentId?: unknown }).intentId;
          if (typeof intentId !== "string")
            throw new Error("CLIP_GENERATION_JOB_INVALID");
          await clipWorker.process(intentId);
        },
        {
          connection: { ...config.redis, maxRetriesPerRequest: null },
          concurrency: 1,
        },
      )
    : null;
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
  clipQueue?.on("error", (error) =>
    console.error(
      JSON.stringify({
        event: "ai_clip_generation_worker_error",
        workerId,
        error: error.message,
      }),
    ),
  );
  const transcriptRecovery = new SingleFlightTask(async () => {
    await transcriptWorker.recover();
  });
  const researchRecovery = new SingleFlightTask(async () => {
    await researchWorker.recover();
  });
  const imageRecovery = new SingleFlightTask(async () => {
    await imageWorker.recover();
  });
  const clipRecovery = clipWorker
    ? new SingleFlightTask(async () => {
        await clipWorker.recover();
      })
    : null;
  await Promise.all([
    transcriptRecovery.run(),
    researchRecovery.run(),
    imageRecovery.run(),
    clipRecovery?.run() ?? Promise.resolve(),
  ]);
  const transcriptRecoveryTimer = setInterval(() => {
    void transcriptRecovery
      .run()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_transcript_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  transcriptRecoveryTimer.unref();
  const researchRecoveryTimer = setInterval(() => {
    void researchRecovery
      .run()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_research_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  researchRecoveryTimer.unref();
  const imageRecoveryTimer = setInterval(() => {
    void imageRecovery
      .run()
      .catch(() =>
        console.error(
          JSON.stringify({ event: "ai_image_reconciliation_failed" }),
        ),
      );
  }, 5_000);
  imageRecoveryTimer.unref();
  const clipRecoveryTimer = clipRecovery
    ? setInterval(() => {
        void clipRecovery.run().catch(() =>
          console.error(
            JSON.stringify({
              event: "ai_clip_generation_reconciliation_failed",
            }),
          ),
        );
      }, 5_000)
    : null;
  clipRecoveryTimer?.unref();
  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    clearInterval(researchRecoveryTimer);
    clearInterval(imageRecoveryTimer);
    clearInterval(transcriptRecoveryTimer);
    if (clipRecoveryTimer) clearInterval(clipRecoveryTimer);
    shutdownPromise = (async () => {
      await clearWorkerReadiness(readinessFile);
      await Promise.allSettled([
        transcriptQueue.close(),
        researchQueue.close(),
        imageQueue.close(),
        clipQueue?.close() ?? Promise.resolve(),
      ]);
      await Promise.allSettled([
        transcriptRecovery.wait(),
        researchRecovery.wait(),
        imageRecovery.wait(),
        clipRecovery?.wait() ?? Promise.resolve(),
      ]);
      await Promise.allSettled([
        transcriptWorker.close(),
        researchWorker.close(),
        imageWorker.close(),
        clipWorker?.close() ?? Promise.resolve(),
      ]);
      imageStorage.close();
    })();
    return shutdownPromise;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => void shutdown());
  }
  await Promise.all([
    transcriptQueue.waitUntilReady(),
    researchQueue.waitUntilReady(),
    imageQueue.waitUntilReady(),
    clipQueue?.waitUntilReady() ?? Promise.resolve(),
  ]);
  await markWorkerReady(readinessFile);
  console.log(
    JSON.stringify({
      event: "ai_worker_started",
      workerId,
      queues: [
        "ai-transcript-v1",
        "ai-research-v1",
        "ai-image-suggestion-v1",
        ...(clipQueue ? ["ai-clip-generation-v1"] : []),
      ],
    }),
  );
}

async function startWorker(): Promise<void> {
  const config = workerConfig();
  await mkdir(config.scratchDirectory, { recursive: true });
  await mkdir(config.sourceCacheDirectory, { recursive: true });
  await chmod(config.scratchDirectory, 0o700);
  await chmod(config.sourceCacheDirectory, 0o700);
  const readinessFile = await prepareWorkerReadiness(config.scratchDirectory);
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
  const frameReconciliation = new SingleFlightTask(async () => {
    await processFrameJob.reconcile();
  });
  await frameReconciliation.run();
  const frameReconcileTimer = setInterval(() => {
    void frameReconciliation
      .run()
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
  const mediaScratchReconciler = new MediaScratchReconciler(
    repository,
    config.scratchDirectory,
    config.leaseMs,
    (event) => console.log(JSON.stringify(event)),
  );
  const exportScratchReconciliation = new SingleFlightTask(async () => {
    processJob.setRecoveredScratchBytes(
      await exportScratchReconciler.reconcile(),
    );
  });
  const mediaScratchReconciliation = new SingleFlightTask(async () => {
    await mediaScratchReconciler.reconcile();
  });
  await exportScratchReconciliation.run();
  await mediaScratchReconciliation.run();
  const exportScratchTimer = setInterval(
    () =>
      void exportScratchReconciliation.run().catch((error) =>
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
      void mediaScratchReconciliation.run().catch((error) =>
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
    clearInterval(exportScratchTimer);
    clearInterval(mediaScratchTimer);
    clearInterval(frameReconcileTimer);
    processFrameJob.abortAll();
    shutdownPromise = (async () => {
      await clearWorkerReadiness(readinessFile);
      console.log(
        JSON.stringify({ event: "media_worker_stopping", workerId, signal }),
      );
      await worker.close().catch(() => undefined);
      await Promise.allSettled([
        frameReconciliation.wait(),
        exportScratchReconciliation.wait(),
        mediaScratchReconciliation.wait(),
      ]);
      await frameReconciliation.run().catch(() => undefined);
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
    await markWorkerReady(readinessFile);
  } catch (error) {
    await shutdown("READINESS_WRITE_FAILED", 1);
    throw error;
  }
  if (closing) {
    await clearWorkerReadiness(readinessFile);
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
