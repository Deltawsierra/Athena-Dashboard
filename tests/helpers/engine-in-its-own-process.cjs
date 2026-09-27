// A stand-in engine in a process of its own, so a dashboard whose event loop is
// held cannot hold this too, and when each request arrived is measured here.
// It answers with the recorded athena-engine 143279e bodies
// (tests/fixtures/engine-retest/pr71-143279e/at-once-then-stopped.json), the
// run id in each set to the one asked about.
const http = require("http");
const fs = require("fs");
const path = require("path");

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "engine-retest", "pr71-143279e", "at-once-then-stopped.json"), "utf8"));
const byRequest = (method, test) => fixture.exchanges.filter((one) => one.request.method === method && test(one.request.path));
const abortAnswer = byRequest("POST", (p) => /\/abort$/.test(p))[0].body;
const runningRead = byRequest("GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active")[0].body;

let active = { active: [] };
const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const url = req.url || "";
    if (url === "/__active") {
      active = JSON.parse(raw);
      res.end("{}");
      return;
    }
    process.stdout.write(JSON.stringify({ line: `${req.method} ${url}`, at: Date.now() }) + "\n");
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url === "/health") return res.end(JSON.stringify({ status: "ok" }));
    if (url === "/api/scans/active") return res.end(JSON.stringify(active));
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) return res.end(JSON.stringify({ ...abortAnswer, run_id: decodeURIComponent(abort[1]) }));
    const read = /^\/api\/scans\/([^/]+)$/.exec(url);
    if (read) return res.end(JSON.stringify({ ...runningRead, run_id: decodeURIComponent(read[1]) }));
    res.end("{}");
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
