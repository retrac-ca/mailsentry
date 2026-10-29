import { build } from "esbuild";
import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = process.cwd();
const outdir = resolve(root, "dist", "public");
await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [resolve(root, "src/web/main.ts")],
  outfile: resolve(outdir, "app.js"),
  bundle: true,
  format: "esm",
  target: ["es2022"],
  platform: "browser",
  sourcemap: true,
  minify: false,
  logLevel: "info",
});

for (const file of ["index.html", "styles.css", "favicon.svg"]) {
  await copyFile(resolve(root, "src/web", file), resolve(outdir, file));
}
process.stdout.write("Web assets written to dist/public\n");
