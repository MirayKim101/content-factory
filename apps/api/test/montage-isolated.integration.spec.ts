import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import {
  Module,
  type INestApplication,
  ValidationPipe,
  BadRequestException,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory } from "@nestjs/core";
import { Pool } from "pg";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { databaseUrl } from "../src/config/environment.js";
import { PrismaService } from "../src/database/prisma.service.js";
import { HttpExceptionFilter } from "../src/http-exception.filter.js";
import {
  OBJECT_STORAGE,
  ObjectRangeNotSatisfiableError,
  type ObjectStorage,
} from "../src/projects/application/object-storage.port.js";
import { TempUploadLifecycleInterceptor } from "../src/projects/presentation/temp-upload-lifecycle.interceptor.js";
import { MONTAGE_REPOSITORY } from "../src/editorial-content/application/montage-repository.port.js";
import { UploadMontageAsset } from "../src/editorial-content/application/upload-montage-asset.js";
import { PrismaMontageRepository } from "../src/editorial-content/infrastructure/prisma-montage.repository.js";
import { MontageController } from "../src/editorial-content/presentation/montage.controller.js";
import { MontageUploadAdmissionInterceptor } from "../src/editorial-content/presentation/montage-upload-admission.interceptor.js";
import { PrismaPipelineRepository } from "../src/media-pipeline/infrastructure/prisma-pipeline.repository.js";
import type { MontageProbeResultV1 } from "@content-factory/contracts";

// Runtime test adapter crosses application roots without changing either build's rootDir.
interface TestClaim {
  sourceObjectKey: string;
  attemptNumber: number;
}
interface TestWorkerRepository {
  claim(id: string, worker: string, lease: number): Promise<TestClaim | null>;
  completeMontageProbe(
    job: TestClaim,
    result: MontageProbeResultV1,
  ): Promise<void>;
  fail(
    job: TestClaim,
    code: string,
    message: string,
    retryable: boolean,
  ): Promise<string>;
  close(): Promise<void>;
}

