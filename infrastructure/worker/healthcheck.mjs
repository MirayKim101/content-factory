#!/usr/bin/env node
import net from "node:net";
import { spawnSync } from "node:child_process";

const timeoutMs = 3_000;
const requiredCommands = [
  process.env.FFMPEG_PATH || "/usr/bin/ffmpeg",
  process.env.FFPROBE_PATH || "/usr/bin/ffprobe",
];

for (const command of requiredCommands) {
  const result = spawnSync(command, ["-version"], {
    stdio: "ignore",
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    process.exit(1);
  }
}

async function connect(host, port) {
  await new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(
      () => socket.destroy(new Error("timeout")),
      timeoutMs,
    );
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

try {
  await connect(
    process.env.POSTGRES_HOST || "postgres",
    Number(process.env.POSTGRES_PORT || 5432),
  );
  await connect(
    process.env.REDIS_HOST || "redis",
    Number(process.env.REDIS_PORT || 6379),
  );
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const response = await fetch(
    `${process.env.S3_ENDPOINT || "http://minio:9000"}/minio/health/ready`,
    {
      signal: controller.signal,
    },
  );
  clearTimeout(timer);
  if (!response.ok) process.exit(1);
} catch {
  process.exit(1);
}
