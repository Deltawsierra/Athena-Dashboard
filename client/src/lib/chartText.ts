/**
 * A chart's text, with each character that hides or reorders text shown.
 *
 * Recharts draws a chart's text (its axis ticks, its tooltip's label and series
 * names, its legend) through its own build, from the chart's data, so the JSX
 * runtime that marks such characters everywhere else (./hiddenChars.ts) never
 * sees it. So every chart in this app hands that text through here, by
 * spreading these props on the Recharts component:
 *
 *   - AXIS_TEXT on an XAxis or YAxis: a tick is SVG <text>, which cannot hold a
 *     box, so each such character is written out ("[U+202E]");
 *   - TOOLTIP_TEXT on a Tooltip: its label and each series' value are HTML, so
 *     each such character is boxed, as on the rest of the page; a series' name
 *     is drawn only while it is a string (Recharts' DefaultTooltipContent), so
 *     there each such character is written out;
 *   - LEGEND_TEXT on a Legend: its entries are HTML, so each such character is
 *     boxed.
 *
 * A number, or text with no such character, is handed on as it was.
 * tests/text-handed-to-a-library-component-is-drawn-marked.test.tsx renders a
 * chart through these, and checks every chart in client/src spreads them.
 */
import type { ReactNode } from "react";
import { escapeHidden, markHidden } from "./hiddenChars";

/** A tick's text: SVG, so each hidden character is written out. */
export function chartTickText(value: unknown): string {
  return escapeHidden(String(value ?? ""));
}

/** Text a chart draws in HTML (a tooltip, a legend): each hidden character boxed. */
export function chartHtmlText(value: unknown): unknown {
  return typeof value === "string" ? markHidden(value) : value;
}

/** Spread on a Recharts XAxis or YAxis. */
export const AXIS_TEXT = {
  tickFormatter: (value: unknown) => chartTickText(value),
} as const;

/** Spread on a Recharts Tooltip. */
export const TOOLTIP_TEXT = {
  labelFormatter: (label: unknown) => chartHtmlText(label) as ReactNode,
  formatter: (value: unknown, name: unknown) =>
    [chartHtmlText(value), typeof name === "string" ? escapeHidden(name) : name] as [ReactNode, ReactNode],
} as const;

/** Spread on a Recharts Legend. */
export const LEGEND_TEXT = {
  formatter: (value: unknown) => chartHtmlText(value) as ReactNode,
} as const;
