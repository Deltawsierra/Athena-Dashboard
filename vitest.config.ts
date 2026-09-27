import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import fs from "fs";

// These files bound wall-clock time: how long the event loop is held, how
// soon a stop reaches the engine, how long a connection is kept. Run beside
// the other test files, they share the runner's cores with every other fork,
// and a starved process misses the bound although the app did nothing slow.
// So `npm test` runs them afterwards on their own, one file at a time
// (`vitest run --mode timing`), with every bound unchanged. The list is
// tests/wall-clock.json; a test file that bounds wall-clock time and is not
// on it fails the suite (tests/every-test-that-bounds-wall-clock-time-runs-
// on-its-own.test.ts), and `npm test -- <file>` runs a file in the phase it
// belongs to (scripts/test.mjs).
const WALL_CLOCK: string[] = JSON.parse(fs.readFileSync(path.resolve(import.meta.dirname, "tests", "wall-clock.json"), "utf8"));

export default defineConfig(({ mode }) => ({
  // Only the `.tsx` render suites need it; the server suites are unaffected
  // because the plugin only transforms JSX.
  plugins: [react()],
  test: {
    environment: "node",
    // `.tsx` too: the four-numbers render tests mount the assurance panels in
    // jsdom, because a nullable field that reaches the response as null and
    // still renders as "0" would defeat the whole point of making it nullable.
    include: mode === "timing" ? WALL_CLOCK : ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    exclude: mode === "timing" ? configDefaults.exclude : [...configDefaults.exclude, ...WALL_CLOCK],
    fileParallelism: mode !== "timing",
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
}));
