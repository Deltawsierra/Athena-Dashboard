import { describe, it, expect, afterEach, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import path from "path";

import { isSampleMode } from "@/sample";

/**
 * Sample mode is one switch, off by default, and the sample figures have one
 * door. The render suites check what each page shows; this checks the two
 * things a render cannot: that the switch is off when nobody set it, and that
 * no file outside client/src/sample reaches past the door into the figures.
 */

const CLIENT = path.resolve(import.meta.dirname, "..", "client", "src");
const SAMPLE_DIR = path.join(CLIENT, "sample");

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("sample mode", () => {
  it("is off when the build did not turn it on", () => {
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "");
    expect(isSampleMode()).toBe(false);
  });

  it("is on only for exactly 1", () => {
    for (const value of ["0", "true", "yes", "on", " 1"]) {
      vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", value);
      expect(isSampleMode(), `"${value}" turned sample mode on`).toBe(false);
    }
    vi.stubEnv("VITE_MYTHOS_SAMPLE_MODE", "1");
    expect(isSampleMode()).toBe(true);
  });

  it("is reached only through @/sample, never a file inside it", () => {
    const offenders: string[] = [];
    for (const file of sources(CLIENT)) {
      if (file.startsWith(SAMPLE_DIR + path.sep)) continue;
      const text = readFileSync(file, "utf8");
      const specifiers = Array.from(text.matchAll(/from\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g))
        .map((m) => m[1] ?? m[2]);
      for (const spec of specifiers) {
        const deep = spec.startsWith("@/sample/");
        const relative = spec.startsWith(".") &&
          path.resolve(path.dirname(file), spec).startsWith(SAMPLE_DIR + path.sep);
        if (deep || relative) offenders.push(`${path.relative(CLIENT, file)} imports ${spec}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
