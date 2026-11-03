import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Resolve against this file, not the working directory, so the build does not
// depend on where npm was invoked from.
const rootDir = import.meta.dirname;

// Every .tsx file is compiled with this app's JSX runtime: React's, which also
// marks each character that hides or reorders text (a right-to-left override, a
// zero-width space) wherever an element draws text, since much of that text was
// written by the scanned target (client/src/lib/hiddenChars.ts). vitest.config.ts
// names the same one, so the tests run what ships.
export const JSX_IMPORT_SOURCE = "@/lib/target-text-jsx";

export default defineConfig({
  plugins: [react({ jsxImportSource: JSX_IMPORT_SOURCE })],
  resolve: {
    alias: {
      "@": path.resolve(rootDir, "client", "src"),
      "@shared": path.resolve(rootDir, "shared"),
      "@assets": path.resolve(rootDir, "attached_assets"),
    },
  },
  root: path.resolve(rootDir, "client"),
  build: {
    outDir: path.resolve(rootDir, "dist/public"),
    emptyOutDir: true,
  },
  // `vite` run on its own. The dev server this app starts (server/vite.ts
  // setupVite) sets its own: the directories it serves (DEV_SERVER_ALLOW) and
  // the files it never serves.
  server: {
    fs: {
      strict: true,
      allow: ["client", "shared", "attached_assets", "node_modules"].map((dir) => path.resolve(rootDir, dir)),
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.*", "**/*.db", "**/*.db-*",
        "**/initial-admin-password.txt", "**/session-secret"],
    },
  },
});
