"""Regenerate the engine retest fixtures by driving the real engine app.

Every JSON file beside this script is an exchange the athena-engine FastAPI app
itself answered, through FastAPI's TestClient, at a named commit. Nothing in
them is written by hand: the dashboard's retest client is tested against what
the engine sends, not against what somebody expected it to send.

Two engine commits are recorded, one directory each:

  pr71-143279e/  athena-engine PR #71 head 143279e5e9d680fecf48ddd7a926cd565dfb56a8
                 (the retest answers with `answer: "verdict" | "status"`,
                 `run_id` is the abort-registry id, `scan_record_id` the record)
  main-5779e99/  athena-engine main 5779e99eae1085f96e6c27ce28dbd950d8200aba
                 (the retest answers its verdict synchronously, `run_id` is the
                 scan record id, and there is no `answer` field)

Usage, from a checkout (or worktree) of athena-engine at one of those commits,
with its dependencies and mythos-core importable:

    python -B <this script> <engine checkout> <output directory>

The script refuses any other commit, so a fixture directory always says which
engine produced it. Each file carries the engine sha it was generated from.

What is real and what is a stand-in
-----------------------------------
Real: the engine's routes, request validation, job pool, abort registry,
decision-twin capture, retest runner and remediation record, and every
response body and status code.

Stand-ins, so that nothing leaves the machine: `engine.run_scan` is replaced by
a function that sends nothing and returns a scan result for the offline target
`https://offline.invalid/` (it holds until released or aborted where a
scenario needs a run in flight, and raises -- after that hold, where there is
one -- where a scenario needs a scan that failed); and
`engine.extension_review` is set to a review with nothing unapproved, which is
what lets the runner reach `closed`. The dashboard now asks
with `wait_seconds: 0` first (and, on a 422 refusing that field, again
without it): the `at-once-*` scenarios and main's `wait-seconds-refused` are
that request's answers. The other #71 scenarios record the request without
`wait_seconds` (the engine then waits up to 30 s inline), whose answers the
dashboard still reads if an engine sends them.

Run ids, timestamps, key hashes and digests differ on every run; the tests
read them from the files rather than assuming them.

Each file also records the mythos-core the engine imported while it was
generated, and the commit the engine's requirements.txt pins. They can
differ: the engine's routes, runner and job pool, which produce every answer
recorded here, are the engine's own code at the named sha either way.
"""

from __future__ import annotations

import importlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

KNOWN = {
    "143279e5e9d680fecf48ddd7a926cd565dfb56a8": "pr71-143279e",
    "5779e99eae1085f96e6c27ce28dbd950d8200aba": "main-5779e99",
}

TARGET = "https://offline.invalid/"
ENDPOINT = "https://offline.invalid/search"
ENGAGEMENT = "client-1:site-1"
SCOPE = ["offline.invalid"]
RAW_KEY = "operator-key-fixture"


def wait_until(pred, seconds=10.0):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if pred():
            return True
        time.sleep(0.02)
    return False


class Engine:
    """A fresh engine app on its own temporary database."""

    def __init__(self, workers=4, queued=16):
        tmp = tempfile.mkdtemp(prefix="engine-retest-fixture-")
        os.environ["ENGINE_DB_PATH"] = os.path.join(tmp, "engine.db")
        import mythos_core.db as db
        importlib.reload(db)
        db.init_db()
        import engine.utils.runs as runs
        import engine.utils.jobs as jobs
        import engine.utils.auth as auth
        importlib.reload(runs)
        importlib.reload(jobs)
        importlib.reload(auth)
        db.add_api_key(auth._hash_key(RAW_KEY), "operator", client_name="fixture")
        import api.server as server
        importlib.reload(server)
        jobs.reset_pool(max_workers=workers, max_queued=queued)
        from fastapi.testclient import TestClient
        self.server, self.runs, self.jobs, self.auth = server, runs, jobs, auth
        self.http = TestClient(server.app)
        self.headers = {"X-API-Key": RAW_KEY}
        self.key_hash = auth._hash_key(RAW_KEY)
        # Nothing unapproved and nothing switched off: the review the runner
        # needs before an absence can read as `closed`.
        server.engine.extension_review = {"counts": {"ok": 1}, "extensions": []}
        self.exchanges: list[dict] = []

    def call(self, method, path, body=None, keep_headers=()):
        response = self.http.request(method, path, json=body, headers=self.headers)
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
        exchange = {
            "request": {"method": method, "path": path, **({"body": body} if body is not None else {})},
            "status": response.status_code,
            "body": payload,
        }
        kept = {name: response.headers[name] for name in keep_headers if name in response.headers}
        if kept:
            exchange["headers"] = kept
        return exchange

    def record(self, exchange, note):
        self.exchanges.append({"note": note, **exchange})
        return exchange

    def twin(self, scan_run_id):
        """A real decision twin, captured as a scan captures one."""
        from engine import scan_auth
        from engine.replay import twin
        tenant = self.server.resolve_tenant(self.key_hash, None)
        return twin.capture(
            {"endpoint": ENDPOINT, "details": "Reflected input on /search"},
            {"type": "xss", "severity": "high", "tier": "confirmed", "confidence": 0.9},
            run_id=scan_run_id, target=TARGET, tenant=tenant,
            scan_auth=scan_auth.context(False, []),
        )

    def drain(self):
        self.jobs.drain(15)


