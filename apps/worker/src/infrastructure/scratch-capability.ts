import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, statfs, unlink } from "node:fs/promises";
import { join, parse, resolve, sep } from "node:path";

export class ScratchCapabilityError extends Error {
  constructor() {
    super("CONFIG_SCRATCH_UNUSABLE");
    this.name = "ScratchCapabilityError";
  }
}

export interface ScratchFilesystemStats {
  bsize: bigint;
  blocks: bigint;
  bfree: bigint;
  bavail: bigint;
  files: bigint;
  ffree: bigint;
}

export interface ScratchCapabilityIo {
  geteuid(): number | undefined;
  randomUUID(): string;
  lstat(path: string): Promise<{
    isSymbolicLink(): boolean;
    isDirectory(): boolean;
    uid: number;
    mode: number;
  }>;
  mkdir(path: string, options: { mode: number }): Promise<void>;
  statfs(path: string): Promise<ScratchFilesystemStats>;
  open(
    path: string,
    flags: number,
    mode: number,
  ): Promise<{
    stat(): Promise<{
      isFile(): boolean;
      uid: number;
      mode: number;
      nlink: number;
    }>;
    writeFile(bytes: Uint8Array): Promise<void>;
    sync(): Promise<void>;
    read(
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ): Promise<{ bytesRead: number }>;
    close(): Promise<void>;
  }>;
  unlink(path: string): Promise<void>;
}

const nodeIo: ScratchCapabilityIo = {
  geteuid: () => process.geteuid?.(),
  randomUUID,
  lstat: (path) => lstat(path),
  mkdir: (path, options) => mkdir(path, options),
  statfs: (path) => statfs(path, { bigint: true }),
  open: (path, flags, mode) => open(path, flags, mode),
  unlink,
};

export function usableScratchFilesystem(disk: ScratchFilesystemStats): boolean {
  return (
    Object.values(disk).every((value) => typeof value === "bigint") &&
    disk.bsize > 0n &&
    disk.blocks > 0n &&
    disk.bfree >= 0n &&
    disk.bfree <= disk.blocks &&
    disk.bavail >= 0n &&
    disk.bavail <= disk.bfree &&
    disk.files >= 0n &&
    disk.ffree >= 0n &&
    disk.ffree <= disk.files
  );
}

/** Capability only: neither available-capacity admission nor persistence proof.
 * Existing roots must already be private; never chmod an arbitrary configured
 * directory or follow a symlink into another owner's data. */
export async function verifyScratchCapability(
  directory: string,
  io: ScratchCapabilityIo = nodeIo,
): Promise<void> {
  let probe: string | undefined;
  let handle: Awaited<ReturnType<ScratchCapabilityIo["open"]>> | undefined;
  try {
    const uid = io.geteuid();
    if (uid === undefined || uid === 0 || directory !== resolve(directory))
      throw new ScratchCapabilityError();
    const segments = directory.split(sep).filter(Boolean);
    if (
      segments.some((part) =>
        /^(?:se[aá]nova(?:-new)?|dockerserver)$/iu.test(part),
      ) ||
      /[\0\r\n]/.test(directory)
    )
      throw new ScratchCapabilityError();
    let current = parse(directory).root;
    for (const segment of segments) {
      current = join(current, segment);
      let information;
      try {
        information = await io.lstat(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        await io
          .mkdir(current, { mode: 0o700 })
          .catch((creationError: unknown) => {
            if ((creationError as NodeJS.ErrnoException).code !== "EEXIST")
              throw creationError;
          });
        information = await io.lstat(current);
      }
      if (information.isSymbolicLink() || !information.isDirectory())
        throw new ScratchCapabilityError();
    }
    const root = await io.lstat(directory);
    if (root.uid !== uid || (root.mode & 0o7777) !== 0o700)
      throw new ScratchCapabilityError();
    const disk = await io.statfs(directory);
    if (!usableScratchFilesystem(disk)) throw new ScratchCapabilityError();
    const basename = io.randomUUID();
    if (
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
        basename,
      )
    )
      throw new ScratchCapabilityError();
    const target = join(directory, `.cf-scratch-probe-${basename}`);
    handle = await io.open(
      target,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    // Record ownership only after exclusive creation succeeds.
    probe = target;
    const information = await handle.stat();
    if (
      !information.isFile() ||
      information.uid !== uid ||
      information.nlink !== 1 ||
      (information.mode & 0o7777) !== 0o600
    )
      throw new ScratchCapabilityError();
    const bytes = Buffer.from("content-factory scratch capability\n");
    await handle.writeFile(bytes);
    await handle.sync();
    const read = Buffer.alloc(bytes.length);
    let offset = 0;
    while (offset < read.length) {
      const result = await handle.read(
        read,
        offset,
        read.length - offset,
        offset,
      );
      if (result.bytesRead <= 0) throw new ScratchCapabilityError();
      offset += result.bytesRead;
    }
    if (!read.equals(bytes)) throw new ScratchCapabilityError();
    await handle.close();
    handle = undefined;
    await io.unlink(probe);
    probe = undefined;
  } catch {
    // Never expose the configured path, errno details or host filesystem data.
    throw new ScratchCapabilityError();
  } finally {
    await handle?.close().catch(() => undefined);
    if (probe) await io.unlink(probe).catch(() => undefined);
  }
}
