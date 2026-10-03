import { constants } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  ScratchCapabilityError,
  type ScratchCapabilityIo,
  type ScratchFilesystemStats,
  verifyScratchCapability,
} from "../src/infrastructure/scratch-capability.js";

const root = "/owned/scratch";
const uuid = "00000000-0000-4000-8000-000000000001";
const probe = `${root}/.cf-scratch-probe-${uuid}`;
const directory = () => ({
  isSymbolicLink: () => false,
  isDirectory: () => true,
  uid: 1000,
  mode: 0o700,
});
const stats = (): ScratchFilesystemStats => ({
  bsize: 4096n,
  blocks: 100n,
  bfree: 80n,
  bavail: 70n,
  files: 100n,
  ffree: 80n,
});
function fakeIo() {
  const events: string[] = [];
  let bytes = Buffer.alloc(0);
  const handle = {
    stat: vi.fn(async () => ({
      isFile: (): boolean => true,
      uid: 1000,
      mode: 0o600,
      nlink: 1,
    })),
    writeFile: vi.fn(async (input: Uint8Array) => {
      events.push("write");
      bytes = Buffer.from(input);
    }),
    sync: vi.fn(async () => {
      events.push("sync");
    }),
    read: vi.fn(
      async (
        buffer: Buffer,
        offset: number,
        length: number,
        position: number,
      ) => {
        events.push("read");
        const count = Math.min(length, 7, bytes.length - position);
        bytes.copy(buffer, offset, position, position + count);
        return { bytesRead: count };
      },
    ),
    close: vi.fn(async () => {
      events.push("close");
    }),
  };
  const io = {
    geteuid: vi.fn((): number | undefined => 1000),
    randomUUID: vi.fn(() => uuid),
    lstat: vi.fn(async (_path: string) => directory()),
    mkdir: vi.fn(
      async (_path: string, _options: { mode: number }) => undefined,
    ),
    statfs: vi.fn(async (_path: string) => stats()),
    open: vi.fn(async (_path: string, _flags: number, _mode: number) => {
      events.push("open");
      return handle;
    }),
    unlink: vi.fn(async (_path: string) => {
      events.push("unlink");
    }),
  } satisfies ScratchCapabilityIo;
  return { io, handle, events };
}

async function unavailable(action: Promise<void>) {
  await expect(action).rejects.toBeInstanceOf(ScratchCapabilityError);
  await expect(action).rejects.toMatchObject({
    name: "ScratchCapabilityError",
    message: "CONFIG_SCRATCH_UNUSABLE",
  });
}

