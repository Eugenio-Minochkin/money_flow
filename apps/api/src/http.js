import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";

export function createJsonReader({ maxJsonBytes }) {
  return async function readJson(req) {
    const chunks = [];
    let totalBytes = 0;
    for await (const chunk of req) {
      totalBytes += chunk.length;
      if (totalBytes > maxJsonBytes) {
        const error = new Error("request_too_large");
        error.statusCode = 413;
        throw error;
      }
      chunks.push(chunk);
    }
    if (!chunks.length) return {};
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  };
}

export function sendJson(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

export function createStaticHandler({ webRoot }) {
  return async function serveStatic(res, pathname) {
    const safePath = pathname.replace(/^\/+/, "");
    const filePath = join(webRoot, safePath);
    if (!filePath.startsWith(webRoot)) return sendJson(res, 403, { error: "forbidden" });
    try {
      const content = await readFile(filePath);
      res.writeHead(200, { "content-type": contentType(filePath) });
      res.end(content);
    } catch {
      sendJson(res, 404, { error: "not_found" });
    }
  };
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[extname(filePath)] ?? "application/octet-stream";
}
