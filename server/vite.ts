import express, { type Express } from "express";
import fs from "fs";
import path from "path";
import { createServer as createViteServer, createLogger, normalizePath } from "vite";
import { type Server } from "http";
import viteConfig from "../vite.config";
import { nanoid } from "nanoid";

const viteLogger = createLogger();

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

const repo = path.resolve(import.meta.dirname, "..");

/** The app's own directories: the client, the code it shares, its assets. */
const APP_DIRS = ["client", "shared", "attached_assets"].map((dir) => normalizePath(path.join(repo, dir)));

/**
 * The only directories the dev server serves files from: the app's own and the
 * dependencies it imports. Vite's default is the whole repository, and a dev
 * start writes the database, the first-run admin's password and the session
 * secret at its top, beside .env and any tool's dot-directory, all served at
 * /@fs/<path>. Allowed directories are the rule; DEV_SERVER_DENY is the second
 * line, for what lands inside one of them.
 */
export const DEV_SERVER_ALLOW: readonly string[] = Object.freeze([
  ...APP_DIRS,
  normalizePath(path.join(repo, "node_modules")),
]);

const globEscaped = (dir: string) => dir.replace(/[*?[\]{}()!+@]/g, "\\$&");

/**
 * What the dev server never serves, wherever it lies under the files it may
 * serve (DEV_SERVER_ALLOW). Vite's own defaults are kept: a `deny` given
 * replaces them. Patterns are matched against the file's absolute path.
 */
export const DEV_SERVER_DENY: readonly string[] = Object.freeze([
  ".env", ".env.*", "*.{crt,pem}", "**/.git/**",
  // Every dotfile (.npmrc, .secrets.baseline): the config's own rule, which
  // this replaced and dropped (#65 review round 2, N3). It names files, not
  // directories: "**/.*" does not match a file inside one.
  "**/.*",
  // Every file in a dot-directory of the app's own (.config/, an editor's or
  // a tool's). Not under node_modules: Vite serves the app's prebundled
  // dependencies from node_modules/.vite.
  ...APP_DIRS.map((dir) => `${globEscaped(dir)}/**/.*/**`),
  "**/*.{key,cert,crt,pem,p12,pfx}",
  "**/*.db", "**/*.db-*", "**/*.db.*",
  "**/*.sqlite", "**/*.sqlite3", "**/*.sqlite-*", "**/*.sqlite3-*",
  "**/*.log",
  "**/initial-admin-password.txt",
  "**/session-secret",
]);

/**
 * The hosts the dev server answers besides localhost and IP addresses:
 * ATHENA_DEV_ALLOWED_HOSTS, comma-separated. Answering every Host let a page
 * on any site reach it through DNS rebinding.
 */
export function devAllowedHosts(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ATHENA_DEV_ALLOWED_HOSTS ?? "").split(",").map((host) => host.trim()).filter(Boolean);
}

export async function setupVite(app: Express, server: Server) {
  // The config's own `server` block is replaced here, not merged: so its file
  // rules are restated, and every dev start has them.
  const serverOptions = {
    middlewareMode: true,
    hmr: { server },
    allowedHosts: devAllowedHosts(),
    fs: { strict: true, allow: [...DEV_SERVER_ALLOW], deny: [...DEV_SERVER_DENY] },
  };

  // An error while the dev server starts ends the process (a broken config
  // fails fast). One after it has started is a request's -- a file it refuses
  // to serve is logged as an error -- and is logged only: a request never
  // takes the server, and the kill switch and every Stop it serves, down.
  let started = false;
  const vite = await createViteServer({
    ...viteConfig,
    configFile: false,
    customLogger: {
      ...viteLogger,
      error: (msg, options) => {
        viteLogger.error(msg, options);
        if (!started) process.exit(1);
      },
    },
    server: serverOptions,
    appType: "custom",
  });

  started = true;

  app.use(vite.middlewares);
  app.use("*", async (req, res, next) => {
    const url = req.originalUrl;

    try {
      const clientTemplate = path.resolve(
        import.meta.dirname,
        "..",
        "client",
        "index.html",
      );

      // always reload the index.html file from disk incase it changes
      let template = await fs.promises.readFile(clientTemplate, "utf-8");
      template = template.replace(
        `src="/src/main.tsx"`,
        `src="/src/main.tsx?v=${nanoid()}"`,
      );
      const page = await vite.transformIndexHtml(url, template);
      res.status(200).set({ "Content-Type": "text/html" }).end(page);
    } catch (e) {
      vite.ssrFixStacktrace(e as Error);
      next(e);
    }
  });
}

export function serveStatic(app: Express) {
  const distPath = path.resolve(import.meta.dirname, "public");

  if (!fs.existsSync(distPath)) {
    throw new Error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`,
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
