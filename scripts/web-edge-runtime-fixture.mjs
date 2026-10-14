import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import http from "node:http";
import { once } from "node:events";

const block = Buffer.alloc(65536, 0x61);
// Larger than the 192 MiB container limit: full-body buffering cannot pass.
const largeBytes = 256 * 1024 * 1024;
const digest = createHash("sha256");
for (let i = 0; i < largeBytes / block.length; i++) digest.update(block);
const largeHash = digest.digest("hex");

if (process.argv[2] === "server") {
  let abortedUploads = 0;
  let firstUploadByteAt = null;
  http
    .createServer(async (req, res) => {
      req.on("error", () => {});
      res.on("error", () => {});
      if (req.url === "/api/v1/aborts")
        return res.end(JSON.stringify({ abortedUploads, firstUploadByteAt }));
      if (req.url === "/api/v1/slow-stream") {
        res.writeHead(200, { "Content-Type": "application/octet-stream" });
        res.write("start\n");
        const interval = setInterval(() => res.write("tick\n"), 1000);
        const timer = setTimeout(() => {
          clearInterval(interval);
          res.end("end\n");
        }, 65000);
        res.on("close", () => {
          clearInterval(interval);
          clearTimeout(timer);
        });
        return;
      }
      if (req.url === "/api/v1/large-download") {
        res.writeHead(200, { "Content-Length": largeBytes });
        try {
          for (let i = 0; i < largeBytes / block.length; i++)
            if (!res.write(block)) await once(res, "drain");
          res.end();
        } catch {}
        return;
      }
      if (req.url === "/api/v1/range") {
        if (req.headers.range === "bytes=2-5") {
          res.writeHead(206, {
            "Content-Range": "bytes 2-5/10",
            "Accept-Ranges": "bytes",
          });
          return res.end("2345");
        }
        res.writeHead(416, { "Content-Range": "bytes */10" });
        return res.end();
      }
      if (req.url === "/api/v1/reject") {
        res.writeHead(413, { "Content-Type": "application/json" });
        return res.end('{"code":"UPLOAD_TOO_LARGE"}');
      }
      if (req.url === "/api/v1/reject-type") {
        res.writeHead(415, { "Content-Type": "application/json" });
        return res.end('{"code":"UNSUPPORTED_MEDIA_TYPE"}');
      }
      if (req.url === "/api/v1/timeout") {
        res.writeHead(504, { "Content-Type": "application/json" });
        return res.end('{"code":"FIXTURE_UPSTREAM_TIMEOUT"}');
      }
      if (req.url === "/api/v1/upload") {
        let bytes = 0;
        const hash = createHash("sha256");
        req.on("aborted", () => {
          abortedUploads++;
        });
        try {
          for await (const chunk of req) {
            firstUploadByteAt ??= Date.now();
            bytes += chunk.length;
            hash.update(chunk);
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ bytes, sha256: hash.digest("hex") }));
        } catch {}
        return;
      }
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          method: req.method,
          url: req.url,
          headers: req.headers,
        }),
      );
    })
    .listen(3001, "0.0.0.0");
} else {
  const base = "http://edge:8080";
  const results = [];
  async function check(name, action) {
    const start = Date.now();
    await action();
    results.push({ name, elapsedMs: Date.now() - start });
    console.log(JSON.stringify(results.at(-1)));
  }
  await check("liveness", async () =>
    assert.equal(await fetch(`${base}/healthz`).then((r) => r.text()), "ok"),
  );
  await check("SPA deep link and shell cache", async () => {
    const a = await fetch(`${base}/horizontal?projectIds=diagnostic`);
    assert.equal(a.status, 200);
    assert.equal(a.headers.get("cache-control"), "no-store");
    const html = await a.text();
    assert.match(html, /__NUXT/);
    const asset = html.match(/(?:src|href)="(\/_nuxt\/[^"]+\.js)"/);
    assert.ok(asset);
    const r = await fetch(`${base}${asset[1]}`);
    assert.equal(r.status, 200);
    assert.equal(
      r.headers.get("cache-control"),
      "public, max-age=31536000, immutable",
    );
    assert.equal((await fetch(`${base}/_nuxt/missing.js`)).status, 404);
    assert.equal((await fetch(`${base}/missing.PNG`)).status, 404);
  });
  await check(
    "fixed API route method query idempotency range and spoofed forwarding",
    async () => {
      const r = await fetch(`${base}/api/v1/echo?target=http://invalid.test`, {
        method: "POST",
        headers: {
          "Idempotency-Key": "edge-fixture-key",
          "X-Request-ID": "edge-fixture-id",
          Range: "bytes=2-5",
          Forwarded: "for=evil",
          "X-Forwarded-For": "evil",
          "X-Forwarded-Host": "evil",
          "X-Forwarded-Proto": "evil",
          "Content-Type": "application/octet-stream",
        },
        body: "abc",
      });
      const b = await r.json();
      assert.equal(b.method, "POST");
      assert.equal(b.url, "/api/v1/echo?target=http://invalid.test");
      assert.equal(b.headers["idempotency-key"], "edge-fixture-key");
      assert.equal(b.headers["x-request-id"], "edge-fixture-id");
      assert.equal(b.headers.range, "bytes=2-5");
      assert.equal(b.headers["content-type"], "application/octet-stream");
      for (const [key, value] of Object.entries(b.headers))
        if (key === "forwarded" || key.startsWith("x-forwarded-"))
          assert.doesNotMatch(value, /evil/);
      assert.equal(
        (await fetch(`${base}/api/v10`)).headers
          .get("content-type")
          ?.includes("text/html"),
        true,
      );
    },
  );
  await check("Range 206 and 416", async () => {
    let r = await fetch(`${base}/api/v1/range`, {
      headers: { Range: "bytes=2-5" },
    });
    assert.equal(r.status, 206);
    assert.equal(r.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await r.text(), "2345");
    r = await fetch(`${base}/api/v1/range`, {
      headers: { Range: "bytes=20-" },
    });
    assert.equal(r.status, 416);
    assert.equal(r.headers.get("content-range"), "bytes */10");
  });
  await check("upstream JSON 413 and 504 pass-through", async () => {
    for (const [path, status, code] of [
      ["reject", 413, "UPLOAD_TOO_LARGE"],
      ["reject-type", 415, "UNSUPPORTED_MEDIA_TYPE"],
      ["timeout", 504, "FIXTURE_UPSTREAM_TIMEOUT"],
    ]) {
      const r = await fetch(`${base}/api/v1/${path}`);
      assert.equal(r.status, status);
      assert.equal((await r.json()).code, code);
    }
  });
  // request_body max_size limits bytes read, not a Content-Length declaration.
  // Application JSON 413 propagation above is distinct from that 10 GiB limit.
  await check("256MiB streaming upload checksum", async () => {
    const prefix = Buffer.from(
      '--edge-fixture\r\nContent-Disposition: form-data; name="file"; filename="diagnostic.mp4"\r\nContent-Type: video/mp4\r\n\r\n',
    );
    const suffix = Buffer.from("\r\n--edge-fixture--\r\n");
    const hash = createHash("sha256").update(prefix);
    for (let i = 0; i < largeBytes / block.length; i++) hash.update(block);
    hash.update(suffix);
    const body = async function* () {
      yield prefix;
      for (let i = 0; i < largeBytes / block.length; i++) yield block;
      yield suffix;
    };
    const r = await fetch(`${base}/api/v1/upload`, {
      method: "POST",
      headers: { "Content-Type": "multipart/form-data; boundary=edge-fixture" },
      body: body(),
      duplex: "half",
    });
    assert.deepEqual(await r.json(), {
      bytes: largeBytes + prefix.length + suffix.length,
      sha256: hash.digest("hex"),
    });
  });
  await check("256MiB streaming download checksum", async () => {
    const r = await fetch(`${base}/api/v1/large-download`);
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of r.body) {
      hash.update(chunk);
      bytes += chunk.length;
    }
    assert.equal(bytes, largeBytes);
    assert.equal(hash.digest("hex"), largeHash);
  });
  await check("mid-upload disconnect reaches upstream", async () => {
    const req = http.request(`${base}/api/v1/upload`, {
      method: "POST",
      headers: { "Content-Length": largeBytes },
    });
    req.on("error", () => {});
    req.write(block);
    await new Promise((r) => setTimeout(r, 300));
    req.destroy();
    let observed = false;
    for (let i = 0; i < 30; i++) {
      const b = await fetch(`${base}/api/v1/aborts`).then((r) => r.json());
      if (b.abortedUploads > 0) {
        observed = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.equal(observed, true);
  });
  await check(
    "actual stream survives 65 seconds and first byte is immediate",
    async () => {
      const started = Date.now();
      const r = await fetch(`${base}/api/v1/slow-stream`);
      const reader = r.body.getReader();
      const first = await reader.read();
      assert.match(Buffer.from(first.value).toString(), /start/);
      assert.ok(Date.now() - started < 3000);
      let rest = "";
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        rest += Buffer.from(item.value).toString();
      }
      assert.match(rest, /end/);
      assert.ok(Date.now() - started >= 64000);
    },
  );
  console.log(
    JSON.stringify({ status: "PASS", cases: results, largeBytes, largeHash }),
  );
}