def scan_result(kind, scan_id):
    """What the stand-in run_scan returns: a scan of the offline target."""
    from engine import scan_auth
    coverage = {
        "checks": [{"check": "xss", "state": "performed", "probes_attempted": 4, "probes_failed": 0}],
        "not_performed": [], "degraded": [], "unmeasured": [],
    }
    if kind == "closed":
        return {"scan_id": scan_id, "results": [], "coverage": coverage, "auth": scan_auth.context(False, [])}
    if kind == "still_open":
        return {
            "scan_id": scan_id,
            "results": [{"type": "xss", "severity": "high", "message": "Reflected input on /search", "endpoint": ENDPOINT}],
            "coverage": coverage, "auth": scan_auth.context(False, []),
        }
    raise ValueError(kind)


def stand_in(E, kind, scan_id, release=None, started=None, raises=None):
    """A run_scan that sends nothing, holds until released or aborted, then returns."""
    def run_scan(target, **kw):
        run_id = kw.get("run_id")
        if started is not None:
            started.set()
        if release is not None:
            while not release.is_set():
                if run_id and E.runs.abort_reason(run_id):
                    # A scan that was stopped returns what it had: nothing.
                    return {"scan_id": scan_id, "results": []}
                time.sleep(0.02)
        if raises:
            raise RuntimeError(raises)
        return scan_result(kind, scan_id)
    return run_scan


def retest_body(twin_id, **extra):
    return {"twin_id": twin_id, "engagement_ref": ENGAGEMENT, "scope": SCOPE, **extra}


def setup_scan_and_twin(E):
    """The scan whose finding is retested, and its decision list."""
    E.server.engine.run_scan = stand_in(E, "still_open", 400)
    scan = E.record(
        E.call("POST", "/api/scan", {"target": TARGET, "engagement_ref": ENGAGEMENT, "scope": SCOPE, "wait_seconds": 10}),
        "setup: the scan that found the finding (wait_seconds so it answers finished)",
    )
    run_id = scan["body"]["run_id"]
    twin = E.twin(run_id)
    E.record(
        E.call("GET", f"/api/decisions?run_id={run_id}&limit=101"),
        "setup: the decisions that scan kept (a real twin, captured by engine.replay.twin.capture)",
    )
    return twin


def mythos_core_provenance(checkout):
    """The mythos-core imported, by commit when it is a git checkout, and the engine's pin."""
    import mythos_core
    where = Path(mythos_core.__file__).resolve().parent
    found = subprocess.run(["git", "-C", str(where), "rev-parse", "HEAD"], capture_output=True, text=True)
    pinned = None
    for line in (checkout / "requirements.txt").read_text().splitlines():
        if line.startswith("mythos-core @"):
            pinned = line.rsplit("@", 1)[-1].strip()
    return {
        "imported_commit": found.stdout.strip() if found.returncode == 0 else None,
        "pinned_by_requirements": pinned,
    }


MYTHOS_CORE: dict = {}


def scenario(name, contract, engine_sha, fn, out, **pool):
    E = Engine(**pool)
    try:
        twin = setup_scan_and_twin(E)
        fn(E, twin)
    finally:
        E.drain()
    path = out / f"{name}.json"
    path.write_text(json.dumps({
        "engine": {"repository": "athena-engine", "sha": engine_sha, "contract": contract},
        "mythos_core": MYTHOS_CORE,
        "scenario": name,
        "exchanges": E.exchanges,
    }, indent=2, sort_keys=False) + "\n")
    print("wrote", path)


# ---------------------------------------------------------------- PR #71 -----

def pr71_verdict(kind, scan_id):
    def fn(E, twin):
        E.server.engine.run_scan = stand_in(E, kind, scan_id)
        answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                          f"the retest, answered inline with a {kind} verdict (201)")
        E.record(E.call("GET", answer["body"]["status_url"]),
                 "the same run read from its status_url")
    return fn


