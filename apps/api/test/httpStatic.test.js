import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { createStaticHandler } from "../src/http.js";

test("static handler keeps HTML and modules revalidated but caches explicit versions immutably", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "money-flow-static-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "index.html"), "<h1>Money Flow</h1>");
  await writeFile(join(root, "app.js"), "export const app = true;");

  const serve = createStaticHandler({ webRoot: root });
  const html = responseRecorder();
  await serve(html.res, "/index.html", { searchParams: new URLSearchParams(), requestHeaders: {} });
  assert.equal(html.status, 200);
  assert.equal(html.headers["cache-control"], "no-cache");
  assert.ok(html.headers.etag);
  assert.ok(html.headers["last-modified"]);

  const module = responseRecorder();
  await serve(module.res, "/app.js", { searchParams: new URLSearchParams(), requestHeaders: {} });
  assert.equal(module.headers["cache-control"], "no-cache");

  const versioned = responseRecorder();
  await serve(versioned.res, "/app.js", {
    searchParams: new URLSearchParams("v=0123456789abcdef"),
    requestHeaders: {}
  });
  assert.equal(versioned.headers["cache-control"], "public, max-age=31536000, immutable");

  const sourceMarker = responseRecorder();
  await serve(sourceMarker.res, "/app.js", {
    searchParams: new URLSearchParams("v=__MINIAPP_ASSET_VERSION__"),
    requestHeaders: {}
  });
  assert.equal(sourceMarker.headers["cache-control"], "no-cache");

  const conditional = responseRecorder();
  await serve(conditional.res, "/app.js", {
    searchParams: new URLSearchParams("v=20260813-startup"),
    requestHeaders: { "if-none-match": versioned.headers.etag }
  });
  assert.equal(conditional.status, 304);
  assert.equal(conditional.body, "");

  const staleEtag = responseRecorder();
  await serve(staleEtag.res, "/app.js", {
    searchParams: new URLSearchParams(),
    requestHeaders: {
      "if-none-match": "W/\"stale\"",
      "if-modified-since": module.headers["last-modified"]
    }
  });
  assert.equal(staleEtag.status, 200, "If-None-Match takes precedence over If-Modified-Since");
});

function responseRecorder() {
  const record = { status: null, headers: {}, body: "" };
  record.res = {
    writeHead(status, headers = {}) {
      record.status = status;
      record.headers = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value])
      );
    },
    end(body = "") {
      record.body = Buffer.isBuffer(body) ? body.toString("utf8") : String(body);
    }
  };
  return record;
}
