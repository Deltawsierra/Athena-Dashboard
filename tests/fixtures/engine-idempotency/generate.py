"""Record the engine's answers to a scan launch sent again with its Idempotency-Key.

Every JSON file beside this script is an exchange the athena-engine FastAPI app
answered, through FastAPI's TestClient, at athena-engine main
79ba4af99bfa22822c0de2e03f27b11a5231b296 (#77: `POST /api/scan` takes an
Idempotency-Key). Nothing in them is written by hand: the dashboard's scan
client is tested against what the engine sends under a key, not against what
somebody expected it to send.

Usage, from a checkout (or worktree) of athena-engine at that commit, with its
dependencies and mythos-core importable:

    python -B <this script> <engine checkout> <output directory> [--core-repo <mythos-core git repo>]

The script refuses any other engine commit. Each file names the engine sha and
the mythos-core the engine imported. When that mythos-core is a git checkout it
is named by its commit. When it is a `git archive` export (no git metadata), it
is compared, file by file, with `git show <pin>:src/mythos_core/<file>` in the
repository named by --core-repo (read, never written), and labelled
"pinned core" only when every file is byte for byte the pinned one.

What is real and what is a stand-in
-----------------------------------
Real: the engine's route, its admission checks, the key layer
(engine/utils/idempotency.py), the job pool and the abort registry, and every
status code, body and header recorded.

Stand-ins, so that nothing leaves the machine: `engine.run_scan` is replaced by
a function that sends nothing and returns a scan of the offline target (it
holds until released or stopped, where a scenario needs a run in flight); one
scenario makes `runs.start` raise once, as a locked database would; and one
sets the governor's state to STOOD_DOWN directly (a SimpleNamespace in place
of a governor that applied a signed stand-down, as the engine's own contract
test does), because what is recorded is the route's answer to that state.

Run ids, timestamps and the `since` of a key differ on every run; the tests
read them from the files rather than assuming them.
"""

from __future__ import annotations

import importlib
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import types
from pathlib import Path

KNOWN = {"79ba4af99bfa22822c0de2e03f27b11a5231b296": "main-79ba4af"}

TARGET = "https://offline.invalid/"
ENGAGEMENT = "client-1:site-1"
SCOPE = ["offline.invalid"]
RAW_KEY = "operator-key-fixture"
# The headers of an answer the dashboard reads; any other is not recorded.
KEEP = ("Idempotent-Replayed", "X-Run-Id", "Retry-After")


def launch_body(**extra):
    """The body the dashboard's startScan sends (server/engine.ts)."""
    return {"target": TARGET, "engagement_ref": ENGAGEMENT, "scope": SCOPE, **extra}


class Engine:
    """A fresh engine app on its own temporary database."""

    def __init__(self):
        tmp = tempfile.mkdtemp(prefix="engine-idempotency-fixture-")
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
        jobs.reset_pool(max_workers=4, max_queued=16)
        from fastapi.testclient import TestClient
        self.server, self.runs, self.jobs = server, runs, jobs
        self.http = TestClient(server.app, raise_server_exceptions=False)
        self.release = threading.Event()
        self.started = threading.Event()
        server.engine.run_scan = self.stand_in
        self.exchanges: list[dict] = []

    def stand_in(self, target, **kw):
        """A scan that sends nothing, held until released or stopped."""
        run_id = kw.get("run_id")
        self.started.set()
        while not self.release.is_set():
            if run_id and self.runs.abort_reason(run_id):
                break
            time.sleep(0.02)
        return {"scan_id": 1, "results": []}

    def call(self, body, key=None):
        headers = {"X-API-Key": RAW_KEY}
        if key is not None:
            headers["Idempotency-Key"] = key
        response = self.http.post("/api/scan", json=body, headers=headers)
        try:
            payload = response.json()
        except ValueError:
            payload = response.text
        request = {"method": "POST", "path": "/api/scan", "body": body}
        if key is not None:
            request["headers"] = {"Idempotency-Key": key}
        exchange = {"request": request, "status": response.status_code, "body": payload}
        kept = {name: response.headers[name] for name in KEEP if name in response.headers}
        if kept:
            exchange["headers"] = kept
        return exchange

    def record(self, exchange, note):
        self.exchanges.append({"note": note, **exchange})
        return exchange

    def done(self):
        self.release.set()
        self.jobs.drain(15)


def launch_then_repeat(E):
    first = E.record(E.call(launch_body(), key="k-launch-then-repeat"), "the first launch with its key")
    again = E.record(E.call(launch_body(), key="k-launch-then-repeat"), "the same launch, the same key, again")
    assert first["status"] == 202 and again["status"] == 202, (first, again)
    assert again["body"]["run_id"] == first["body"]["run_id"], "the repeat named another run"
    assert again.get("headers", {}).get("Idempotent-Replayed") == "true", again


def in_flight(E):
    held = {}

    def first():
        held["answer"] = E.call(launch_body(wait_seconds=10), key="k-in-flight")

    thread = threading.Thread(target=first)
    thread.start()
    assert E.started.wait(10), "the first launch never started its scan"
    E.record(E.call(launch_body(wait_seconds=10), key="k-in-flight"),
             "the same launch, the same key, while the first is still answering (it waits on its scan)")
    E.release.set()
    thread.join(15)
    E.record(held["answer"], "the first launch's own answer, once its scan ended")
    assert E.exchanges[0]["status"] == 409, E.exchanges[0]


