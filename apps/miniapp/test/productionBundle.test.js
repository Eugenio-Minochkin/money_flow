import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

test("production Mini App build collapses the module graph into one entry", async () => {
  const outputRoot = await mkdtemp(join(tmpdir(), "money-flow-miniapp-"));
  try {
    const result = spawnSync(process.execPath, ["apps/miniapp/build.mjs", "--outdir", outputRoot], {
      cwd: process.cwd(),
      encoding: "utf8"
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const [html, app, styles] = await Promise.all([
      readFile(join(outputRoot, "index.html"), "utf8"),
      readFile(join(outputRoot, "app.js"), "utf8"),
      readFile(join(outputRoot, "styles.css"), "utf8")
    ]);

    const appVersion = html.match(/<script src="\/app\.js\?v=([a-f0-9]{16})" type="module"><\/script>/)?.[1];
    const stylesVersion = html.match(/<link rel="stylesheet" href="\/styles\.css\?v=([a-f0-9]{16})"/)?.[1];

    assert.ok(appVersion, "production app.js URL must have a content-derived fingerprint");
    assert.equal(stylesVersion, appVersion, "HTML must point CSS and JavaScript at the same release");
    assert.doesNotMatch(app, /\bimport\s+[^;]+\s+from\s+["']\.\//);
    assert.match(app, /["']app_evaluated["']/);
    assert.match(styles, /\.shell\s*{/);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});