def pr71_202_then_verdict(E, twin):
    release, started = threading.Event(), threading.Event()
    E.server.engine.run_scan = stand_in(E, "closed", 502, release=release, started=started)
    answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                      "the retest, still running after the 30 s inline wait (202 status)")
    run_id = answer["body"]["run_id"]
    E.record(E.call("GET", "/api/scans/active"), "the engine's live list while the retest runs")
    E.record(E.call("GET", f"/api/scans/{run_id}"), "its status_url while it runs")
    release.set()
    wait_until(lambda: E.runs.get(run_id)["state"] == E.runs.COMPLETED)
    E.record(E.call("GET", f"/api/scans/{run_id}"), "its status_url once it finished: the verdict is the result")


def pr71_202_then_stop(E, twin):
    release, started = threading.Event(), threading.Event()
    E.server.engine.run_scan = stand_in(E, "closed", 503, release=release, started=started)
    answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                      "the retest, still running after the 30 s inline wait (202 status)")
    run_id = answer["body"]["run_id"]
    E.record(E.call("POST", f"/api/scans/{run_id}/abort", {}), "Stop, by the run_id the 202 answered")
    wait_until(lambda: E.runs.get(run_id)["state"] == E.runs.ABORTED)
    E.record(E.call("GET", f"/api/scans/{run_id}"),
             "its status_url once stopped: state aborted, and the runner's inconclusive verdict as the result")
    E.record(E.call("POST", f"/api/scans/{run_id}/abort", {}), "Stop again, on a run that has ended")


def pr71_202_then_failed(E, twin):
    release, started = threading.Event(), threading.Event()
    E.server.engine.run_scan = stand_in(E, "closed", 507, release=release, started=started, raises="scanner exploded")
    answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                      "the retest, still running after the 30 s inline wait (202 status)")
    run_id = answer["body"]["run_id"]
    E.record(E.call("GET", f"/api/scans/{run_id}"), "its status_url while it runs")
    release.set()
    wait_until(lambda: E.runs.get(run_id)["state"] == E.runs.FAILED)
    E.record(E.call("GET", f"/api/scans/{run_id}"),
             "its status_url once its scan raised: failed, with the runner's inconclusive verdict as the result")


def pr71_inline_aborted(E, twin):
    release, started = threading.Event(), threading.Event()
    E.server.engine.run_scan = stand_in(E, "closed", 504, release=release, started=started)
    holder = {}

    def launch():
        holder["answer"] = E.call("POST", "/api/remediation/retest", retest_body(twin["id"]))

    thread = threading.Thread(target=launch)
    thread.start()
    started.wait(10)
    live = E.call("GET", "/api/scans/active")
    run_id = [one for one in live["body"]["active"] if one["kind"] == "retest"][0]["run_id"]
    E.record(live, "the engine's live list while the caller waits inline")
    stop = E.call("POST", f"/api/scans/{run_id}/abort", {})
    thread.join(40)
    E.record(holder["answer"], "the retest's answer: stopped during the inline wait (200 status, aborted)")
    E.record(stop, "the Stop sent by the id on the live list, while the caller was waiting")


def pr71_failed(E, twin):
    E.server.engine.run_scan = stand_in(E, "closed", 505, raises="scanner exploded")
    answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                      "the retest, whose scan raised (200 status, failed)")
    E.record(E.call("GET", answer["body"]["status_url"]), "its status_url: failed, with the inconclusive verdict kept as the result")


def pr71_queue_full(E, twin):
    hold = threading.Event()
    blocker = E.runs.start("https://blocker.invalid/", state=E.runs.QUEUED)
    E.jobs.submit_scan(blocker, lambda: hold.wait(30) or {"results": []})
    wait_until(lambda: E.runs.get(blocker)["state"] == E.runs.RUNNING)
    E.server.engine.run_scan = stand_in(E, "closed", 506)
    answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"]), keep_headers=("retry-after",)),
                      "the retest, refused by a full worker queue (429 status)")
    E.record(E.call("GET", answer["body"]["status_url"]), "its status_url: failed, nothing started")
    hold.set()


# The dashboard asks #71 with `wait_seconds: 0` (engine.ts retest): the
# engine answers 202 at once and holds no thread for the verdict, and the
# dashboard's watch collects it. These are that request's answers.

def pr71_at_once(outcome, scan_id):
    def fn(E, twin):
        release, started = threading.Event(), threading.Event()
        raises = "scanner exploded" if outcome == "failed" else None
        E.server.engine.run_scan = stand_in(E, "closed", scan_id, release=release, started=started, raises=raises)
        answer = E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"], wait_seconds=0)),
                          "the retest, asked with wait_seconds: 0 as the dashboard asks: 202 at once")
        run_id = answer["body"]["run_id"]
        started.wait(10)
        E.record(E.call("GET", "/api/scans/active"), "the engine's live list while the retest runs")
        E.record(E.call("GET", f"/api/scans/{run_id}"), "its status_url while it runs")
        if outcome == "stopped":
            E.record(E.call("POST", f"/api/scans/{run_id}/abort", {}), "Stop, by the run_id the 202 answered")
            wait_until(lambda: E.runs.get(run_id)["state"] == E.runs.ABORTED)
        else:
            release.set()
            wait_until(lambda: E.runs.get(run_id)["state"] in (E.runs.COMPLETED, E.runs.FAILED))
        E.record(E.call("GET", f"/api/scans/{run_id}"), f"its status_url once it ended ({outcome})")
        if outcome == "stopped":
            E.record(E.call("POST", f"/api/scans/{run_id}/abort", {}), "Stop again, on a run that has ended")
    return fn