def raised_then_repeat(E):
    real = E.runs.start

    def locked(*args, **kwargs):
        raise sqlite3.OperationalError("database is locked")

    E.runs.start = locked
    try:
        E.record(E.call(launch_body(), key="k-raised"),
                 "the first launch, whose run registration raised (runs.start stood in, raising once)")
    finally:
        E.runs.start = real
    again = E.record(E.call(launch_body(), key="k-raised"), "the same launch, the same key, again")
    assert again["status"] == 409 and again["body"]["idempotency"]["state"] == "unknown", again


def other_request(E):
    E.record(E.call(launch_body(), key="k-other"), "the first launch with its key")
    other = E.record(E.call({**launch_body(), "target": "https://other.offline.invalid/",
                             "scope": ["other.offline.invalid"]}, key="k-other"),
                     "the same key with another request")
    assert other["status"] == 422, other


def bad_key(E):
    answer = E.record(E.call(launch_body(), key="x" * 256), "a key longer than 255 characters")
    assert answer["status"] == 400, answer


def stood_down_repeat(E):
    from mythos_core.failsafe import FailsafeState

    first = E.record(E.call(launch_body(), key="k-stood-down"), "the first launch with its key")
    E.server.engine.governor = types.SimpleNamespace(state=FailsafeState.STOOD_DOWN)
    refused = E.record(E.call(launch_body(), key="k-stood-down"),
                       "the same launch, the same key, while the engine is stood down (governor state stood in)")
    E.server.engine.governor = None
    again = E.record(E.call(launch_body(), key="k-stood-down"),
                     "the same launch, the same key, once the engine runs again")
    assert refused["status"] == 409 and "idempotency" not in refused["body"], refused
    assert again["body"]["run_id"] == first["body"]["run_id"], again


def without_a_key(E):
    first = E.record(E.call(launch_body()), "a launch with no key")
    again = E.record(E.call(launch_body()), "the same launch again, with no key")
    assert first["body"]["run_id"] != again["body"]["run_id"], "two launches with no key named one run"


SCENARIOS = {
    "launch-then-repeat": launch_then_repeat,
    "in-flight": in_flight,
    "raised-then-repeat": raised_then_repeat,
    "other-request": other_request,
    "bad-key": bad_key,
    "stood-down-repeat": stood_down_repeat,
    "without-a-key": without_a_key,
}


def core_provenance(checkout, core_repo):
    """The mythos-core imported, by commit or by comparison with the pin, and the engine's pin."""
    import mythos_core
    where = Path(mythos_core.__file__).resolve().parent
    pinned = None
    for line in (checkout / "requirements.txt").read_text().splitlines():
        if line.startswith("mythos-core @"):
            pinned = line.rsplit("@", 1)[-1].strip()
    found = subprocess.run(["git", "-C", str(where), "rev-parse", "HEAD"], capture_output=True, text=True)
    if found.returncode == 0:
        imported = found.stdout.strip()
        return {"imported_commit": imported, "pinned_by_requirements": pinned, "compared_files": None,
                "label": "pinned core" if imported == pinned else "unpinned local core"}
    files = sorted(path for path in where.rglob("*.py") if "__pycache__" not in path.parts)
    same = 0
    for path in files:
        shown = subprocess.run(
            ["git", "-C", str(core_repo), "show", f"{pinned}:src/mythos_core/{path.relative_to(where).as_posix()}"],
            capture_output=True)
        same += int(shown.returncode == 0 and shown.stdout == path.read_bytes())
    matches = bool(files) and same == len(files)
    return {"imported_commit": pinned if matches else None, "pinned_by_requirements": pinned,
            "compared_files": {"files": len(files), "identical_to_pin": same},
            "label": "pinned core" if matches else "unpinned local core"}


def main():
    args = sys.argv[1:]
    core_repo = None
    if "--core-repo" in args:
        at = args.index("--core-repo")
        core_repo = Path(args[at + 1]).resolve()
        del args[at:at + 2]
    checkout, out_root = Path(args[0]).resolve(), Path(args[1]).resolve()
    sha = subprocess.run(["git", "-C", str(checkout), "rev-parse", "HEAD"],
                         capture_output=True, text=True, check=True).stdout.strip()
    if sha not in KNOWN:
        sys.exit(f"refusing: {checkout} is at {sha}, not a commit this script records ({', '.join(KNOWN)})")
    sys.path.insert(0, str(checkout))
    os.chdir(checkout)
    core = core_provenance(checkout, core_repo)
    out = out_root / KNOWN[sha]
    out.mkdir(parents=True, exist_ok=True)
    for name, fn in SCENARIOS.items():
        E = Engine()
        try:
            fn(E)
        finally:
            E.done()
        path = out / f"{name}.json"
        path.write_text(json.dumps({
            "engine": {"repository": "athena-engine", "sha": sha, "contract": "idempotency-key"},
            "mythos_core": core,
            "scenario": name,
            "exchanges": E.exchanges,
        }, indent=2) + "\n")
        print("wrote", path)


if __name__ == "__main__":
    main()
