/**
 * The development JSX runtime: React's, with the same step as ./jsx-runtime.ts
 * before each element (client/src/lib/hiddenChars.ts guardHostProps).
 */
import { Fragment, jsxDEV as reactJsxDEV } from "react/jsx-dev-runtime";
import { guardHostProps } from "../hiddenChars";

export { Fragment };

type Args = Parameters<typeof reactJsxDEV>;

export function jsxDEV(type: Args[0], props: Record<string, unknown>, key: Args[2], isStatic: Args[3], source?: Args[4], self?: Args[5]) {
  return reactJsxDEV(type, guardHostProps(type, props), key, isStatic, source, self);
}
