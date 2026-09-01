import { spawn } from "node:child_process";
import { resolve } from "node:path";

const typescriptCli = resolve(
  import.meta.dirname,
  "../node_modules/typescript/bin/tsc",
);

const compile = spawn(
  process.execPath,
  [typescriptCli, "-p", "tsconfig.build.json", "--noEmitOnError"],
  { stdio: "inherit" },
);
const compileExitCode = await new Promise((resolve) =>
  compile.once("exit", (code) => resolve(code ?? 1)),
);
if (compileExitCode !== 0) process.exit(compileExitCode);

const compiler = spawn(
  process.execPath,
  [
    typescriptCli,
    "-p",
    "tsconfig.build.json",
    "--watch",
    "--preserveWatchOutput",
    "--noEmitOnError",
  ],
  { stdio: "inherit" },
);
const api = spawn(process.execPath, ["--watch", "dist/main.js"], {
  stdio: "inherit",
});

let stopping = false;
function stop(signal = "SIGTERM") {
  if (stopping) return;
  stopping = true;
  compiler.kill(signal);
  api.kill(signal);
}

process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));
compiler.once("exit", (code) => {
  if (!stopping && code !== 0) {
    stop();
    process.exitCode = code ?? 1;
  }
});
api.once("exit", (code) => {
  if (!stopping && code !== 0) {
    stop();
    process.exitCode = code ?? 1;
  }
});

await Promise.all([
  new Promise((resolve) => compiler.once("exit", resolve)),
  new Promise((resolve) => api.once("exit", resolve)),
]);
