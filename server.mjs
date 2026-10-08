import http from "node:http";
import { readFile, realpath, stat, access } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createSamBridge } from "./scripts/sam-bridge.mjs";
import { createSetStore } from "./set-data.mjs";
import { createTemplateStore } from "./template-store.mjs";
const base = new URL("./", import.meta.url),
  root = fileURLToPath(new URL("public/", base)),
  exists = (name) =>
    access(new URL(name, base)).then(
      () => true,
      () => false,
    );
export function createApp({
  sam = createSamBridge(),
  sets = createSetStore(base),
  templates = createTemplateStore(base),
} = {}) {
  const server = http.createServer(async (req, res) => {
    const reply = (code, message) => {
      res.writeHead(code, {
        "Content-Type": "text/plain",
        "Cache-Control": "no-store",
      });
      res.end(message);
    };
    const json = (value) => {
      const data = Buffer.from(JSON.stringify(value));
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "Content-Encoding": "gzip",
        "X-Content-Type-Options": "nosniff",
      });
      res.end(gzipSync(data));
    };
    if (
      ![
        `localhost:${req.socket.localPort}`,
        `127.0.0.1:${req.socket.localPort}`,
      ].includes(req.headers.host)
    )
      return reply(403, "Invalid local Host");
    let url;
    try {
      url = new URL(req.url, "http://" + req.headers.host);
    } catch {
      return reply(400, "Invalid URL");
    }
    try {
      if (url.pathname === "/api/status" && req.method === "GET") {
        json({
          ...sam.status(),
          setsReady: await exists(".cache/set-data/database.json"),
          indexReady: await exists("public/search-index/manifest.json"),
        });
        return;
      }
      if (url.pathname === "/api/sets" && req.method === "GET") {
        const q = url.searchParams.get("q") || "";
        if (q.length > 120) return reply(400, "Search too long");
        json({ sets: await sets.search(q) });
        return;
      }
      if (url.pathname.startsWith("/api/sets/") && req.method === "GET") {
        const number = decodeURIComponent(url.pathname.slice(10));
        if (!/^[a-zA-Z0-9_-]{1,40}$/.test(number))
          return reply(400, "Invalid set number");
        json(await sets.get(number));
        return;
      }
      if (
        ["/api/templates", "/api/segment"].includes(url.pathname) &&
        req.method === "POST"
      ) {
        if (
          req.headers.origin &&
          req.headers.origin !== "http://" + req.headers.host
        )
          return reply(403, "Invalid local origin");
        if (req.headers["content-type"] !== "application/json")
          return reply(415, "Expected JSON");
        const controller = new AbortController();
        res.on("close", () => {
          if (!res.writableEnded) controller.abort();
        });
        let size = 0;
        const chunks = [];
        for await (const chunk of req) {
          size += chunk.length;
          if (size > (url.pathname === "/api/segment" ? 64 : 8) * 1024 * 1024) return reply(413, "Request too large");
          chunks.push(chunk);
        }
        let payload;
        try {
          payload = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          return reply(400, "Invalid JSON");
        }
        if (url.pathname === "/api/templates") {
          if (!payload || typeof payload !== "object")
            return reply(400, "Invalid template request");
          json(await templates.get(payload.ids));
          return;
        }
        if (
          !payload ||
          typeof payload.image !== "string" ||
          !payload.image.length ||
          !/^[A-Za-z0-9+/=]+$/.test(payload.image) ||
          ![16, 32].includes(payload.density) ||
          !["sam", "yolo"].includes(payload.mode) ||
          (payload.tiled !== undefined && typeof payload.tiled !== "boolean") ||
          (payload.tiled === true && payload.mode !== "yolo") ||
          (payload.sourceImage !== undefined &&
            (payload.mode !== "yolo" || payload.tiled !== true ||
             typeof payload.sourceImage !== "string" || !payload.sourceImage.length ||
             !/^[A-Za-z0-9+/=]+$/.test(payload.sourceImage)))
        )
          return reply(400, "Invalid segmentation request");
        const status = sam.status();
        if (
          !status.available ||
          (payload.mode === "yolo" && !status.yoloAvailable)
        )
          return reply(
            503,
            "Local models unavailable. Run npm run setup:yolo.",
          );
        if (status.busy)
          return reply(409, "Local model is already processing a photo");
        res.writeHead(200, {
          "Content-Type": "application/x-ndjson",
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
        });
        const send = (m) => {
          if (!res.destroyed) res.write(JSON.stringify(m) + "\n");
        };
        try {
          send(
            await sam.segment(payload, {
              signal: controller.signal,
              onProgress: send,
            }),
          );
          res.end();
        } catch (e) {
          if (!res.destroyed)
            res.end(
              JSON.stringify({ type: "error", message: e.message }) + "\n",
            );
        }
        return;
      }
      if (url.pathname.startsWith("/api/"))
        return reply(404, "Unknown endpoint");
      if (!["GET", "HEAD"].includes(req.method))
        return reply(405, "Read-only static app");
      const relative = decodeURIComponent(url.pathname);
      if (relative.split("/").some((p) => p.startsWith(".") && p))
        return reply(404, "Not found");
      let file;
      try {
        file = await realpath(
          path.join(root, relative === "/" ? "index.html" : relative),
        );
      } catch {
        return reply(404, "Not found");
      }
      if (
        !file.startsWith(path.resolve(root) + path.sep) ||
        !(await stat(file)).isFile()
      )
        return reply(404, "Not found");
      const mime = {
        ".html": "text/html",
        ".mjs": "text/javascript",
        ".js": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".txt": "text/plain",
        ".svg": "image/svg+xml",
      };
      res.writeHead(200, {
        "Content-Type": mime[path.extname(file)] || "application/octet-stream",
        "Cache-Control": "no-cache",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; worker-src 'self'; connect-src 'self'",
      });
      res.end(req.method === "HEAD" ? undefined : await readFile(file));
    } catch (e) {
      if (!res.headersSent && !res.destroyed) reply(e.status || 500, e.message);
    }
  });
  server.on("close", () => sam.close());
  return server;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const port = Number(process.env.PORT || 8002),
    server = createApp();
  server.listen(port, "127.0.0.1", () =>
    console.log(`Find bricks for a set: http://localhost:${port}`),
  );
  server.on("error", (e) => {
    console.error(
      e.code === "EADDRINUSE" ? "Port in use; choose another PORT." : e.message,
    );
    process.exitCode = 1;
  });
}
