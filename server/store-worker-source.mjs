// The store's worker thread run from source (npm run dev, the tests): the
// TypeScript worker, store-worker-main.ts, bundled here in memory by esbuild
// with the options the desktop app's dist/store-worker.cjs is built with
// (build-electron-server.cjs), less its production defines, then run as that
// file runs. One build a thread, about 0.1 s here: loaded module by module
// through tsx, each of its modules was transformed apart, about half a second
// a thread here and about a second on Windows -- paid by every dashboard a
// test starts. The bundled server runs dist/store-worker.cjs instead
// (store-worker-file.ts).
import { build, stop } from "esbuild";
import { createRequire } from "module";
import path from "path";
import { fileURLToPath } from "url";

const entry = fileURLToPath(new URL("./store-worker-main.ts", import.meta.url));
const { options } = createRequire(import.meta.url)("../build-electron-server.cjs");
const { define: _productionOnly, ...bundling } = options;
const [bundle] = (await build({ ...bundling, entryPoints: [entry], write: false, logLevel: "silent" })).outputFiles;
await stop();
// As require() runs a CommonJS file: its own module, exports, require, __filename and __dirname.
const module = { exports: {} };
new Function("exports", "require", "module", "__filename", "__dirname", bundle.text)(
  module.exports, createRequire(entry), module, entry, path.dirname(entry));