# ------------------------------------------------------------------ main -----

def main_verdict(kind, scan_id):
    def fn(E, twin):
        E.server.engine.run_scan = stand_in(E, kind, scan_id)
        E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
                 f"the retest, answered synchronously with a {kind} verdict (201)")
    return fn


def main_wait_seconds_refused(E, twin):
    E.server.engine.run_scan = stand_in(E, "closed", 612)
    E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"], wait_seconds=0)),
             "a retest sent wait_seconds: main refuses the unknown field (422), so the dashboard never sends it")


def main_stopped(E, twin):
    release, started = threading.Event(), threading.Event()
    E.server.engine.run_scan = stand_in(E, "closed", 613, release=release, started=started)
    holder = {}

    def launch():
        holder["answer"] = E.call("POST", "/api/remediation/retest", retest_body(twin["id"]))

    thread = threading.Thread(target=launch)
    thread.start()
    started.wait(10)
    live = E.call("GET", "/api/scans/active")
    run_id = [one for one in live["body"]["active"] if one["kind"] == "retest"][0]["run_id"]
    E.record(live, "the engine's live list while the synchronous retest runs")
    stop = E.call("POST", f"/api/scans/{run_id}/abort", {})
    thread.join(40)
    E.record(holder["answer"], "the retest's synchronous answer after it was stopped: a verdict, as main answers")
    E.record(stop, "the Stop sent by the id on the live list")


def main_failed(E, twin):
    E.server.engine.run_scan = stand_in(E, "closed", 614, raises="scanner exploded")
    E.record(E.call("POST", "/api/remediation/retest", retest_body(twin["id"])),
             "the retest, whose scan raised: main answers an inconclusive verdict (201)")


def main():
    checkout = Path(sys.argv[1]).resolve()
    out_root = Path(sys.argv[2]).resolve()
    sha = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"],
                         capture_output=True, text=True, check=True).stdout.strip()
    dirty = subprocess.run(["git", "-C", str(checkout), "status", "--porcelain"],
                           capture_output=True, text=True, check=True).stdout.strip()
    if sha not in KNOWN:
        sys.exit(f"{checkout} is at {sha}, which is not one of the recorded engine commits: {sorted(KNOWN)}")
    if dirty:
        sys.exit(f"{checkout} has uncommitted changes; the fixtures must come from the commit itself")
    os.chdir(checkout)
    sys.path.insert(0, str(checkout))
    os.environ.setdefault("MYTHOS_FLOORS_PATH", str(checkout / "benchmark" / "floors.json"))
    MYTHOS_CORE.update(mythos_core_provenance(checkout))
    out = out_root / KNOWN[sha]
    out.mkdir(parents=True, exist_ok=True)

    if KNOWN[sha].startswith("pr71"):
        contract = "pr71"
        scenario("verdict-closed", contract, sha, pr71_verdict("closed", 500), out)
        scenario("verdict-still-open", contract, sha, pr71_verdict("still_open", 501), out)
        scenario("running-then-verdict", contract, sha, pr71_202_then_verdict, out)
        scenario("running-then-stopped", contract, sha, pr71_202_then_stop, out)
        scenario("running-then-failed", contract, sha, pr71_202_then_failed, out)
        scenario("stopped-while-waiting", contract, sha, pr71_inline_aborted, out)
        scenario("failed", contract, sha, pr71_failed, out)
        scenario("queue-full", contract, sha, pr71_queue_full, out, workers=1, queued=0)
        scenario("at-once-then-verdict", contract, sha, pr71_at_once("verdict", 510), out)
        scenario("at-once-then-stopped", contract, sha, pr71_at_once("stopped", 511), out)
        scenario("at-once-then-failed", contract, sha, pr71_at_once("failed", 512), out)
    else:
        contract = "main"
        scenario("verdict-closed", contract, sha, main_verdict("closed", 610), out)
        scenario("verdict-still-open", contract, sha, main_verdict("still_open", 611), out)
        scenario("wait-seconds-refused", contract, sha, main_wait_seconds_refused, out)
        scenario("stopped", contract, sha, main_stopped, out)
        scenario("failed", contract, sha, main_failed, out)


if __name__ == "__main__":
    main()
