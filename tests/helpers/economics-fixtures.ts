/**
 * The economics fixtures: what Athena-Backend's own economics routes answered,
 * SYNTHETIC, recorded by tests/fixtures/economics/generate.py at two backend
 * commits. A test reads its uuids, digests and figures from the files, never
 * from its own expectations.
 */
import fs from "node:fs";
import path from "node:path";

export const MASTER = "ab-master-6a8f8e6";
export const PR160 = "ab-pr160-f7c9f09";
const ROOT = path.resolve(__dirname, "..", "fixtures", "economics");

export interface Exchange {
  name: string;
  method: string;
  path: string;
  status: number;
  content_type: string;
  /** The answer's bytes, as text, exactly. */
  body: string;
}

export interface Fixture {
  synthetic: string;
  backend: { repository: string; sha: string; ref: string };
  scenario: string;
  exchanges?: Exchange[];
  engine_record?: Record<string, unknown>;
}

export function fixture(dir: typeof MASTER | typeof PR160, name: string): Fixture {
  const loaded = JSON.parse(fs.readFileSync(path.join(ROOT, dir, `${name}.json`), "utf8")) as Fixture;
  if (!loaded.synthetic.startsWith("SYNTHETIC")) throw new Error(`${dir}/${name} is not marked synthetic`);
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
