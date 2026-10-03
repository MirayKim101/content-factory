import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { captureOutput } from "./scan-oci-artifact.mjs";

const digest = (bytes) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
async function* chunks(bytes, count = 1) {
  for (let i = 0; i < count; i++) yield bytes;
}
function writer() {
  return {
    bytes: 0,
    async write(_buffer, _offset, length) {
      this.bytes += length;
      return { bytesWritten: length };
    },
  };
}

test("a verified OCI blob larger than 128 MiB uses its exact descriptor bound", async () => {
  const chunk = Buffer.alloc(1024 ** 2, 17);
  const count = 129;
  const hash = createHash("sha256");
  for (let i = 0; i < count; i++) hash.update(chunk);
  const descriptor = {
    size: chunk.length * count,
    digest: `sha256:${hash.digest("hex")}`,
  };
  const output = writer();
  assert.equal(
    await captureOutput(chunks(chunk, count), output, descriptor),
    descriptor.size,
  );
  assert.equal(output.bytes, descriptor.size);
});

test("scanner JSON still stops at 128 MiB regardless of blob capacity", async () => {
  const output = writer();
  await assert.rejects(
    captureOutput(chunks(Buffer.alloc(1024 ** 2), 129), output),
    /Scanner output exceeded 128 MiB/,
  );
  assert.equal(output.bytes, 128 * 1024 ** 2);
});

test("short, oversized and corrupt blob streams fail without a success result", async () => {
  const bytes = Buffer.from("exact blob");
  const descriptor = { size: bytes.length, digest: digest(bytes) };
  await assert.rejects(
    captureOutput(chunks(bytes.subarray(1)), writer(), descriptor),
    /OCI blob size mismatch/,
  );
  const oversized = writer();
  await assert.rejects(
    captureOutput(
      chunks(Buffer.concat([bytes, Buffer.from("!")])),
      oversized,
      descriptor,
    ),
    /OCI blob exceeded descriptor size/,
  );
  assert.equal(oversized.bytes, 0);
  await assert.rejects(
    captureOutput(chunks(Buffer.alloc(bytes.length)), writer(), descriptor),
    /OCI blob checksum mismatch/,
  );
});

test("invalid descriptors fail before writes and partial file writes are completed", async () => {
  const bytes = Buffer.from("exact blob");
  for (const descriptor of [
    { size: 0, digest: digest(bytes) },
    { size: 2 * 1024 ** 3, digest: digest(bytes) },
    { size: 1.5, digest: digest(bytes) },
    { size: bytes.length, digest: "not-sha256" },
  ]) {
    const output = writer();
    await assert.rejects(captureOutput(chunks(bytes), output, descriptor));
    assert.equal(output.bytes, 0);
  }
  const result = [];
  const output = {
    async write(buffer, offset, length) {
      const bytesWritten = Math.min(length, 3);
      result.push(buffer.subarray(offset, offset + bytesWritten));
      return { bytesWritten };
    },
  };
  await captureOutput(chunks(bytes), output, {
    size: bytes.length,
    digest: digest(bytes),
  });
  assert.deepEqual(Buffer.concat(result), bytes);
  await assert.rejects(
    captureOutput(chunks(bytes), { write: async () => ({ bytesWritten: 0 }) }),
    /Incomplete output write/,
  );
});