// Opt-in isolated DB only. Never invokes application bootstrap, live storage policy or Redis.
describe.runIf(process.env.MONTAGE_ISOLATED_TESTS === "1")(
  "montage isolated HTTP/PostgreSQL",
  () => {
    const name = `content_factory_montage_test_${randomUUID().replaceAll("-", "")}`;
    const previous = {
      POSTGRES_DB: process.env.POSTGRES_DB,
      SOURCE_AUTHORIZATION_POLICY: process.env.SOURCE_AUTHORIZATION_POLICY,
      DEPLOYMENT_PROFILE: process.env.DEPLOYMENT_PROFILE,
      API_HOST: process.env.API_HOST,
      API_UPLOAD_TEMP_DIRECTORY: process.env.API_UPLOAD_TEMP_DIRECTORY,
    };
    let admin: Pool,
      isolated: Pool,
      prisma: PrismaService,
      app: INestApplication,
      worker: TestWorkerRepository,
      directory: string;
    let created = false;
    let projectId: string, sourceId: string;
    const objects = new Map<string, Buffer>();
    const storage: ObjectStorage = {
      ensurePrivateBucket: async () => {
        throw new Error("LIVE_POLICY_FORBIDDEN");
      },
      putFile: async (input) => {
        objects.set(input.objectKey, await readFile(input.filePath));
        return { etag: "test" };
      },
      headObject: async () => null,
      deleteObject: async (key) => {
        objects.delete(key);
      },
      readObject: async (key, range) => {
        const bytes = objects.get(key);
        if (!bytes) return null;
        if (range) {
          const match = /^bytes=(\d+)-(\d*)$/.exec(range);
          const start = Number(match?.[1]),
            end = Math.min(
              Number(match?.[2] || bytes.length - 1),
              bytes.length - 1,
            );
          if (!match || start >= bytes.length || end < start)
            throw new ObjectRangeNotSatisfiableError();
          const chunk = bytes.subarray(start, end + 1);
          return {
            body: Readable.from(chunk),
            contentLength: chunk.length,
            contentType: "video/mp4",
            contentRange: `bytes ${start}-${end}/${bytes.length}`,
          };
        }
        return {
          body: Readable.from(bytes),
          contentLength: bytes.length,
          contentType: "video/mp4",
        };
      },
    };
    beforeAll(async () => {
      const base = new URL(databaseUrl());
      if (
        !/^content_factory_montage_test_[a-f0-9]{32}$/.test(name) ||
        base.pathname.slice(1) === name
      )
        throw new Error("ISOLATION_GUARD_FAILED");
      base.pathname = "/postgres";
      admin = new Pool({ connectionString: base.toString(), max: 1 });
      await admin.query(`CREATE DATABASE "${name}"`);
      created = true;
      base.pathname = `/${name}`;
      isolated = new Pool({ connectionString: base.toString(), max: 2 });
      const connected = await isolated.query<{ name: string }>(
        "SELECT current_database() AS name",
      );
      if (connected.rows[0]?.name !== name)
        throw new Error("ISOLATION_GUARD_FAILED");
      const migrations = join(import.meta.dirname, "../prisma/migrations");
      for (const entry of (await readdir(migrations, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name))) {
        await isolated.query(
          await readFile(join(migrations, entry.name, "migration.sql"), "utf8"),
        );
      }
      process.env.POSTGRES_DB = name;
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      process.env.DEPLOYMENT_PROFILE = "local";
      process.env.API_HOST = "127.0.0.1";
      directory = await mkdtemp(join(tmpdir(), "montage-http-isolated-"));
      process.env.API_UPLOAD_TEMP_DIRECTORY = directory;
      prisma = new PrismaService();
      await prisma.$connect();
      const workerModulePath = new URL(
        "../../worker/src/infrastructure/pg-media-job.repository.ts",
        import.meta.url,
      ).href;
      const workerModule = (await import(workerModulePath)) as {
        PgMediaJobRepository: new (
          url: string,
          policy: "local-auto",
        ) => TestWorkerRepository;
      };
      worker = new workerModule.PgMediaJobRepository(
        base.toString(),
        "local-auto",
      );
      @Module({
        controllers: [MontageController],
        providers: [
          { provide: PrismaService, useValue: prisma },
          PrismaMontageRepository,
          { provide: MONTAGE_REPOSITORY, useExisting: PrismaMontageRepository },
          { provide: OBJECT_STORAGE, useValue: storage },
          UploadMontageAsset,
          MontageUploadAdmissionInterceptor,
          TempUploadLifecycleInterceptor,
        ],
      })
      class IsolatedModule {}
      app = await NestFactory.create(IsolatedModule, { logger: false });
      app.useGlobalPipes(
        new ValidationPipe({
          whitelist: true,
          forbidNonWhitelisted: true,
          exceptionFactory: (errors) =>
            new BadRequestException({
              code: "VALIDATION",
              message: JSON.stringify(errors),
            }),
        }),
      );
      app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
      await app.init();
      projectId = randomUUID();
      sourceId = randomUUID();
      await prisma.project.create({
        data: {
          id: projectId,
          idempotencyKey: randomUUID(),
          requestFingerprint: "test",
          name: "Isolated montage",
          status: "SOURCE_READY",
          source: {
            create: {
              id: sourceId,
              originalFilename: "source.mp4",
              contentType: "video/mp4",
              status: "READY",
              sizeBytes: 1n,
              sha256: "a".repeat(64),
              authorizations: {
                create: {
                  sourceVersion: 1,
                  status: "CLEARED",
                  basis: "LOCAL_DEVELOPMENT_AUTO",
                  declarationVersion: "local-development-auto-v1",
                  decidedAt: new Date(),
                },
              },
            },
          },
        },
      });
    }, 30_000);
    afterAll(async () => {
      await app?.close();
      await worker?.close();
      await prisma?.$disconnect();
      await isolated?.end();
      if (created && /^content_factory_montage_test_[a-f0-9]{32}$/.test(name))
        await admin.query(`DROP DATABASE "${name}"`);
      await admin?.end();
      if (directory) await rm(directory, { recursive: true, force: true });
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
    const upload = (key: string, kind = "INTRO") =>
      request(app.getHttpServer())
        .post(`/api/v1/projects/${projectId}/montage-assets`)
        .set("Idempotency-Key", key)
        .field("kind", kind)
        .attach(
          "file",
          Buffer.from("isolated fake media; probe tested separately"),
          { filename: "intro.mp4", contentType: "video/mp4" },
        );
    it("persists exact identity, recovers queue references, fences duplicate/restart, streams Range", async () => {
      const key = randomUUID();
      const response = await upload(key);
      expect(response.status, JSON.stringify(response.body)).toBe(202);
      const asset = response.body;
      expect(asset).toMatchObject({
        projectId,
        sourceId,
        kind: "INTRO",
        status: "PROBE_PENDING",
        revision: 2,
      });
      expect(asset.objectKey).toBeUndefined();
      expect((await upload(key).expect(202)).body.id).toBe(asset.id);
      await upload(key, "OUTRO").expect(409);
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets/${asset.id}/content`)
        .expect(409);
      const pipeline = new PrismaPipelineRepository(prisma);
      expect(await pipeline.getRunnableJobs(10)).toContainEqual({
        jobId: asset.probeJobId,
        attemptNumber: 1,
      });
      const claimed = await worker.claim(
        asset.probeJobId,
        "isolated-worker",
        60_000,
      );
      expect(claimed?.sourceObjectKey).toContain(`/montage/${asset.id}/`);
      expect(
        await worker.claim(asset.probeJobId, "duplicate-worker", 60_000),
      ).toBeNull();
      await isolated.query(
        `UPDATE "PipelineJob" SET "leaseExpiresAt"=now()-interval '1 second' WHERE "id"=$1`,
        [asset.probeJobId],
      );
      const result = {
        schemaVersion: 1 as const,
        width: 1280,
        height: 720,
        durationMs: 1000,
        hasAudio: false,
        version: "isolated-probe",
      };
      await expect(
        worker.completeMontageProbe(claimed!, result),
      ).rejects.toThrow("JOB_LEASE_LOST");
      await pipeline.recoverExpiredLeases(10);
      const restarted = await worker.claim(
        asset.probeJobId,
        "restarted-worker",
        60_000,
      );
      expect(restarted?.attemptNumber).toBe(2);
      await expect(
        worker.completeMontageProbe(claimed!, result),
      ).rejects.toThrow("JOB_LEASE_LOST");
      await worker.completeMontageProbe(restarted!, result);
      expect(
        await worker.claim(asset.probeJobId, "late-duplicate", 60_000),
      ).toBeNull();
      const ready = await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets/${asset.id}`)
        .expect(200);
      expect(ready.body).toMatchObject({
        id: asset.id,
        status: "READY",
        revision: 3,
        width: 1280,
      });
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets/${asset.id}/content`)
        .set("Range", "bytes=0-3")
        .expect(206)
        .expect("Content-Length", "4")
        .expect("Cache-Control", "private, no-store");
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets/${asset.id}/content`)
        .set("Range", "bytes=9999-")
        .expect(416);
      const list = await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets?limit=1`)
        .expect(200);
      expect(list.body.items[0].id).toBe(asset.id);
    });
    it("rejects manual policy and cross-project reads; terminal probe failure is isolated", async () => {
      const response = await upload(randomUUID()).expect(202);
      process.env.SOURCE_AUTHORIZATION_POLICY = "manual";
      await upload(randomUUID()).expect(403);
      await request(app.getHttpServer())
        .get(`/api/v1/projects/${projectId}/montage-assets`)
        .expect(403);
      process.env.SOURCE_AUTHORIZATION_POLICY = "local-auto";
      await request(app.getHttpServer())
        .get(
          `/api/v1/projects/${randomUUID()}/montage-assets/${response.body.id}`,
        )
        .expect(409);
      const claim = await worker.claim(
        response.body.probeJobId,
        "isolated-worker",
        60_000,
      );
      expect(
        await worker.fail(
          claim!,
          "MONTAGE_MEDIA_UNSUPPORTED",
          "Controlled invalid media",
          false,
        ),
      ).toBe("FAILED_FINAL");
      expect(
        await prisma.montageAsset.findUnique({
          where: { id: response.body.id },
        }),
      ).toMatchObject({ status: "FAILED_FINAL", cleanupStatus: "PENDING" });
      await upload(randomUUID()).expect(202);
    });
  },
);
