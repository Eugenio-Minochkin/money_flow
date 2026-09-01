import { readFile, stat } from "node:fs/promises";
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
  return async function serveStatic(res, pathname, { searchParams = new URLSearchParams(), requestHeaders = {} } = {}) {
    const safePath = pathname.replace(/^\/+/, "");
    const filePath = join(webRoot, safePath);
    if (!filePath.startsWith(webRoot)) return sendJson(res, 403, { error: "forbidden" });
    try {
      const fileStat = await stat(filePath);
      const etag = `W/"${fileStat.size}-${Math.trunc(fileStat.mtimeMs)}"`;
      const headers = {
        "content-type": contentType(filePath),
        "cache-control": cacheControl(filePath, searchParams),
        etag,
        "last-modified": fileStat.mtime.toUTCString()
      };
      const noneMatch = requestHeaders["if-none-match"];
      const notModified = noneMatch
        ? noneMatch === etag
        : isNotModified(requestHeaders["if-modified-since"], fileStat.mtime);
      if (notModified) {
        res.writeHead(304, headers);
        return res.end();
      }
      const content = await readFile(filePath);
      res.writeHead(200, headers);
      res.end(content);
    } catch {
      sendJson(res, 404, { error: "not_found" });
    }
  };
}

function cacheControl(filePath, searchParams) {
  if (extname(filePath) === ".html") return "no-cache";
  return /^[a-f0-9]{16}$/.test(searchParams.get("v") ?? "")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
}

function isNotModified(value, modifiedAt) {
  if (!value) return false;
  const since = Date.parse(value);
  return Number.isFinite(since) && Math.trunc(modifiedAt.getTime() / 1000) <= Math.trunc(since / 1000);
}

function contentType(filePath) {
  return {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8"
  }[extname(filePath)] ?? "application/octet-stream";
}
