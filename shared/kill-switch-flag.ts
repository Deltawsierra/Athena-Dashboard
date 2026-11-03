/**
 * How a stored kill-switch flag is read (DASH-FAILSAFE-2): anything that is not
 * exactly `false` holds the switch engaged. The flag is typed boolean, but the
 * row is data: "true", 1, null, a record or a value missing from a row that is
 * there each read as engaged -- ordinary writes held, and a resume or release
 * refused -- never as off. Stops are never held by it either way: they pass the
 * switch before it is read (server/routes.ts enforceKillSwitch).
 *
 * No stored row at all is not a flag: it reads as it always did, off (the row
 * is made at first run, server/init-data.ts).
 *
 * It has no imports, so the routes and the SQLite backend share it.
 */

/** Whether a stored flag value holds the switch engaged: anything but exactly `false`. */
export function flagEngaged(flag: unknown): boolean {
  return flag !== false;
}

/** Whether a stored row holds the switch engaged; a row that is not there reads off, as it always did. */
export function rowEngaged(row: { killSwitchEnabled?: unknown } | null | undefined): boolean {
  return row !== null && row !== undefined && flagEngaged(row.killSwitchEnabled);
}

/**
 * The flag as SQLite stored it, as a boolean: only an integer 0 -- what `false`
 * is written as -- reads as off. 1, 2, -1, the text "true" or "false", a blob or
 * a NULL each read as engaged. (Drizzle's boolean column reads `Number(v) === 1`,
 * which read the text "true" and the integer 2 as off.)
 */
export function flagFromColumn(raw: unknown): boolean {
  return !(raw === 0 || raw === BigInt(0) || raw === false);
}
