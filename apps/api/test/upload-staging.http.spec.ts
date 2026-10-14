import "reflect-metadata";
import { once } from "node:events";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import type { Server } from "node:http";
import { connect, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  Controller,
  Module,
  Post,
  UploadedFile,
  UseInterceptors,
  type INestApplication,
} from "@nestjs/common";
import { HttpAdapterHost, NestFactory, Reflector } from "@nestjs/core";
import { FileInterceptor } from "@nestjs/platform-express";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  root: "",
  available: 1_000n,
  fault: undefined as
    | { stage: "root-mkdir" | "request-mkdir" | "open" | "write"; code: string }
    | undefined,
  openWriters: 0,
  holdClose: false,
  closePending: undefined as (() => void) | undefined,
}));

vi.mock("../src/config/environment.js", () => ({
  apiEnvironment: () => ({
    uploadTempDirectory: state.root,
    uploadStagingSafetyBytes: 100,
  }),
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    mkdir: (...args: Parameters<typeof actual.mkdir>) => {
      if (state.fault?.stage === "root-mkdir" && args[0] === state.root) {
        return Promise.reject(faultError(state.fault.code));
      }
      return actual.mkdir(...args);
    },
    statfs: async (path: string, options: { bigint: true }) => ({
      ...(await actual.statfs(path, options)),
      bavail: state.available,
      bfree: state.available,
      blocks: state.available,
      bsize: 1n,
    }),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    mkdtempSync: (...args: Parameters<typeof actual.mkdtempSync>) => {
      if (state.fault?.stage === "request-mkdir") {
        throw faultError(state.fault.code);
      }
      return actual.mkdtempSync(...args);
    },
    createWriteStream: (
      path: Parameters<typeof actual.createWriteStream>[0],
      options: Parameters<typeof actual.createWriteStream>[1],
    ) => {
      // The descriptor and filesystem are real. Only the selected syscall
      // reports a controlled OS error; close can be held to prove ownership.
      const stream = actual.createWriteStream(path, {
        ...(typeof options === "object" ? options : {}),
        fs: {
          open(path, flags, mode, callback) {
            if (state.fault?.stage === "open") {
              process.nextTick(callback, faultError(state.fault.code));
              return;
            }
            actual.open(path, flags, mode, callback);
          },
          write(fd, buffer, offset, length, position, callback) {
            if (state.fault?.stage === "write") {
              process.nextTick(
                callback,
                faultError(state.fault.code),
                0,
                buffer,
              );
              return;
            }
            actual.write(fd, buffer, offset, length, position, callback);
          },
          close(fd, callback) {
            const close = () => actual.close(fd, callback);
            if (state.holdClose) state.closePending = close;
            else close();
          },
        },
      });
      let opened = false;
      stream.once("open", () => {
        opened = true;
        state.openWriters++;
      });
      stream.once("close", () => {
        if (opened) state.openWriters--;
      });
      return stream;
    },
  };
});

import { HttpExceptionFilter } from "../src/http-exception.filter.js";
import { SecureDiskStorage } from "../src/projects/presentation/secure-disk-storage.js";
import { TempUploadLifecycleInterceptor } from "../src/projects/presentation/temp-upload-lifecycle.interceptor.js";
import { UploadStagingAdmission } from "../src/projects/presentation/upload-staging-admission.metadata.js";
import {
  UPLOAD_STAGING_UNAVAILABLE,
  UploadStagingAdmissionService,
} from "../src/projects/presentation/upload-staging-admission.service.js";

function multipart(maximum: number) {
  return FileInterceptor("file", {
    storage: new SecureDiskStorage(),
    limits: { files: 1, fileSize: maximum },
  });
}

@Controller("staging-proof")
class UploadProofController {
  @Post("source")
  @UploadStagingAdmission(800)
  @UseInterceptors(TempUploadLifecycleInterceptor, multipart(800))
  source(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size };
  }

  @Post("montage")
  @UploadStagingAdmission(400)
  @UseInterceptors(TempUploadLifecycleInterceptor, multipart(400))
  montage(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size };
  }

  @Post("thumbnail")
  @UploadStagingAdmission(200)
  @UseInterceptors(TempUploadLifecycleInterceptor, multipart(200))
  thumbnail(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size };
  }

  @Post("reference")
  @UploadStagingAdmission(150)
  @UseInterceptors(TempUploadLifecycleInterceptor, multipart(150))
  reference(@UploadedFile() file: Express.Multer.File) {
    return { size: file.size };
  }
}

@Module({
  controllers: [UploadProofController],
  providers: [
    UploadStagingAdmissionService,
    {
      provide: TempUploadLifecycleInterceptor,
      inject: [Reflector, UploadStagingAdmissionService],
      useFactory: (
        reflector: Reflector,
        service: UploadStagingAdmissionService,
      ) => new TempUploadLifecycleInterceptor(reflector, service),
    },
  ],
})
class UploadProofModule {}

function faultError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("fixture-private-path-must-not-leak"), {
    code,
  });
}

