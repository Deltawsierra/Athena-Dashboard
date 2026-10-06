// Electron server entry point. Bundled to CommonJS by build-electron-server.cjs,
// so it must not import Vite or anything that depends on import.meta.
import "./boot-uv"; // Must be first: raises UV_THREADPOOL_SIZE before any libuv threadpool use.
import express from "express";
import { createServer } from "http";
import path from "path";
import { createApp, errorHandler } from "./app";
import { initializeDefaultData, flagLegacyDefaultPasswords } from "./init-data";
import { startSampling } from "./health";
import { warmUp as warmFailsafe, primeNow as primeFailsafeHost } from "./failsafe";
import { loadServiceToken } from "./failsafe-service-token";
import * as settings from "./settings";
import { primeNow as primeEngineHost } from "./engine";

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
  // The failsafe service token every stop presents, read from the environment
  // once, now: a stop sent with it waits on no sign-in.
  loadServiceToken();
  // The control plane's service token, and the actions of the commands it
  // lists, obtained now: the first signature relay waits on neither.
  warmFailsafe();

  const server = createServer(app);
  serveStatic(app);
  app.use(errorHandler);

  // SAFETY: close the boot race BEFORE the server accepts its first request --
  // see the note in server/index.ts. Both outbound hosts are primed in the DNS
  // cache and awaited so the very first Stop reads a cached address rather than
  // running a live threadpool getaddrinfo behind a sign-in flood.
  await settings.load();
  await Promise.allSettled([primeEngineHost(), primeFailsafeHost()]);

  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "127.0.0.1";

  server.on("error", (err: NodeJS.ErrnoException) => {
    console.error(`[server] failed to listen on ${host}:${port}: ${err.message}`);
  });

  server.listen({ port, host }, () => {
    console.log(`[server] Electron server running on http://${host}:${port}`);
    // After listening, never awaited: an account still on a legacy default
    // password is made to change it, and nothing a stop waits on waits on it.
    void flagLegacyDefaultPasswords();
  });
})();
