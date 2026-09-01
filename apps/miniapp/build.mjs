import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const miniAppRoot = dirname(fileURLToPath(import.meta.url));
const sourceRoot = join(miniAppRoot, "src");
const outdirIndex = process.argv.indexOf("--outdir");
const outputRoot = resolve(outdirIndex >= 0 ? process.argv[outdirIndex + 1] : join(miniAppRoot, "dist"));

await mkdir(outputRoot, { recursive: true });
const [htmlTemplate, styles, appBuild] = await Promise.all([
  readFile(join(sourceRoot, "index.html")),
  readFile(join(sourceRoot, "styles.css")),
  build({
    entryPoints: [join(sourceRoot, "app.js")],
    outfile: join(outputRoot, "app.js"),
    bundle: true,
    format: "esm",
    minify: true,
    target: "es2022",
    legalComments: "none",
    write: false
  })
]);
const app = appBuild.outputFiles.find((file) => file.path.endsWith("app.js"));
if (!app) throw new Error("Mini App build did not produce app.js");
const assetVersion = createHash("sha256")
  .update(htmlTemplate)
  .update(styles)
  .update(app.contents)
  .digest("hex")
  .slice(0, 16);
const assetVersionMarker = "__MINIAPP_ASSET_VERSION__";
const html = htmlTemplate.toString("utf8").replaceAll(assetVersionMarker, assetVersion);
if (html.includes(assetVersionMarker)) throw new Error("Mini App asset version was not substituted");

await Promise.all([
  writeFile(join(outputRoot, "index.html"), html),
  writeFile(join(outputRoot, "styles.css"), styles),
  writeFile(join(outputRoot, "app.js"), app.contents)
]);
