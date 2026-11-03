// @vitest-environment jsdom
/**
 * Text handed to a library component is drawn with each character that hides or
 * reorders text marked, as everywhere else in the app (DASH-HOSTILE-2, after
 * Dash #93).
 *
 * Dash #93 marks such characters through the app's JSX runtime
 * (client/src/lib/hiddenChars.ts guardHostProps), at each element the app's own
 * code draws. A library component draws through its library's own build, which
 * that runtime never sees: a Radix select's items, a dialog's title, a toast, a
 * tooltip, and a Recharts chart's ticks, tooltip and legend got the target's
 * string bare. Now:
 *
 *   - each module that wraps a Radix package registers it (drawsTargetText), and
 *     the props handed to a registered component are guarded at that boundary as
 *     an element's are. Driven here through the app's own wrappers
 *     (client/src/components/ui) with a hostile string: the select's items and
 *     the value it shows, its placeholder, a dialog's and an alert dialog's title
 *     and description, a toast's title and description, a tooltip, a dropdown
 *     menu's label and item, a label; and every component of every Radix package
 *     the app depends on is registered once the wrappers are loaded. The
 *     development server pre-bundles the runtime with its own copy of
 *     hiddenChars.ts, so a registration made through one copy is seen by another;
 *   - a chart's text goes through client/src/lib/chartText.ts: an axis tick (SVG
 *     text, no box) and a tooltip's series name (drawn only while it is a string)
 *     are written out "[U+202E]", a tooltip's label and value and a legend's
 *     entry are boxed. Driven here through Recharts itself; and
 *     every Recharts axis, tooltip and legend in client/src spreads those props,
 *     and no other Recharts component that draws text is used.
 */
import fs from "fs";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { DefaultLegendContent, DefaultTooltipContent, Line, LineChart, XAxis, YAxis } from "recharts";

import { isTextDrawingLibraryComponent } from "@/lib/hiddenChars";
import { AXIS_TEXT, LEGEND_TEXT, TOOLTIP_TEXT } from "@/lib/chartText";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import {
  AlertDialog, AlertDialogAction, AlertDialogContent, AlertDialogDescription, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Label } from "@/components/ui/label";
import { Toaster } from "@/components/ui/toaster";
import { toast } from "@/hooks/use-toast";

const ROOT = path.resolve(import.meta.dirname, "..");

beforeAll(() => {
  globalThis.ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} } as unknown as typeof ResizeObserver;
  // jsdom lacks these; Radix's select and menus call them.
  Element.prototype.scrollIntoView ??= function scrollIntoView() {};
  Element.prototype.hasPointerCapture ??= function hasPointerCapture() { return false; };
  Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};
});
afterEach(cleanup);

const RLO = "‮";
const ZWSP = "​";
/** A synthetic spoof: reads "invoiceexe.pdf" when drawn bare. */
const SPOOF = `invoice${RLO}fdp.exe${ZWSP}`;
const WRITTEN = "invoice[U+202E]fdp.exe[U+200B]";

/** Every hidden character in `within`'s text that is not alone in its marked box. */
function bare(within: Node = document.body): string[] {
  const out: string[] = [];
  const walker = document.createTreeWalker(within, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    if (!/[‮​]/.test(text)) continue;
    const box = node.parentElement;
    const marked = box?.classList.contains("hidden-char") && box.getAttribute("data-hidden-char") !== null && text.length === 1;
    if (!marked) out.push(`${box?.tagName.toLowerCase()}: ${JSON.stringify(text)}`);
  }
  return out;
}

/** The marked boxes in `within`, by code point. */
function boxes(within: ParentNode = document.body): string[] {
  return Array.from(within.querySelectorAll(".hidden-char[data-hidden-char]")).map((box) => box.getAttribute("data-hidden-char") ?? "");
}

