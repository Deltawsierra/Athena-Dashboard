/**
 * The JSX runtime every .tsx file in this app is compiled with (vite.config.ts,
 * vitest.config.ts: `jsxImportSource`). It is React's own, with one step before
 * each element: an element's text and the attributes a person reads have every
 * character that hides or reorders text marked (client/src/lib/hiddenChars.ts),
 * because much of that text was written by the scanned target. Nothing else is
 * changed. The development runtime beside it does the same.
 */
import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from "react/jsx-runtime";
import { guardHostProps } from "../hiddenChars";

export { Fragment };

type Props = Record<string, unknown>;

export function jsx(type: Parameters<typeof reactJsx>[0], props: Props, key?: Parameters<typeof reactJsx>[2]) {
  return reactJsx(type, guardHostProps(type, props), key);
}

export function jsxs(type: Parameters<typeof reactJsxs>[0], props: Props, key?: Parameters<typeof reactJsxs>[2]) {
  return reactJsxs(type, guardHostProps(type, props), key);
}
