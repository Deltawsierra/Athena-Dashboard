/**
 * A source as a figure may read it: still loading, failed (and why), or in
 * hand. The screens that count things read their queries through this, so a
 * zero on the page is always a measurement and an unknown never looks like one:
 * "…" while a source is loading, "—" when it failed, and the reason beside it.
 */
import type { UseQueryResult } from "@tanstack/react-query";

export type Loaded<T> =
  | { state: "loading" }
  | { state: "error"; message: string }
  | { state: "ready"; data: T };

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "request failed";
}

export function loaded<T>(query: UseQueryResult<T>): Loaded<T> {
  if (query.isError) return { state: "error", message: errorMessage(query.error) };
  if (query.data === undefined) return { state: "loading" };
  return { state: "ready", data: query.data };
}

/** Two sources that must both be in hand before a figure means anything. */
export function both<A, B>(a: Loaded<A>, b: Loaded<B>): Loaded<[A, B]> {
  if (a.state === "error") return a;
  if (b.state === "error") return b;
  if (a.state === "loading" || b.state === "loading") return { state: "loading" };
  return { state: "ready", data: [a.data, b.data] };
}

/** "…" while loading, "—" when the source failed: never a number nobody read. */
export function figure<T>(source: Loaded<T>, read: (data: T) => string | number): string | number {
  if (source.state === "ready") return read(source.data);
  return source.state === "loading" ? "…" : "—";
}

/** The sentence a panel shows while its source is not in hand. */
export function notInHand(source: Loaded<unknown>, what: string): string {
  return source.state === "error" ? `Could not load ${what}: ${source.message}` : "Loading…";
}
