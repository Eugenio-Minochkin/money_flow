import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

const miniAppRoot = "apps/miniapp/src";

test("Mini App HTML references an existing module entry", async () => {
  const html = await readFile(join(miniAppRoot, "index.html"), "utf8");
  const match = html.match(/<script src="([^"]*app\.js[^"]*)" type="module"><\/script>/);

  assert.ok(match, "index.html should load app.js as a module");
  assert.equal(existsSync(join(miniAppRoot, match[1].split("?")[0].replace(/^\//, ""))), true);
});

test("Mini App local module imports resolve to files", async () => {
  const app = await readFile(join(miniAppRoot, "app.js"), "utf8");
  const imports = [...app.matchAll(/from "\.\/([^"]+\.js)"/g)].map((match) => match[1]);

  assert.ok(imports.length > 0);
  for (const imported of imports) {
    assert.equal(existsSync(join(miniAppRoot, imported)), true, `${imported} should exist`);
  }
});
