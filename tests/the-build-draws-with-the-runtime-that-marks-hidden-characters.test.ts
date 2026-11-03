import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

import viteConfig, { JSX_IMPORT_SOURCE } from "../vite.config";

/**
 * The app is built with the JSX runtime that marks each character that hides or
 * reorders text (client/src/lib/hiddenChars.ts, client/src/lib/target-text-jsx),
 * the same one every render test runs under (vitest.config.ts imports
 * JSX_IMPORT_SOURCE from vite.config.ts). A build that dropped it would draw a
 * finding's right-to-left override bare on every screen while every render test
 * stayed green, so the build's own configuration is pinned here: the dev server
 * (server/vite.ts) spreads the same config.
 */
describe("the build draws with the runtime that marks hidden characters", () => {
  it("names the app's runtime as the React plugin's JSX import source", () => {
    expect(JSX_IMPORT_SOURCE).toBe("@/lib/target-text-jsx");
    const plugins = (viteConfig.plugins ?? []).flat() as Array<{ name?: string; config?: (...args: unknown[]) => unknown } | null>;
    const babel = plugins.find((one) => one?.name === "vite:react-babel");
    expect(babel, "the React plugin").toBeDefined();
    const own = babel!.config!({}, { command: "build", mode: "production" }) as { esbuild?: { jsx?: string; jsxImportSource?: string } };
    expect(own.esbuild).toEqual({ jsx: "automatic", jsxImportSource: JSX_IMPORT_SOURCE });
  });

  it("resolves that source to the runtime, for production and development, each passing every element through the guard", () => {
    const alias = (viteConfig.resolve?.alias ?? {}) as Record<string, string>;
    const dir = path.join(alias["@"], JSX_IMPORT_SOURCE.replace(/^@\//, ""));
    for (const [file, exported] of [["jsx-runtime.ts", ["jsx", "jsxs"]], ["jsx-dev-runtime.ts", ["jsxDEV"]]] as const) {
      const source = fs.readFileSync(path.join(dir, file), "utf8");
      for (const name of exported) {
        expect(source, `${file} ${name}`).toMatch(new RegExp(`export function ${name}\\([^)]*\\) \\{\\s*return react\\w+\\(type, guardHostProps\\(type, props\\)`));
      }
    }
  });

  it("styles each mark as a box naming its code point, boxed off so it reorders nothing outside it", () => {
    const css = fs.readFileSync(path.join(import.meta.dirname, "..", "client", "src", "index.css"), "utf8");
    const rule = (selector: string) => {
      const at = css.indexOf(`\n${selector} {`);
      expect(at, `a ${selector} rule in client/src/index.css`).toBeGreaterThanOrEqual(0);
      return css.slice(at, css.indexOf("}", at));
    };
    const box = rule(".hidden-char");
    expect(box).toMatch(/display:\s*inline-block;/);
    expect(box).toMatch(/unicode-bidi:\s*isolate;/);
    expect(box).toMatch(/direction:\s*ltr;/);
    expect(rule(".hidden-char::before")).toMatch(/content:\s*attr\(data-hidden-char\);/);
  });
});
