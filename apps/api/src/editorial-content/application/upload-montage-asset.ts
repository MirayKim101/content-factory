import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, rm, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Inject, Injectable } from "@nestjs/common";
import {
  OBJECT_STORAGE,
  type ObjectStorage,
} from "../../projects/application/object-storage.port.js";
import { inspectThumbnail, THUMBNAIL_MAX_BYTES } from "../domain/editorial.js";
import {
  MONTAGE_KINDS,
  MONTAGE_MAX_BYTES,
  MONTAGE_UPLOAD_TIMEOUT_MS,
  MontageError,
  type MontageKind,
} from "../domain/montage-asset.js";
import {
  MONTAGE_REPOSITORY,
  type MontageRepository,
} from "./montage-repository.port.js";

@Injectable()
export class UploadMontageAsset {
  constructor(
    @Inject(MONTAGE_REPOSITORY) private readonly repository: MontageRepository,
    @Inject(OBJECT_STORAGE) private readonly storage: ObjectStorage,
  ) {}

  async execute(input: {
    projectId: string;
    kind: MontageKind;
    idempotencyKey: string;
    originalFilename: string;
    declaredContentType: string;
    filePath: string;
  }) {
    try {
      if (!MONTAGE_KINDS.includes(input.kind))
        throw new MontageError(
          "MONTAGE_KIND_INVALID",
          "Choose a supported montage kind.",
          400,
        );
      const context = await this.repository.authorize(input.projectId);
      const size = await stat(input.filePath);
      const limit =
        input.kind === "BANNER" ? THUMBNAIL_MAX_BYTES : MONTAGE_MAX_BYTES;
      if (!size.isFile() || size.size <= 0 || size.size > limit)
        throw new MontageError(
          "MONTAGE_SIZE_INVALID",
          "File exceeds montage size limits.",
          413,
        );
      let dimensions: { width: number; height: number } | null = null;
      if (input.kind === "BANNER") {
        const bytes = await readFile(input.filePath); // Bounded to 10 MiB; MP4 is never buffered.
        rejectAnimation(bytes, input.declaredContentType);
        dimensions = inspectThumbnail(bytes, input.declaredContentType);
      } else if (input.declaredContentType !== "video/mp4") {
        throw new MontageError(
          "MONTAGE_MIME_UNSUPPORTED",
          "Video montage assets require video/mp4.",
          415,
        );
      }
      const hash = createHash("sha256");
      for await (const chunk of createReadStream(input.filePath))
        hash.update(chunk);
      const sha256 = hash.digest("hex");
      const originalFilename = basename(
        input.originalFilename.replaceAll("\\", "/"),
      ).slice(0, 255);
      const requestFingerprint = createHash("sha256")
        .update(
          JSON.stringify({
            version: 1,
            projectId: input.projectId,
            ...context,
            kind: input.kind,
            originalFilename,
            contentType: input.declaredContentType,
            size: size.size,
            sha256,
          }),
        )
        .digest("hex");
      const replay = await this.repository.findReplay(
        input.projectId,
        input.idempotencyKey,
      );
      if (replay) {
        if (replay.requestFingerprint !== requestFingerprint)
          throw new MontageError(
            "IDEMPOTENCY_CONFLICT",
            "Key belongs to a different montage upload.",
            409,
          );
        if (replay.status === "UPLOADING")
          throw new MontageError(
            "MONTAGE_UPLOAD_IN_PROGRESS",
            "This upload is still being finalized. Retry the same request later.",
            409,
          );
        return replay;
      }
      const id = randomUUID();
      const objectKey = `editorial/${input.projectId}/montage/${id}/original`;
      try {
        await this.repository.create({
          id,
          projectId: input.projectId,
          ...context,
          kind: input.kind,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          objectKey,
          originalFilename,
          contentType: input.declaredContentType,
          sizeBytes: BigInt(size.size),
          sha256,
          width: dimensions?.width ?? null,
          height: dimensions?.height ?? null,
          uploadExpiresAt: new Date(
            Date.now() + MONTAGE_UPLOAD_TIMEOUT_MS + 60_000,
          ),
        });
      } catch (error) {
        // Re-read even on an ambiguous INSERT commit; never write bytes unless this invocation owns the intent.
        const concurrent = await this.repository.findReplay(
          input.projectId,
          input.idempotencyKey,
        );
        if (!concurrent) throw error;
        if (concurrent.requestFingerprint !== requestFingerprint)
          throw new MontageError(
            "IDEMPOTENCY_CONFLICT",
            "Key belongs to a different montage upload.",
            409,
          );
        if (concurrent.status === "UPLOADING")
          throw new MontageError(
            "MONTAGE_UPLOAD_IN_PROGRESS",
            "Upload intent is being recovered.",
            409,
          );
        return concurrent;
      }
      let receipt;
      try {
        receipt = await this.storage.putFile({
          objectKey,
          filePath: input.filePath,
          contentType: input.declaredContentType,
          sha256,
          signal: AbortSignal.timeout(MONTAGE_UPLOAD_TIMEOUT_MS),
        });
      } catch {
        // Leave durable intent for HEAD recovery: upload may have committed remotely.
        throw new MontageError(
          "MONTAGE_STORAGE_RETRYABLE",
          "Storage outcome is being recovered; retry this key later.",
          503,
        );
      }
      try {
        return await this.repository.finalize(id, receipt);
      } catch {
        // Never delete on an uncertain commit. Reconciliation is the single cleanup owner.
        const authoritative = await this.repository
          .inspect(id)
          .catch(() => null);
        if (authoritative && authoritative.status !== "UPLOADING")
          return authoritative;
        throw new MontageError(
          "MONTAGE_FINALIZATION_RETRYABLE",
          "Upload finalization is being recovered.",
          503,
        );
      }
    } finally {
      await rm(input.filePath, { force: true });
    }
  }
}

export function rejectAnimation(bytes: Buffer, contentType: string): void {
  // Inspect chunk names, not arbitrary compressed image bytes.
  if (contentType === "image/png") {
    for (let offset = 8; offset + 12 <= bytes.length;) {
      const length = bytes.readUInt32BE(offset);
      if (
        ["acTL", "fcTL", "fdAT"].includes(
          bytes.toString("ascii", offset + 4, offset + 8),
        )
      )
        throw new MontageError(
          "MONTAGE_ANIMATION_UNSUPPORTED",
          "Animated banners are unsupported.",
          422,
        );
      offset += length + 12;
    }
  }
  if (contentType === "image/webp") {
    for (let offset = 12; offset + 8 <= bytes.length;) {
      const length = bytes.readUInt32LE(offset + 4);
      const kind = bytes.toString("ascii", offset, offset + 4);
      if (
        kind === "ANIM" ||
        kind === "ANMF" ||
        (kind === "VP8X" && ((bytes[offset + 8] ?? 0) & 2) !== 0)
      )
        throw new MontageError(
          "MONTAGE_ANIMATION_UNSUPPORTED",
          "Animated banners are unsupported.",
          422,
        );
      offset += length + 8 + (length % 2);
    }
  }
}
