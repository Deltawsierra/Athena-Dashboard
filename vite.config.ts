import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

// Resolve against this file, not the working directory, so the build does not
// depend on where npm was invoked from.
const rootDir = import.meta.dirname;

export default defineConfig({
  plugins: [react()],
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
  // setupVite) sets its own, with the files it never serves.
  server: {
    fs: {
      strict: true,
      deny: [".env", ".env.*", "*.{crt,pem}", "**/.git/**", "**/.*", "**/*.db", "**/*.db-*",
        "**/initial-admin-password.txt", "**/session-secret"],
    },
  },
});
