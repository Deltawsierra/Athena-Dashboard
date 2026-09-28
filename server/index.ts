import "./boot-uv"; // Must be first: raises UV_THREADPOOL_SIZE before any libuv threadpool use.
import { createServer } from "http";
import { createApp, errorHandler } from "./app";
import { setupVite, serveStatic, log } from "./vite";
import { initializeDefaultData } from "./init-data";
import { startSampling } from "./health";
import { warmUp as warmFailsafe } from "./failsafe";

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

  // Vite (dev) or static (prod) is registered after the API so its catch-all
  // never shadows /api routes. The error handler goes last.
  if (app.get("env") === "development") {
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }
  app.use(errorHandler);

  // Bind to loopback by default. Set HOST=0.0.0.0 deliberately to expose the
  // server on the network; there is no reason to do so for a desktop install.
  const port = parseInt(process.env.PORT || "5000", 10);
  const host = process.env.HOST || "127.0.0.1";

  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      log(`port ${port} is already in use`);
    } else {
      log(`server error: ${err.message}`);
    }
    process.exit(1);
  });

  server.listen({ port, host }, () => {
    log(`serving on http://${host}:${port}`);
  });
})();
