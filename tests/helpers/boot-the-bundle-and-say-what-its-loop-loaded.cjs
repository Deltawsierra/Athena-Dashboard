// The server bundle, booted as the desktop app boots it (electron-main.cjs
// requires dist/server-electron.cjs in-process), in a process of its own:
//   node boot-the-bundle-and-say-what-its-loop-loaded.cjs <bundle> <port> <admin password>
// The environment (the database file, the session secret) is the caller's.
// Once it serves, its admin signs in and a few pages are read, so the store
// is used; then one JSON line on stdout says what this process's main thread
// -- its event loop -- loaded of the SQLite driver: every better-sqlite3 file
// in its module cache, and the file that asked for each (paths only). The
// store's worker thread has a module cache of its own, and is not asked.
const Module = require("module");
const http = require("http");

const [bundle, port, password] = process.argv.slice(2);
const askedBy = [];
const load = Module._load;
Module._load = function (request, parent, ...rest) {
  if (/(^|[\\/])better-sqlite3([\\/]|$)/.test(String(request))) askedBy.push({ request: String(request), by: parent && parent.filename ? parent.filename : null });
  return load.call(this, request, parent, ...rest);
};

function call(method, path, body, cookie) {
  return new Promise((done) => {
    const payload = body === undefined ? "" : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1", port: Number(port), path, method,
      headers: { "content-type": "application/json", "content-length": Buffer.byteLength(payload), ...(cookie ? { cookie } : {}) },
    }, (res) => {
      res.resume();
      res.on("end", () => done({ status: res.statusCode, cookie: (res.headers["set-cookie"] || [""])[0].split(";")[0] }));
    });
    req.on("error", () => done({ status: 0, cookie: "" }));
    req.end(payload);
  });
}

(async () => {
  require(bundle);
  const deadline = Date.now() + 60_000;
  let health = { status: 0 };
  while (Date.now() < deadline) {
    health = await call("GET", "/health");
    if (health.status === 200) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  const login = await call("POST", "/api/auth/login", { username: "admin", password });
  const reads = [];
  for (const path of ["/api/auth/check", "/api/tests", "/api/ai-control", "/api/clients"]) reads.push((await call("GET", path, undefined, login.cookie)).status);
  const loaded = Object.keys(require.cache).filter((file) => /[\\/]node_modules[\\/]better-sqlite3[\\/]/.test(file));
  process.stdout.write(JSON.stringify({ health: health.status, login: login.status, reads, loaded, askedBy }) + "\n");
  process.exit(0);
})().catch((cause) => {
  process.stdout.write(JSON.stringify({ failed: String(cause && cause.stack || cause) }) + "\n");
  process.exit(1);
});
