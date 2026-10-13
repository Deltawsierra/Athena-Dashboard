/**
 * The economics fixtures: what Athena-Backend's own economics routes answered,
 * SYNTHETIC, recorded by tests/fixtures/economics/generate.py at backend master
 * e7ee3eb (#163 and #164 merged: the v2 report with its currency bridge, the
 * receipt's signed bytes and the scenario list). A test reads its uuids, digests
 * and figures from the files, never from its own expectations.
 */
import fs from "node:fs";
import path from "node:path";

export const MASTER = "ab-master-e7ee3eb";
const ROOT = path.resolve(__dirname, "..", "fixtures", "economics");

export interface Exchange {
  name: string;
  method: string;
  path: string;
  status: number;
  content_type: string;
  /** The answer's own headers, of those the generator records (RECORDED_HEADERS). */
  headers?: Record<string, string>;
  /**
   * The answer's bytes, as text, exactly. A receipt's bytes are recorded in hex
   * (`body_hex`: the base64 of its payload and signature reads as a secret to the
   * repository's secret scan); `fixture()` turns them back into `body`.
   */
  body: string;
  body_hex?: string;
}

export interface Fixture {
  synthetic: string;
  backend: { repository: string; sha: string; ref: string };
  scenario: string;
  exchanges?: Exchange[];
  engine_record?: Record<string, unknown>;
  /** residual-report only: the backend's own report of the residual run (no route serves it). */
  residual_report?: { note: string; simulation: string; body: string };
  /** canonical-spellings only: a payload as it is signed (its bytes in hex), and the digest a report names for it. */
  cases?: Array<{ payload_hex: string; document_digest: string }>;
}

export function fixture(dir: typeof MASTER, name: string): Fixture {
  const loaded = JSON.parse(fs.readFileSync(path.join(ROOT, dir, `${name}.json`), "utf8")) as Fixture;
  if (!loaded.synthetic.startsWith("SYNTHETIC")) throw new Error(`${dir}/${name} is not marked synthetic`);
  for (const one of loaded.exchanges ?? []) {
    if (one.body_hex !== undefined) {
      if (!/^(?:[0-9a-f]{2})*$/.test(one.body_hex)) throw new Error(`${dir}/${name}: ${one.name}'s body_hex is not hex`);
      one.body = Buffer.from(one.body_hex, "hex").toString("utf8");
    }
  }
  return loaded;
}

export function exchange(loaded: Fixture, name: string): Exchange {
  const found = loaded.exchanges?.find((one) => one.name === name);
  if (!found) throw new Error(`${loaded.scenario} has no ${name} exchange`);
  return found;
}

/** The document an exchange answered, parsed. */
export function served(loaded: Fixture, name: string): Record<string, unknown> {
  return JSON.parse(exchange(loaded, name).body) as Record<string, unknown>;
}

/** The deployment and scenario a fixture's routes name. */
export function idsOf(loaded: Fixture): { deployment: string; scenario: string } {
  const match = /\/deployments\/([0-9a-f-]{36})\/economics\/scenarios\/([0-9a-f-]{36})\//.exec(loaded.exchanges?.[0]?.path ?? "");
  if (!match) throw new Error(`${loaded.scenario}: no deployment and scenario in its routes`);
  return { deployment: match[1], scenario: match[2] };
}

/** Every string value anywhere in the given documents. */
export function servedStrings(...documents: unknown[]): Set<string> {
  const found = new Set<string>();
  const walk = (value: unknown) => {
    if (typeof value === "string") found.add(value);
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value !== null && typeof value === "object") Object.values(value).forEach(walk);
  };
  documents.forEach(walk);
  return found;
}
