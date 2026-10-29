import { spawn } from "node:child_process";
import { resolve } from "node:path";

const root = process.cwd();

await new Promise((resolvePromise, reject) => {
  const build = spawn(process.execPath, [resolve(root, "scripts/build-web.mjs")], {
    stdio: "inherit",
  });
  build.on("exit", (code) =>
    code === 0 ? resolvePromise(undefined) : reject(new Error("Web build failed")),
  );
});

const tsx = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const child = spawn(tsx, ["watch", "src/server/index.ts"], {
  stdio: "inherit",
  env: process.env,
  shell: process.platform === "win32",
});

child.on("exit", (code) => process.exit(code ?? 0));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