describe("text handed to a Radix component, through the app's own wrappers", () => {
  it("a select: the item it shows as chosen, and each item when it is open", () => {
    render(
      <Select defaultValue="a" open>
        <SelectTrigger data-testid="trigger"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="a">{SPOOF}</SelectItem>
          <SelectItem value="b">{`site ${SPOOF}`}</SelectItem>
        </SelectContent>
      </Select>,
    );
    expect(bare()).toEqual([]);
    const options = Array.from(document.querySelectorAll("[role='option']"));
    expect(options.map((one) => one.textContent)).toEqual([SPOOF, `site ${SPOOF}`]);
    for (const option of options) expect(boxes(option)).toEqual(["U+202E", "U+200B"]);
    const trigger = document.querySelector("[data-testid='trigger']")!;
    expect(trigger.textContent).toBe(SPOOF);
    expect(boxes(trigger)).toEqual(["U+202E", "U+200B"]);
  });

  it("a select's placeholder, which it draws itself, is written out", () => {
    render(
      <Select>
        <SelectTrigger data-testid="trigger"><SelectValue placeholder={SPOOF} /></SelectTrigger>
        <SelectContent><SelectItem value="a">a</SelectItem></SelectContent>
      </Select>,
    );
    expect(bare()).toEqual([]);
    expect(document.querySelector("[data-testid='trigger']")!.textContent).toBe(WRITTEN);
  });

  it("a dialog's and an alert dialog's title, description and action", () => {
    render(
      <>
        <Dialog open>
          <DialogContent>
            <DialogTitle>{`Delete ${SPOOF}`}</DialogTitle>
            <DialogDescription>{SPOOF}</DialogDescription>
          </DialogContent>
        </Dialog>
        <AlertDialog open>
          <AlertDialogContent>
            <AlertDialogTitle>{SPOOF}</AlertDialogTitle>
            <AlertDialogDescription>{SPOOF}</AlertDialogDescription>
            <AlertDialogAction>{SPOOF}</AlertDialogAction>
          </AlertDialogContent>
        </AlertDialog>
      </>,
    );
    expect(bare()).toEqual([]);
    expect(boxes()).toHaveLength(10);
    expect(Array.from(document.querySelectorAll("h2")).map((h) => h.textContent)).toEqual([`Delete ${SPOOF}`, SPOOF]);
  });

  it("a toast's title and description (an error message a backend or engine wrote, as the pages hand it on)", async () => {
    render(<Toaster />);
    await act(async () => { toast({ title: SPOOF, description: `The engine said: ${SPOOF}` }); });
    expect(document.body.textContent).toContain(`The engine said: ${SPOOF}`);
    expect(bare()).toEqual([]);
    expect(boxes().length).toBeGreaterThanOrEqual(4);
  });

  it("a tooltip, a dropdown menu's label and item, and a label", () => {
    render(
      <>
        <TooltipProvider>
          <Tooltip open>
            <TooltipTrigger>hover</TooltipTrigger>
            <TooltipContent>{SPOOF}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <DropdownMenu open>
          <DropdownMenuTrigger>menu</DropdownMenuTrigger>
          <DropdownMenuContent>
            <DropdownMenuLabel>{SPOOF}</DropdownMenuLabel>
            <DropdownMenuItem>{SPOOF}</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <Label>{SPOOF}</Label>
      </>,
    );
    expect(document.body.textContent).toContain(SPOOF);
    expect(bare()).toEqual([]);
  });

  it("a read attribute handed to a Radix component is written out, as an element's is", () => {
    render(<Label title={SPOOF} aria-label={SPOOF}>plain</Label>);
    const label = document.querySelector("label")!;
    expect(label.getAttribute("title")).toBe(WRITTEN);
    expect(label.getAttribute("aria-label")).toBe(WRITTEN);
  });

  it("every component of every Radix package the app depends on is registered once its wrappers are loaded", async () => {
    const ui = path.join(ROOT, "client", "src", "components", "ui");
    for (const file of fs.readdirSync(ui).filter((name) => name.endsWith(".tsx"))) {
      await import(/* @vite-ignore */ path.join(ui, file));
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as { dependencies: Record<string, string> };
    const radix = Object.keys(pkg.dependencies).filter((name) => name.startsWith("@radix-ui/"));
    expect(radix.length).toBeGreaterThan(20);
    const missing: string[] = [];
    for (const name of radix) {
      const library = (await import(/* @vite-ignore */ name)) as Record<string, unknown>;
      for (const [exported, value] of Object.entries(library)) {
        const component = typeof value === "function" || (typeof value === "object" && value !== null && "$$typeof" in value);
        if (component && !isTextDrawingLibraryComponent(value)) missing.push(`${name} ${exported}`);
      }
    }
    expect(missing, "a Radix component this app's runtime does not guard: register its package with drawsTargetText where it is wrapped").toEqual([]);
  }, 120_000);

  it("a registration made through one copy of hiddenChars.ts is seen by another (the dev server pre-bundles the runtime with its own)", async () => {
    vi.resetModules();
    const one = await import("@/lib/hiddenChars");
    vi.resetModules();
    const other = await import("@/lib/hiddenChars");
    expect(one).not.toBe(other);
    const Primitive = () => null;
    one.drawsTargetText({ Primitive });
    expect(other.isTextDrawingLibraryComponent(Primitive)).toBe(true);
    expect(other.guardHostProps(Primitive, { title: SPOOF }).title).toBe(WRITTEN);
  });
});

describe("a chart's text, drawn by Recharts", () => {
  const rows = [{ m: SPOOF, v: 1 }, { m: "Mar 26", v: 2 }];

  it("an axis tick is SVG text, so each hidden character is written out", () => {
    const { container } = render(
      <LineChart width={480} height={240} data={rows}>
        <XAxis dataKey="m" {...AXIS_TEXT} />
        <YAxis {...AXIS_TEXT} />
        <Line dataKey="v" isAnimationActive={false} />
      </LineChart>,
    );
    const ticks = Array.from(container.querySelectorAll(".recharts-xAxis .recharts-cartesian-axis-tick-value")).map((tick) => tick.textContent);
    expect(ticks).toEqual([WRITTEN, "Mar 26"]);
    expect(container.textContent).not.toMatch(/[‮​]/);
  });

  it("a tooltip's label and a value are boxed, a series name is written out, and a number is handed on as it was", () => {
    const { container } = render(
      <DefaultTooltipContent
        label={SPOOF}
        payload={[{ name: SPOOF, value: 3, dataKey: "v" }, { name: "plain", value: SPOOF, dataKey: "w" }]}
        {...TOOLTIP_TEXT}
      />,
    );
    expect(container.querySelector(".recharts-tooltip-label")!.textContent).toBe(SPOOF);
    expect(Array.from(container.querySelectorAll(".recharts-tooltip-item-name")).map((one) => one.textContent)).toEqual([WRITTEN, "plain"]);
    expect(Array.from(container.querySelectorAll(".recharts-tooltip-item-value")).map((one) => one.textContent)).toEqual(["3", SPOOF]);
    expect(bare(container)).toEqual([]);
    expect(boxes(container)).toEqual(["U+202E", "U+200B", "U+202E", "U+200B"]);
  });

  it("a legend's entry is boxed", () => {
    const { container } = render(
      <DefaultLegendContent payload={[{ value: SPOOF, type: "line", id: "v" }]} {...LEGEND_TEXT} />,
    );
    expect(container.textContent).toBe(SPOOF);
    expect(bare(container)).toEqual([]);
  });

  it("every Recharts axis, tooltip and legend in client/src spreads the chart-text props, and no other text-drawing Recharts component is used", () => {
    // What each Recharts component that draws text from the chart's data must be handed.
    const GUARDED: Record<string, string> = { XAxis: "AXIS_TEXT", YAxis: "AXIS_TEXT", ZAxis: "AXIS_TEXT", Tooltip: "TOOLTIP_TEXT", Legend: "LEGEND_TEXT" };
    // Recharts components that draw no text of the data's own.
    const TEXTLESS = new Set(["ResponsiveContainer", "LineChart", "AreaChart", "BarChart", "ComposedChart", "CartesianGrid", "Line", "Area", "Bar", "Cell"]);
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        // A settings module is never opened by this suite's own scans (repo rule); it imports no chart.
        if (/settings/i.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (/\.tsx?$/.test(entry.name)) files.push(full);
      }
    };
    walk(path.join(ROOT, "client", "src"));
    const problems: string[] = [];
    let charts = 0;
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      const imported = source.match(/import\s*\{([^}]*)\}\s*from\s*["']recharts["']/);
      if (!imported) continue;
      charts += 1;
      const rel = path.relative(ROOT, file);
      for (const spec of imported[1].split(",").map((one) => one.trim()).filter(Boolean)) {
        const [name, alias] = spec.split(/\s+as\s+/);
        const local = alias ?? name;
        if (GUARDED[name]) {
          const tags = source.match(new RegExp(`<${local}\\b[^>]*?/?>`, "gs")) ?? [];
          if (tags.length === 0) problems.push(`${rel}: ${name} imported, never drawn`);
          for (const tag of tags) if (!tag.includes(`{...${GUARDED[name]}}`)) problems.push(`${rel}: <${local}> without {...${GUARDED[name]}}`);
        } else if (!TEXTLESS.has(name)) {
          problems.push(`${rel}: ${name} draws text of its own: route it through client/src/lib/chartText.ts`);
        }
      }
    }
    expect(charts).toBeGreaterThanOrEqual(2);
    expect(problems).toEqual([]);
  });
});