describe("scratch probe ordering and fault boundaries", () => {
  it("rejects invalid identities and lexical paths before the first filesystem call", async () => {
    for (const uid of [undefined, 0]) {
      const { io } = fakeIo();
      io.geteuid.mockReturnValue(uid);
      await unavailable(verifyScratchCapability(root, io));
      expect(io.lstat).not.toHaveBeenCalled();
    }
    for (const path of [
      "owned/scratch",
      "/owned/../scratch",
      "/owned/scratch/",
      "/owned/scr\0atch",
      "/owned/scratch\n",
      "/owned/Seanova/scratch",
      "/owned/Seánova/scratch",
      "/owned/SeAnOvA-NeW/scratch",
      "/owned/dockerServer/scratch",
    ]) {
      const { io } = fakeIo();
      await unavailable(verifyScratchCapability(path, io));
      expect(io.lstat).not.toHaveBeenCalled();
      expect(io.mkdir).not.toHaveBeenCalled();
      expect(io.open).not.toHaveBeenCalled();
      expect(io.unlink).not.toHaveBeenCalled();
    }
  });

  it("never follows symlinks or repairs wrong ownership/private permissions", async () => {
    for (const changed of [
      { uid: 0 },
      { uid: 2000 },
      { mode: 0o755 },
      { mode: 0o770 },
      { mode: 0o500 },
      { mode: 0o2700 },
      { isDirectory: () => false },
      { isSymbolicLink: () => true },
    ]) {
      const { io } = fakeIo();
      io.lstat.mockResolvedValue({ ...directory(), ...changed });
      await unavailable(verifyScratchCapability(root, io));
      expect(io.open).not.toHaveBeenCalled();
      expect(io.mkdir).not.toHaveBeenCalled();
      expect(io.unlink).not.toHaveBeenCalled();
    }
  });

  it("creates only missing components and revalidates a concurrent creation", async () => {
    for (const race of [false, true]) {
      const { io } = fakeIo();
      io.lstat.mockRejectedValueOnce(
        Object.assign(new Error("missing"), { code: "ENOENT" }),
      );
      if (race)
        io.mkdir.mockRejectedValueOnce(
          Object.assign(new Error("race"), { code: "EEXIST" }),
        );
      await verifyScratchCapability(root, io);
      expect(io.mkdir).toHaveBeenCalledExactlyOnceWith("/owned", {
        mode: 0o700,
      });
      expect(io.lstat.mock.calls.slice(0, 2)).toEqual([["/owned"], ["/owned"]]);
      expect(io.unlink).toHaveBeenCalledExactlyOnceWith(probe);
    }
    const { io } = fakeIo();
    io.lstat.mockRejectedValueOnce(
      Object.assign(new Error("missing"), { code: "ENOENT" }),
    );
    io.lstat.mockResolvedValueOnce({
      ...directory(),
      isSymbolicLink: () => true,
    });
    await unavailable(verifyScratchCapability(root, io));
    expect(io.open).not.toHaveBeenCalled();
    expect(io.unlink).not.toHaveBeenCalled();
  });

  it("validates statfs relationships but admits the capability of a low-space filesystem", async () => {
    const low = fakeIo();
    low.io.statfs.mockResolvedValue({
      ...stats(),
      bfree: 0n,
      bavail: 0n,
      ffree: 0n,
    });
    await verifyScratchCapability(root, low.io);
    for (const changed of [
      { bsize: 0n },
      { blocks: 0n },
      { bfree: -1n },
      { bfree: 101n },
      { bavail: -1n },
      { bavail: 81n },
      { files: -1n },
      { ffree: -1n },
      { ffree: 101n },
      { bsize: 4096 },
    ]) {
      const { io } = fakeIo();
      io.statfs.mockResolvedValue({
        ...stats(),
        ...changed,
      } as ScratchFilesystemStats);
      await unavailable(verifyScratchCapability(root, io));
      expect(io.open).not.toHaveBeenCalled();
    }
    const broken = fakeIo();
    broken.io.statfs.mockRejectedValue(new Error("private filesystem details"));
    await unavailable(verifyScratchCapability(root, broken.io));
    expect(broken.io.open).not.toHaveBeenCalled();
  });

  it("uses exclusive no-follow private creation, fsync, complete reads and exact-file cleanup", async () => {
    const { io, handle, events } = fakeIo();
    await verifyScratchCapability(root, io);
    expect(io.open).toHaveBeenCalledExactlyOnceWith(
      probe,
      constants.O_CREAT |
        constants.O_EXCL |
        constants.O_RDWR |
        constants.O_NOFOLLOW,
      0o600,
    );
    expect(events.indexOf("sync")).toBeGreaterThan(events.indexOf("write"));
    expect(events.indexOf("read")).toBeGreaterThan(events.indexOf("sync"));
    expect(handle.read.mock.calls.length).toBeGreaterThan(1);
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(io.unlink).toHaveBeenCalledExactlyOnceWith(probe);
    expect(events.slice(-2)).toEqual(["close", "unlink"]);
  });

  it("does not remove a file when exclusive creation failed", async () => {
    const { io, handle } = fakeIo();
    io.open.mockRejectedValue(new Error("private path"));
    await unavailable(verifyScratchCapability(root, io));
    expect(handle.close).not.toHaveBeenCalled();
    expect(io.unlink).not.toHaveBeenCalled();
  });

  it("closes and removes only its owned probe on every handle-stage failure", async () => {
    for (const stage of [
      "stat",
      "writeFile",
      "sync",
      "read",
      "close",
    ] as const) {
      const { io, handle } = fakeIo();
      handle[stage].mockRejectedValueOnce(new Error("private path and errno"));
      await unavailable(verifyScratchCapability(root, io));
      expect(handle.close).toHaveBeenCalledTimes(stage === "close" ? 2 : 1);
      expect(io.unlink).toHaveBeenCalledExactlyOnceWith(probe);
    }
    for (const changed of [
      { isFile: () => false },
      { uid: 0 },
      { nlink: 2 },
      { mode: 0o660 },
    ]) {
      const { io, handle } = fakeIo();
      handle.stat.mockResolvedValue({
        isFile: () => true,
        uid: 1000,
        mode: 0o600,
        nlink: 1,
        ...changed,
      });
      await unavailable(verifyScratchCapability(root, io));
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(io.unlink).toHaveBeenCalledExactlyOnceWith(probe);
    }
  });

  it("rejects zero/corrupt reads and treats unlink failure as failure with bounded retry", async () => {
    for (const corrupt of [false, true]) {
      const { io, handle } = fakeIo();
      handle.read.mockImplementation(async (buffer, offset, length) => {
        buffer.fill(1, offset, offset + length);
        return { bytesRead: corrupt ? length : 0 };
      });
      await unavailable(verifyScratchCapability(root, io));
      expect(handle.close).toHaveBeenCalledTimes(1);
      expect(io.unlink).toHaveBeenCalledExactlyOnceWith(probe);
    }
    const { io, handle } = fakeIo();
    io.unlink.mockRejectedValue(new Error("private unlink failure"));
    await unavailable(verifyScratchCapability(root, io));
    expect(handle.close).toHaveBeenCalledTimes(1);
    expect(io.unlink.mock.calls).toEqual([[probe], [probe]]);
  });
});
