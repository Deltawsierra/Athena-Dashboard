// A stand-in engine in a process of its own, so a dashboard whose event loop is
// held cannot hold this too, and when each request arrived is measured here.
// It answers with the recorded athena-engine 143279e bodies
// (tests/fixtures/engine-retest/pr71-143279e/at-once-then-stopped.json), the
// run id in each set to the one asked about.
//
// A scan start (POST /api/scan) is answered as a run still going, under a
// fresh run id.
//
// Two knobs: POST /__hang {hang} leaves /api/scans/active unanswered (no
// headers) -- an engine whose worker threads are all busy, as round 1
// measured (28 s); POST /__abortDelay {ms} answers each stop after ms (a run
// whose id starts "victim" is answered at once).
const http = require("http");
const fs = require("fs");
const path = require("path");

const fixture = JSON.parse(fs.readFileSync(
  path.join(__dirname, "..", "fixtures", "engine-retest", "pr71-143279e", "at-once-then-stopped.json"), "utf8"));
const byRequest = (method, test) => fixture.exchanges.filter((one) => one.request.method === method && test(one.request.path));
const abortAnswer = byRequest("POST", (p) => /\/abort$/.test(p))[0].body;
const runningRead = byRequest("GET", (p) => /^\/api\/scans\/[^/]+$/.test(p) && p !== "/api/scans/active")[0].body;
const startAnswer = byRequest("POST", (p) => p === "/api/scan")[0].body;
let started = 0;

let active = { active: [] };
let hangActive = false;
let abortDelayMs = 0;
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
    if (url === "/__hang") {
      hangActive = JSON.parse(raw).hang === true;
      res.end("{}");
      return;
    }
    if (url === "/__abortDelay") {
      abortDelayMs = Number(JSON.parse(raw).ms) || 0;
      res.end("{}");
      return;
    }
    process.stdout.write(JSON.stringify({ line: `${req.method} ${url}`, at: Date.now() }) + "\n");
    if (url === "/api/scans/active" && hangActive) return; // never answered
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url === "/health") return res.end(JSON.stringify({ status: "ok" }));
    if (url === "/api/scans/active") return res.end(JSON.stringify(active));
    if (url === "/api/scan" && req.method === "POST") {
      started += 1;
      return res.end(JSON.stringify({
        ...startAnswer, run_id: `started-${started}-${Date.now()}`, state: "running", done: false, finished_at: null, results: undefined,
      }));
    }
    const abort = /^\/api\/scans\/([^/]+)\/abort$/.exec(url);
    if (abort) {
      const send = () => res.end(JSON.stringify({ ...abortAnswer, run_id: decodeURIComponent(abort[1]) }));
      if (abortDelayMs > 0 && !abort[1].startsWith("victim")) return void setTimeout(send, abortDelayMs);
      return send();
    }
    const read = /^\/api\/scans\/([^/]+)$/.exec(url);
    if (read) return res.end(JSON.stringify({ ...runningRead, run_id: decodeURIComponent(read[1]) }));
    res.end("{}");
  });
});
server.listen(0, "127.0.0.1", () => process.stdout.write(JSON.stringify({ port: server.address().port }) + "\n"));
