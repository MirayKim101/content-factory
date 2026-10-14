import type { Stats } from "node:fs";
import { lstat, mkdir, statfs } from "node:fs/promises";
import { join, parse, relative, resolve, sep } from "node:path";

import { HttpException, HttpStatus, Injectable } from "@nestjs/common";

import { apiEnvironment } from "../../config/environment.js";

export const UPLOAD_STAGING_UNAVAILABLE = {
  code: "UPLOAD_STAGING_UNAVAILABLE",
  message: "Upload staging capacity is temporarily unavailable.",
} as const;

const PRIVATE_DIRECTORY_MODE = 0o700;
const PROTECTED_DIRECTORY_NAMES = new Set([
  "seanova",
  "seanova-new",
  "dockerserver",
]);

export class UploadStagingUnavailableException extends HttpException {
  constructor() {
    super(UPLOAD_STAGING_UNAVAILABLE, HttpStatus.SERVICE_UNAVAILABLE);
  }
}

interface DeviceLedger {
  reservedBytes: bigint;
}

export class UploadStagingReservation {
  private openWriters = 0;
  private releaseRequested = false;
  private released = false;

  constructor(
    private readonly ledger: DeviceLedger,
    private readonly reservedBytes: bigint,
    readonly rootDirectory: string,
  ) {}

  beginWriter(): () => void {
    if (this.releaseRequested) throw new UploadStagingUnavailableException();
    this.openWriters += 1;
    let closed = false;
    return () => {
      if (closed) return;
      closed = true;
      this.openWriters -= 1;
      this.releaseIfClosed();
    };
  }

  release(): void {
    this.releaseRequested = true;
    this.releaseIfClosed();
  }

  private releaseIfClosed(): void {
    if (this.released || !this.releaseRequested || this.openWriters !== 0)
      return;
    this.released = true;
    this.ledger.reservedBytes -= this.reservedBytes;
  }
}

@Injectable()
export class UploadStagingAdmissionService {
  private readonly ledgers = new Map<string, DeviceLedger>();

  async reserve(maximumBytes: number): Promise<UploadStagingReservation> {
    if (!Number.isSafeInteger(maximumBytes) || maximumBytes <= 0) {
      throw new UploadStagingUnavailableException();
    }
    const config = apiEnvironment();
    try {
      const rootDirectory = await ensurePrivateUploadRoot(
        config.uploadTempDirectory,
      );
      const [identity, capacity] = await Promise.all([
        lstat(rootDirectory, { bigint: true }),
        statfs(rootDirectory, { bigint: true }),
      ]);
      assertSaneFilesystemCapacity(capacity);
      const device = identity.dev.toString();
      const ledger = this.ledgers.get(device) ?? { reservedBytes: 0n };
      this.ledgers.set(device, ledger);
      const available = capacity.bavail * capacity.bsize;
      const requested = BigInt(maximumBytes);
      const safety = BigInt(config.uploadStagingSafetyBytes);
      if (
        available < safety ||
        available - safety < ledger.reservedBytes + requested
      ) {
        throw new UploadStagingUnavailableException();
      }
      ledger.reservedBytes += requested;
      return new UploadStagingReservation(ledger, requested, rootDirectory);
    } catch (error) {
      if (error instanceof UploadStagingUnavailableException) throw error;
      throw new UploadStagingUnavailableException();
    }
  }
}

export async function ensurePrivateUploadRoot(
  rootDirectory: string,
): Promise<string> {
  assertNoProtectedPathSegment(rootDirectory);
  const normalizedRoot = resolve(rootDirectory);
  assertNoProtectedPathSegment(normalizedRoot);
  const parsedRoot = parse(normalizedRoot);
  const segments = relative(parsedRoot.root, normalizedRoot)
    .split(sep)
    .filter(Boolean);
  if (segments.length === 0) throw new UploadStagingUnavailableException();
  let currentDirectory = parsedRoot.root;

  for (const [index, segment] of segments.entries()) {
    currentDirectory = join(currentDirectory, segment);
    let attributes: Stats;
    try {
      attributes = await lstat(currentDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await mkdir(currentDirectory, {
          mode: PRIVATE_DIRECTORY_MODE,
          recursive: false,
        });
      } catch (mkdirError) {
        if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw mkdirError;
        }
      }
      attributes = await lstat(currentDirectory);
    }

    if (attributes.isSymbolicLink() || !attributes.isDirectory()) {
      throw new UploadStagingUnavailableException();
    }
    if (index === segments.length - 1) {
      assertPrivateRuntimeOwnedDirectory(attributes);
    }
  }

  return normalizedRoot;
}

function assertSaneFilesystemCapacity(capacity: {
  bavail: unknown;
  bfree: unknown;
  blocks: unknown;
  bsize: unknown;
}): asserts capacity is {
  bavail: bigint;
  bfree: bigint;
  blocks: bigint;
  bsize: bigint;
} {
  if (
    typeof capacity.bavail !== "bigint" ||
    typeof capacity.bfree !== "bigint" ||
    typeof capacity.blocks !== "bigint" ||
    typeof capacity.bsize !== "bigint" ||
    capacity.bsize <= 0n ||
    capacity.bavail < 0n ||
    capacity.bfree < 0n ||
    capacity.blocks < 0n ||
    capacity.bavail > capacity.bfree ||
    capacity.bfree > capacity.blocks
  ) {
    throw new UploadStagingUnavailableException();
  }
}

function assertNoProtectedPathSegment(pathname: string): void {
  const segments = pathname.split(sep).filter(Boolean);
  if (segments.some(isProtectedDirectoryName)) {
    throw new UploadStagingUnavailableException();
  }
}

function isProtectedDirectoryName(segment: string): boolean {
  const normalized = segment
    .normalize("NFKD")
    .replace(/\p{Mark}/gu, "")
    .toLowerCase();
  return PROTECTED_DIRECTORY_NAMES.has(normalized);
}

function assertPrivateRuntimeOwnedDirectory(attributes: Stats): void {
  if ((attributes.mode & 0o7777) !== PRIVATE_DIRECTORY_MODE) {
    throw new UploadStagingUnavailableException();
  }
  const runtimeUid = process.getuid?.();
  if (runtimeUid !== undefined && attributes.uid !== runtimeUid) {
    throw new UploadStagingUnavailableException();
  }
}

export function isUploadStagingFilesystemError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOSPC" || code === "EDQUOT" || code === "EFBIG";
}
