import { mkdir, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const miniAppRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(miniAppRoot, "src");
const outdirIndex = process.argv.indexOf("--outdir");
const outputRoot = resolve(outdirIndex >= 0 ? process.argv[outdirIndex + 1] : join(miniAppRoot, "dist"));

await mkdir(outputRoot, { recursive: true });
await Promise.all([
  copyFile(join(sourceRoot, "index.html"), join(outputRoot, "index.html")),
  copyFile(join(sourceRoot, "styles.css"), join(outputRoot, "styles.css")),
  build({
    entryPoints: [join(sourceRoot, "app.js")],
    outfile: join(outputRoot, "app.js"),
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none"
  })
]);
