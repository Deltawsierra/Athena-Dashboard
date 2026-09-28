// Electron server entry point. Bundled to CommonJS by build-electron-server.cjs,
// so it must not import Vite or anything that depends on import.meta.
import "./boot-uv"; // Must be first: raises UV_THREADPOOL_SIZE before any libuv threadpool use.
import express from "express";
import { createServer } from "http";
import path from "path";
import { createApp, errorHandler } from "./app";
import { initializeDefaultData } from "./init-data";
import { startSampling } from "./health";
import { warmUp as warmFailsafe } from "./failsafe";

function serveStatic(app: express.Application): void {
  // The bundle lives in dist/, the client build in dist/public.
  const distPath = path.resolve(__dirname, "public");

  app.use(express.static(distPath));

  // Client-side routing: any non-API path serves index.html.
  app.get("*", (_req, res) => {
    res.sendFile(path.join(distPath, "index.html"));
  });
}

(async () => {
  const app = createApp({ deferErrorHandler: true });
  await initializeDefaultData();
  // Take a reading now and every minute after, so the health screen draws a
  // real trend rather than reading one row somebody wrote at install time.
  startSampling();
  // The control plane's service token, and the actions of the commands it
  // lists, obtained now: the first signature relay waits on neither.
  warmFailsafe();

  const server = createServer(app);
  serveStatic(app);
  app.use(errorHandler);

  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "127.0.0.1";

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[server] failed to listen on ${host}:${port}: ${err.message}`);
  });

  server.listen({ port, host }, () => {
    console.log(`[server] Electron server running on http://${host}:${port}`);
  });
})();
