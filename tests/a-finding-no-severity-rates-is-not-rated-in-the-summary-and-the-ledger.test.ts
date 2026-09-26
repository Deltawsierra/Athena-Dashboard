/**
 * A finding no severity rates -- none recorded, or a word that is no rating --
 * is "unrated" ("Not rated") in the findings summary and the ledger, never
 * info; and a severity filed before filing normalised it is read on the way
 * out as every reader reads it.
 *
 * The summary read such a finding as info: counted in `open.info`, listed in
 * `topOpen` as "info" (the pill said "Info", which says "not a risk"), left out
 * of the trend without a word -- while its untracked-scan note, over the same
 * result, said "no severity recorded, may be critical". Filing ranked a
 * missing severity below info, so an issue seen rated info and unrated at one
 * place was filed as info and the unrated sighting dropped. And the count of
 * what a test filed at critical and high lower-cased the stored severity
 * without trimming it, so a row filed as " high" before round 4 was no filed
 * high on either backend, beside a summary that counted it as an open high.
 *
 * Stored rows are never rewritten: the reading is on the way out.
 */
import { beforeAll, describe, expect, it } from "vitest";

import { foldResults } from "../server/findings";
import { severityOf, summarizeFindings } from "../server/findings-summary";
import { MemStorage } from "../server/storage";
import type { IStorage } from "../server/storage";

const at = (iso: string) => new Date(iso);
let n = 0;
function finding(severity: string | null, month = "2026-03") {
  n += 1;
  return {
    id: `f${n}`, clientId: "c1", siteId: null, type: "odd", severity, message: `finding ${n}`, status: "open",
    firstSeenAt: at(`${month}-10T12:00:00Z`), lastSeenAt: at(`${month}-10T12:00:00Z`),
  };
}

describe("the findings summary", () => {
  it("counts a finding with no severity, or a word that is no rating, as unrated -- ranked below low and above info", () => {
    expect([null, undefined, "", "severe", " high", "Info", "LOW"].map((one) => severityOf(one)))
      .toEqual(["unrated", "unrated", "unrated", "unrated", "high", "info", "low"]);
    const summary = summarizeFindings({
      clients: [{ id: "c1", name: "Northwind" }], sites: [],
      findings: [finding("info"), finding(null), finding("severe"), finding("low")],
    });
    expect(summary.open).toEqual({ total: 4, critical: 0, high: 0, medium: 0, low: 1, unrated: 2, info: 1 });
    expect(summary.topOpen.map((one) => one.severity)).toEqual(["low", "unrated", "unrated", "info"]);
  });

  it("counts them in the trend by month, in their own column, never dropped", () => {
    const summary = summarizeFindings({
      clients: [{ id: "c1", name: "Northwind" }], sites: [],
      findings: [finding(null, "2026-02"), finding("severe", "2026-03"), finding("info", "2026-03"), finding("high", "2026-03")],
    });
    expect(summary.byMonth).toEqual([
      { month: "2026-02", critical: 0, high: 0, medium: 0, low: 0, unrated: 1 },
      { month: "2026-03", critical: 0, high: 1, medium: 0, low: 0, unrated: 1 },
    ]);
  });
});

describe("filing", () => {
  it("files an issue seen rated info and unrated at one place as unrated, never folded into the info sighting", () => {
    for (const unrated of [{}, { severity: null }, { severity: "severe" }]) {
      const folded = foldResults([
        { type: "odd", severity: "info", message: "banner", endpoint: "/x" },
        { type: "odd", message: "no severity sent", endpoint: "/x", ...unrated },
      ], "c1", "https://r5.example/");
      const [only] = Array.from(folded.distinct.values());
      expect(folded.distinct.size).toBe(1);
      expect(severityOf(only.severity), JSON.stringify(unrated)).toBe("unrated");
      expect(only.message).toBe("no severity sent");
    }
  });

  it("still files the worst rating over an unrated sighting of the same issue", () => {
    const folded = foldResults([
      { type: "odd", message: "no severity sent", endpoint: "/x" },
      { type: "odd", severity: "low", message: "rated", endpoint: "/x" },
    ], "c1", "https://r5.example/");
    expect(Array.from(folded.distinct.values())[0].severity).toBe("low");
  });
});

/** A row filed before filing normalised the rating, as the engine spelled it: counted by what it says. */
async function legacyRows(store: IStorage) {
  const client = await store.createClient({ name: "Legacy", company: "Legacy", email: "l@example.test" });
  const make = (fp: string, severity: string | null) => store.createFinding({
    fingerprint: fp, clientId: client.id, engagementRef: client.id, type: "sqli", severity,
  });
  for (const [fp, severity] of [["l-1", " high"], ["l-2", "High "], ["l-3", "\tCRITICAL"], ["l-4", "severe"], ["l-5", null]] as const) {
    const row = await make(fp, severity);
    await store.recordSighting(row.id, "run-old", "test-old", true);
  }
  return store.filedSeriousFindings("test-old");
}

describe("what a test filed at critical and high, read from rows filed before round 4", () => {
  it("in memory: a padded or capitalised rating is that rating; the rows are not rewritten", async () => {
    const store = new MemStorage();
    expect(await legacyRows(store)).toEqual({ critical: 1, high: 2 });
  });

  describe("on SQLite", () => {
    let sqlite: IStorage;
    beforeAll(async () => {
      process.env.ATHENA_DB_PATH = ":memory:";
      sqlite = (await import("../server/storage-sqlite")).storage;
    });
    it("a padded or capitalised rating is that rating; the rows are not rewritten", async () => {
      expect(await legacyRows(sqlite)).toEqual({ critical: 1, high: 2 });
      const client = (await sqlite.getAllClients()).find((one) => one.name === "Legacy")!;
      expect((await sqlite.getFindingsByClient(client.id)).map((one) => one.severity).sort())
        .toEqual(["\tCRITICAL", " high", "High ", "severe", null].sort());
    });
  });
});
