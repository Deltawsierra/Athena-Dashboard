import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  // Only the `.tsx` render suites need it; the server suites are unaffected
  // because the plugin only transforms JSX.
  plugins: [react()],
  test: {
    environment: "node",
    // `.tsx` too: the four-numbers render tests mount the assurance panels in
    // jsdom, because a nullable field that reaches the response as null and
    // still renders as "0" would defeat the whole point of making it nullable.
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    // Runs before any test module is imported, so the storage backend is
    // chosen before a hoisted `import ... from "../server/..."` can open the
    // real database file. See tests/setup.ts.
    setupFiles: ["tests/setup.ts"],
    // Each suite opens its own in-memory database, so they must not share a process.
    pool: "forks",
    poolOptions: { forks: { singleFork: false } },
  },
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "shared"),
      "@": path.resolve(import.meta.dirname, "client", "src"),
      // The page pulls in the Mythos shell, which imports image assets by
      // this alias. Without it the render suite cannot even load the module.
      "@assets": path.resolve(import.meta.dirname, "attached_assets"),
    },
  },
});
