import { describe, expect, it } from "vitest";
import fs from "fs";
import path from "path";

/**
 * A test row's `findings` has many writers -- the live poll, a Stop's mirror,
 * the collect watch, the not-known reading, the start's mark, the adoption, a
 * person's act and a person's edit -- and each used to read the row, await,
 * and write the whole object back with `updateTest`. Whichever landed last
 * dropped what another wrote in between
 * (tests/every-findings-writer-writes-onto-the-row-as-it-lands.test.ts,
 * tests/two-writes-to-a-scan-row-never-drop-each-others-findings.test.ts).
 * Every one of them now writes with `updateTestWith`, handed the row as it is
 * when the write lands.
 *
 * So server code names the plain write `updateTest` nowhere -- not as a call,
 * a reference or a destructured name -- except where the storage defines it.
 * A new writer that reaches for it brings the race back, and fails here.
 * Each place on the list says why it may name it; keep the list that short.
 *
 * Files named for settings are left out of the walk, as they are out of every
 * search of this repo; no storage write belongs in one.
 */

const ROOT = path.resolve(__dirname, "..");

/** Where the plain write may be named, and how many times: its definitions, nothing else. */
const ALLOWED: Record<string, { times: number; why: string }> = {
  "server/storage.ts": { times: 2, why: "IStorage declares it, and MemStorage defines it" },
  "server/storage-sqlite.ts": { times: 1, why: "SqliteStorage defines it" },
};

/** The lines (1-based) of `source` that name the plain write. */
function plainWritesIn(source: string): number[] {
  return source.split(/\r?\n/).flatMap((line, i) => (/\bupdateTest\b/.test(line) ? [i + 1] : []));
}

function serverFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (/settings/i.test(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : serverFiles(full);
    return /\.(ts|tsx|js|mjs|cjs)$/.test(entry.name) ? [path.relative(ROOT, full).split(path.sep).join("/")] : [];
  });
}

describe("no server code writes a test row from a read taken before the write", () => {
  it("the rule finds the plain write however it is named, and passes the write onto the row as it lands", () => {
    expect(plainWritesIn("const row = await storage.getTest(id);\nawait storage.updateTest(id, { findings: { ...row.findings, x: 1 } });")).toEqual([2]);
    expect(plainWritesIn("await deps.storage.updateTest(test.id, { findings: unmarked });")).toEqual([1]);
    expect(plainWritesIn('const write = storage["updateTest"];')).toEqual([1]);
    expect(plainWritesIn("const { updateTest } = storage;")).toEqual([1]);
    expect(plainWritesIn("await storage.updateTestWith(id, (row) => ({ findings: { ...row.findings, x: 1 } }));")).toEqual([]);
    expect(plainWritesIn("await storage.updateTests(id);\nawait storage.getTest(id);")).toEqual([]);
  });

  it("each file on the list exists and names it as often as it says", () => {
    for (const [file, { times }] of Object.entries(ALLOWED)) {
      expect(fs.existsSync(path.join(ROOT, file)), file).toBe(true);
      expect(plainWritesIn(fs.readFileSync(path.join(ROOT, file), "utf8")), file).toHaveLength(times);
    }
  });

  it("no other server file names the plain write", () => {
    const files = serverFiles(path.join(ROOT, "server"));
    expect(files).toEqual(expect.arrayContaining(["server/routes.ts", "server/backend-adoption.ts", "server/collect-watch.ts"]));
    const named = files
      .filter((file) => !(file in ALLOWED))
      .flatMap((file) => plainWritesIn(fs.readFileSync(path.join(ROOT, file), "utf8")).map((line) => `${file}:${line}`));
    expect(named, "write with updateTestWith, onto the row as it lands").toEqual([]);
  });
});
