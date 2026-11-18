const http = require("http");
const path = require("path");
const { createStaticHandler } = require("../api/src/http.js");

const port = Number(process.env.PORT ?? 3000);
const root = path.resolve(__dirname, "src");
const serveStatic = createStaticHandler({ webRoot: root, serveSharedModules: true });

http.createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";

  const file = path.join(root, pathname);
  const relative = path.relative(root, file);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    res.writeHead(403);
    res.end("forbidden");
    return;
  }

  return serveStatic(res, pathname, { searchParams: url.searchParams, requestHeaders: req.headers });
}).listen(port, "127.0.0.1", () => {
  console.log(`Mini App dev server listening on http://localhost:${port}`);
});
