import { createHash } from "node:crypto";
import { deflateSync, inflateSync } from "node:zlib";

import {
  THUMBNAIL_CONTRACT_VERSION,
  validateThumbnailCandidate,
  type ThumbnailCandidate,
} from "@content-factory/contracts";

export const LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION =
  "local-no-likeness-png-v1";
export const LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION =
  "local-abstract-thumbnail-prompt-v1";
export const LOCAL_NO_LIKENESS_COST_BASIS_VERSION =
  "local-direct-provider-cost-zero-v1";

const WIDTH = 1280;
const HEIGHT = 720;

export type LocalThumbnailOutput = Readonly<{
  bytes: Buffer;
  candidate: ThumbnailCandidate;
  safetyDecision: Readonly<{
    version: "no-likeness-safety-v1";
    realisticPersonRequested: false;
    referenceImageUsed: false;
    externalProviderUsed: false;
  }>;
  directCostMicrousd: 0;
  costBasisVersion: typeof LOCAL_NO_LIKENESS_COST_BASIS_VERSION;
}>;

/** Deterministic abstract PNG. It encodes no text, face or reference bytes. */
export function generateLocalNoLikenessThumbnail(input: {
  candidateId: string;
  seedFingerprint: string;
}): LocalThumbnailOutput {
  if (!/^[0-9a-f]{64}$/.test(input.seedFingerprint))
    throw new Error("THUMBNAIL_SEED_INVALID");
  const palette = createHash("sha256")
    .update(`thumbnail-palette-v1:${input.seedFingerprint}`)
    .digest();
  const scanlines = Buffer.alloc((WIDTH * 3 + 1) * HEIGHT);
  for (let y = 0; y < HEIGHT; y += 1) {
    const row = y * (WIDTH * 3 + 1);
    scanlines[row] = 0;
    for (let x = 0; x < WIDTH; x += 1) {
      const offset = row + 1 + x * 3;
      const band = ((x >> 6) + (y >> 6)) & 7;
      scanlines[offset] = (palette[band]! + ((x * 71) / WIDTH)) & 255;
      scanlines[offset + 1] =
        (palette[8 + band]! + ((y * 83) / HEIGHT)) & 255;
      scanlines[offset + 2] =
        (palette[16 + band]! + (((x + y) * 47) / (WIDTH + HEIGHT))) & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(WIDTH, 0);
  header.writeUInt32BE(HEIGHT, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const bytes = Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
  inspectLocalThumbnailPng(bytes);
  const candidate: ThumbnailCandidate = {
    id: input.candidateId,
    contractVersion: THUMBNAIL_CONTRACT_VERSION,
    adapterVersion: LOCAL_NO_LIKENESS_THUMBNAIL_ADAPTER_VERSION,
    promptBasisVersion: LOCAL_NO_LIKENESS_PROMPT_BASIS_VERSION,
    contentType: "image/png",
    sizeBytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    likeness: "NONE",
  };
  validateThumbnailCandidate(candidate);
  return {
    bytes,
    candidate,
    safetyDecision: {
      version: "no-likeness-safety-v1",
      realisticPersonRequested: false,
      referenceImageUsed: false,
      externalProviderUsed: false,
    },
    directCostMicrousd: 0,
    costBasisVersion: LOCAL_NO_LIKENESS_COST_BASIS_VERSION,
  };
}

export function inspectLocalThumbnailPng(bytes: Buffer): void {
  if (
    bytes.length < 45 ||
    bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a"
  )
    throw new Error("THUMBNAIL_PNG_CORRUPT");
  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  let ended = false;
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new Error("THUMBNAIL_PNG_CORRUPT");
    const type = bytes.subarray(offset + 4, offset + 8).toString("ascii");
    const data = bytes.subarray(offset + 8, offset + 8 + length);
    const expectedCrc = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== expectedCrc)
      throw new Error("THUMBNAIL_PNG_CORRUPT");
    if (type === "IHDR") {
      if (length !== 13 || data[8] !== 8 || data[9] !== 2)
        throw new Error("THUMBNAIL_PNG_CORRUPT");
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
    } else if (type === "IDAT") idat.push(data);
    else if (type === "IEND") ended = true;
    offset = end;
  }
  if (offset !== bytes.length || !ended || width !== WIDTH || height !== HEIGHT || idat.length === 0)
    throw new Error("THUMBNAIL_PNG_CORRUPT");
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== (WIDTH * 3 + 1) * HEIGHT)
    throw new Error("THUMBNAIL_PNG_CORRUPT");
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), 8 + data.length);
  return chunk;
}

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1)
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