async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 3_000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("HTTP fixture condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe("real HTTP upload staging ownership", () => {
  let app: INestApplication;
  let directory: string;
  let server: Server;
  const sockets = new Set<Socket>();

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "cf-api-upload-http-"));
    state.root = join(directory, "staging");
    state.available = 1_000n;
    state.fault = undefined;
    state.openWriters = 0;
    state.holdClose = false;
    state.closePending = undefined;
    app = await NestFactory.create(UploadProofModule, { logger: false });
    app.useGlobalFilters(new HttpExceptionFilter(app.get(HttpAdapterHost)));
    // Loopback, ephemeral test port; never touches 3000 or persistent services.
    await app.listen(0, "127.0.0.1");
    server = app.getHttpServer() as Server;
  });

  afterEach(async () => {
    state.holdClose = false;
    state.closePending?.();
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    await app?.close();
    await rm(directory, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function upload(route: string, bytes = 4) {
    return request(server)
      .post(`/staging-proof/${route}`)
      .attach("file", Buffer.alloc(bytes), "fixture.mp4");
  }

  function unavailable(body: unknown) {
    expect(body).toEqual({ error: UPLOAD_STAGING_UNAVAILABLE });
  }

  async function emptyStaging() {
    await eventually(async () => (await readdir(state.root)).length === 0);
  }

  async function partialSource(): Promise<Socket> {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("missing port");
    const socket = connect(address.port, "127.0.0.1");
    sockets.add(socket);
    socket.on("error", () => undefined);
    await once(socket, "connect");
    socket.write(
      "POST /staging-proof/source HTTP/1.1\r\n" +
        "Host: localhost\r\nContent-Type: multipart/form-data; boundary=proof\r\n" +
        "Content-Length: 1200\r\nConnection: close\r\n\r\n" +
        '--proof\r\nContent-Disposition: form-data; name="file"; filename="partial.mp4"\r\n' +
        "Content-Type: video/mp4\r\n\r\npartial bytes",
    );
    return socket;
  }

  it("shares one device across all four route budgets and different root paths", async () => {
    const socket = await partialSource();
    await eventually(() => state.openWriters === 1);
    const originalRoot = state.root;
    state.root = join(directory, "another-root-same-device");
    await mkdir(state.root, { mode: 0o700 });
    for (const route of ["montage", "thumbnail", "reference"]) {
      unavailable((await upload(route).expect(503)).body);
    }
    socket.destroy();
    await eventually(() => state.openWriters === 0);
    await eventually(async () => (await readdir(originalRoot)).length === 0);
    for (const route of ["montage", "thumbnail", "reference", "source"]) {
      expect((await upload(route).expect(201)).body).toEqual({ size: 4 });
      await emptyStaging();
    }
  });

  it("releases an admission completed after a raw socket abort, before allocation", async () => {
    const service = app.get(UploadStagingAdmissionService);
    const realReserve = service.reserve.bind(service);
    let resume: (() => void) | undefined;
    let entered = false;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vi.spyOn(service, "reserve").mockImplementationOnce(async (maximum) => {
      const reservation = await realReserve(maximum);
      entered = true;
      await gate;
      return reservation;
    });
    const serverClosed = new Promise<void>((resolve) => {
      server.once("connection", (connection) =>
        connection.once("close", resolve),
      );
    });
    const socket = await partialSource();
    await eventually(() => entered);
    socket.destroy();
    await once(socket, "close");
    await serverClosed;
    unavailable((await upload("thumbnail").expect(503)).body);
    resume?.();
    await eventually(async () => {
      try {
        return (await readdir(state.root)).length === 0;
      } catch {
        return false;
      }
    });
    expect(state.openWriters).toBe(0);
    await upload("source").expect(201);
    await emptyStaging();
  });

  it("keeps capacity until an aborted upload's actual descriptor closes", async () => {
    const socket = await partialSource();
    await eventually(() => state.openWriters === 1);
    state.holdClose = true;
    socket.destroy();
    await eventually(() => state.closePending !== undefined);
    unavailable((await upload("thumbnail").expect(503)).body);
    expect(state.openWriters).toBe(1);
    state.holdClose = false;
    state.closePending?.();
    await eventually(() => state.openWriters === 0);
    await emptyStaging();
    await upload("source").expect(201);
    await emptyStaging();
  });

  it.each(
    ["ENOSPC", "EDQUOT", "EFBIG"].flatMap((code) =>
      (["root-mkdir", "request-mkdir", "open", "write"] as const).map(
        (stage) => ({ code, stage }),
      ),
    ),
  )(
    "maps $code at $stage to generic503 and recovers with no residue",
    async ({ code, stage }) => {
      state.fault = { stage, code };
      unavailable((await upload("source").expect(503)).body);
      state.fault = undefined;
      expect(state.openWriters).toBe(0);
      expect((await upload("source").expect(201)).body).toEqual({ size: 4 });
      await emptyStaging();
      expect(state.openWriters).toBe(0);
    },
  );

  it("preserves413 and releases the maximum reservation after parser failure", async () => {
    await upload("thumbnail", 201).expect(413);
    await emptyStaging();
    await upload("source").expect(201);
    await emptyStaging();
    expect(state.openWriters).toBe(0);
  });
});
