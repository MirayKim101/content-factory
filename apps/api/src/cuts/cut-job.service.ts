import { randomUUID } from "node:crypto";

import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  CutJobRepository,
  CutJobView,
  CutQueuePublisher,
  PageCursor,
} from "@content-factory/manual-cut";

import { apiEnvironment } from "../config/environment.js";
import { CUT_JOB_REPOSITORY, CUT_QUEUE_PUBLISHER } from "./cut.tokens.js";

@Injectable()
export class CutJobService {
  constructor(
    @Inject(CUT_JOB_REPOSITORY) private readonly jobs: CutJobRepository,
    @Inject(CUT_QUEUE_PUBLISHER) private readonly queue: CutQueuePublisher,
  ) {}

  async create(input: {
    projectId: string;
    idempotencyKey: string;
    startMs: number;
    endMs: number;
  }): Promise<CutJobView> {
    const now = new Date();
    const config = apiEnvironment();
    const result = await this.jobs.create({
      id: randomUUID(),
      projectId: input.projectId,
      idempotencyKey: input.idempotencyKey,
      startMs: input.startMs,
      endMs: input.endMs,
      now,
      admissionDeadlineAt: new Date(
        now.getTime() + config.cutAdmissionTimeoutMs,
      ),
      maxAttempts: config.cutMaxAttempts,
    });
    if (result.outcome !== "CREATED" && result.outcome !== "EXISTING") {
      switch (result.outcome) {
        case "PROJECT_NOT_FOUND":
          this.notFound("PROJECT_NOT_FOUND", "Project was not found.");
        case "SOURCE_NOT_READY":
          this.conflict("SOURCE_NOT_READY", "The source is not ready.");
        case "SOURCE_NOT_AUTHORIZED":
          this.conflict(
            "SOURCE_NOT_AUTHORIZED",
            "The exact source version is not authorized.",
          );
        case "IDEMPOTENCY_CONFLICT":
          this.conflict(
            "IDEMPOTENCY_CONFLICT",
            "The idempotency key belongs to a different cut request.",
          );
      }
    }
    const job = result.job;
    if (result.outcome === "CREATED") await this.publishBestEffort(job.id);
    return job;
  }

  async get(projectId: string, jobId: string): Promise<CutJobView> {
    const result = await this.jobs.get(projectId, jobId);
    if (result.outcome === "FOUND") return result.job;
    this.throwRead(result.outcome);
  }

  async list(
    projectId: string,
    limit: number,
    cursor: PageCursor | null,
  ): Promise<CutJobView[]> {
    const result = await this.jobs.list(projectId, limit, cursor);
    if (result.outcome === "FOUND") return result.jobs;
    this.throwRead(result.outcome);
  }

  repository(): CutJobRepository {
    return this.jobs;
  }

  private async publishBestEffort(jobId: string): Promise<void> {
    const timeout = apiEnvironment().cutQueuePublishTimeoutMs;
    await Promise.race([
      this.queue.publish(jobId),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeout);
        timer.unref();
      }),
    ]).catch(() => undefined);
  }

  private throwRead(
    outcome:
      | "PROJECT_NOT_FOUND"
      | "SOURCE_NOT_READY"
      | "SOURCE_NOT_AUTHORIZED"
      | "CUT_JOB_NOT_FOUND",
  ): never {
    if (outcome === "PROJECT_NOT_FOUND")
      this.notFound("PROJECT_NOT_FOUND", "Project was not found.");
    if (outcome === "CUT_JOB_NOT_FOUND")
      this.notFound("CUT_JOB_NOT_FOUND", "Cut job was not found.");
    if (outcome === "SOURCE_NOT_READY")
      this.conflict("SOURCE_NOT_READY", "The source is not ready.");
    this.conflict(
      "SOURCE_NOT_AUTHORIZED",
      "The exact source version is not authorized.",
    );
  }

  private notFound(code: string, message: string): never {
    throw new NotFoundException({ code, message });
  }

  private conflict(code: string, message: string): never {
    throw new ConflictException({ code, message });
  }
}
