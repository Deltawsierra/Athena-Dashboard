# Athena AI Desktop

Athena is the Mythos AI Security console: an Electron desktop app with an
embedded Express API and a local SQLite database.

## Requirements

- Node.js 20 or later
- npm

## Getting started

```bash
npm install
npm run dev          # API + Vite dev server on http://127.0.0.1:5000
```

To run the desktop shell against the dev server:

```bash
npm run electron
```

The `npm` commands are the same in PowerShell. What is not is a `NAME=value` prefix on a
command line (below): in PowerShell set the variable for the session first, with
`$env:NAME = "value"`, in the window that runs the command (the PowerShell forms below have
not yet been run on a Windows host).

### First sign-in

On first start the database is created with ONE account, `admin`, and no
password is written anywhere in this repository:

- Set `ATHENA_INITIAL_ADMIN_PASSWORD` (at least 12 characters) before the
  first start to choose the admin's first password (in PowerShell,
  `$env:ATHENA_INITIAL_ADMIN_PASSWORD = "<12 or more characters>"`); or
- leave it unset (or shorter), and a random password is generated and
  written once to `initial-admin-password.txt` in the data directory, beside
  the database (`ATHENA_USER_DATA`, the directory of `ATHENA_DB_PATH`, or the
  working directory), readable only by the user the server runs as. The log
  says where the file is; it never prints the password.

Sign in as `admin` with that password. Before anything else the app asks for
a new one (at least 12 characters, not the current one, not the username);
until it is set, the account can only change its password, sign out, read
itself, and send stops -- every scan and retest Stop, the kill switch, and a
failsafe pause, stand-down or terminate, which are never held back. Delete the
password file once you have signed in.

Earlier releases seeded two accounts with fixed passwords, published in this
repository. An install that still has either is found when the server starts,
and that account must set a new password at its next sign-in.

Nothing else is written. A default install starts with no clients, tests or
documents, so every figure on every screen comes from something you recorded.
For a demo, `ATHENA_SEED_SAMPLE_DATA=1` also writes sample clients, sites,
tests and documents on the first start (see "Seeded sample rows" below).

## Building

```bash
npm run build        # client (dist/public) + server bundle (dist/server-electron.cjs)
npm start            # run the built server without Electron
npm run dist         # build and package with electron-builder
```

Platform installers: `npm run dist:win`, `npm run dist:mac`, `npm run dist:linux`.
Output goes to `dist-electron/`.

> `better-sqlite3` is a native module, so it has to be built for whichever
> runtime is loading it: Electron's ABI when the app is packaged, Node's when the
> tests run. Both are scripted, and neither has to be remembered: `npm run dist`
> runs `rebuild:electron` first, and `npm test` runs `rebuild:node` first. Run
> `npm run rebuild:node` by hand if a stray packaging run has left the Electron
> build in place.

## Checks

```bash
npm run check        # TypeScript, client and server
npm test             # Vitest: auth, users, CRUD, SQLite storage, password hashing
```

CI runs all of the above plus both builds on every push and pull request.

## Configuration

| Variable                  | Default                        | Purpose |
| ------------------------- | ------------------------------ | ------- |
| `PORT`                    | `5000`                         | API port |
| `HOST`                    | `127.0.0.1`                    | Bind address. Loopback by default; set it deliberately to expose the API. |
| `SESSION_SECRET`          | per-install file, or random    | Signs session cookies. Required in production when not running under Electron. |
| `ATHENA_DB_PATH`          | see below                      | SQLite file, or `:memory:` |
| `ATHENA_USER_DATA`        | Electron user-data directory   | Where the database and session secret live |
| `ATHENA_STORAGE`          | `sqlite`                       | Set to `memory` for tests; nothing persists |
| `ATHENA_SEED_SAMPLE_DATA` | unset (off)                    | `1` writes the sample clients, sites, tests and documents on the first start, for a demo. Any other value, or unset, writes none. |
| `ATHENA_SKIP_SAMPLE_DATA` | unset                          | Older opt-out. `true` still means no sample records, and wins over `ATHENA_SEED_SAMPLE_DATA`. |
| `COOKIE_SECURE`           | `false`                        | Set to `true` when serving over HTTPS |
| `ATHENA_ENGINE_URL`       | unset                          | Base URL of the Mythos engine (athena-engine). Pentest Scan, Athena Scan, the CVE Classifier and the detection figures on AI Health need it. Can be set on the Settings screen instead; a stored value wins over the variable. |
| `ATHENA_ENGINE_KEY`       | unset                          | The engine's operator key. Same two places. |
| `ATHENA_ASSISTANT_URL`, `ATHENA_ASSISTANT_KEY`, `ATHENA_ASSISTANT_MODEL` | unset | An OpenAI-compatible endpoint, its key and its model, for AI Chat. With none set, AI Chat records the message and answers nothing. Same two places. |
| `ATHENA_MAX_INFLIGHT_RETESTS` | `4`                        | The most retests this dashboard asks of the engine at once. |
| `ATHENA_FAILSAFE_URL`     | unset                          | Base URL of the failsafe control plane (Athena-Backend). Enables the Failsafe console, the assurance screens and the financial views. Each person reaches it as themselves: see [Each person reaches Athena-Backend as themselves](#each-person-reaches-athena-backend-as-themselves). |
| `ATHENA_FAILSAFE_USER`    | unset                          | The stop credential's username: the service account every stop goes as (beside the service token, or alone without it). Nothing else uses it: every read and every other write goes as the signed-in person. |
| `ATHENA_FAILSAFE_PASSWORD`| unset                          | The stop credential's password. Analyst-role to draft pause/stand-down; admin-role to draft terminate. Its token is renewed with the refresh token; the password is used again only when a refresh is refused. Used only by stops. |
| `ATHENA_FAILSAFE_SERVICE_TOKEN` | unset                    | The control plane's failsafe service token (its `FAILSAFE_SERVICE_TOKEN`). Every stop this server relays presents it and waits on no sign-in; see [Stops and the failsafe service token](#stops-and-the-failsafe-service-token). Read once at start-up; never logged or sent to the browser. |
| `ATHENA_FAILSAFE_ENGINE_ID` | unset                        | Default engine id a fresh failsafe draft targets. |
| `VITE_MYTHOS_SAMPLE_MODE` | unset (off)                    | Build time. `1` turns on sample mode for prospect demos; see below. Never set it for a customer build. |

Database location, in order: `ATHENA_DB_PATH`, then `ATHENA_USER_DATA/athena.db`,
then `~/.athena-ai/athena.db` under Electron, then `./athena.db`.

### Sample mode (prospect demos only)

By default every figure on the Overview comes from the record, Settings states
only the posture a source reports, and anything nothing measures says so ("Not
measured", "Not tracked yet", "Not reported"). A demo build can show a populated
sample estate and tenant instead:

```bash
VITE_MYTHOS_SAMPLE_MODE=1 npm run dev            # or: npm run build:client
```

In PowerShell:

```powershell
$env:VITE_MYTHOS_SAMPLE_MODE = "1"
npm run dev                                      # or: npm run build:client
Remove-Item Env:VITE_MYTHOS_SAMPLE_MODE          # unset it again for a normal build
```

The flag is read at build time: a build made without it cannot show the sample
figures, and the bundler drops them from it entirely. With it on, each affected page carries a banner and
every affected panel carries the label "Sample data — not from your
environment". The sample figures live only in `client/src/sample/`; pages reach
them through `@/sample`, whose accessors refuse when sample mode is off.

### Seeded sample rows (demo installs only)

This is not the same thing as sample mode. `ATHENA_SEED_SAMPLE_DATA=1` makes
the first start write three sample clients, four sites, three tests and three
documents into the database. Two of those tests carry severity counts (fifteen
and eight findings) that no scan produced. They are real database rows, so they
are counted like any other; each row is marked as sample data, and Overview,
Deployments, Evidence, Risks, Compliance, Tests and Documents show a notice
saying how many seeded rows are on the screen, with a button (admins only) that
removes them. A default install writes none of them.

## Architecture

```
client/          React 18 + Vite + Tailwind + shadcn/ui
server/          Express API
  app.ts         middleware, sessions, error handling
  routes.ts      REST endpoints (all require a session except /api/auth/*)
  auth.ts        session guards and async handler wrapper
  storage.ts     IStorage contract + in-memory backend
  storage-sqlite.ts   SQLite backend (Drizzle)
  db-sqlite.ts   connection and schema creation
  backend-scans.ts    Athena-Backend's scans and engagements, read as the person
  backend-adoption.ts the backend's scans adopted into tests (the record is the source)
shared/schema.ts Drizzle sqlite-core tables and Zod insert schemas
tests/           Vitest suites
electron-main.cjs  Electron main process
```

Authentication is session-based: the server sets an httpOnly cookie and the
client never holds a token. Passwords are hashed with salted scrypt; hashes
written by older builds are verified once and transparently upgraded.

## Security notes

- The API binds to loopback. Every route except `/api/auth/*` requires a session,
  and user administration additionally requires the `admin` role.
- The Electron renderer runs with `contextIsolation`, `sandbox`, no
  `nodeIntegration`, and a CSP without `unsafe-eval`.
- `athena.db` and pasted developer logs are not tracked in git.
- The **Failsafe console** (admin-only, `/failsafe`) can pause, stand down, or
  terminate an engine, but holds no signing key. It drafts a command and shows
  the exact bytes to sign; operators sign them out of band with the
  `mythos-failsafe` CLI (their private key never enters the browser or this
  server), and this server only relays the signatures. Stand-down and terminate
  require two distinct operators, terminate also requires typing the engine id,
  and the engine verifies every signature itself before acting. So neither a
  compromised server nor the engine itself can trigger a failsafe.

## Stops and the failsafe service token

A stop must not depend on a password sign-in. Every stop this server relays to
the control plane goes as its service account, whose token came from signing in
with `ATHENA_FAILSAFE_PASSWORD`: on first use, after every restart, and every
hour when it expired. The backend throttles that sign-in, guesses at the
username lock it, a changed password or a fault in the account table refuses
it, and it can hang. Each of those held back, or dropped, the stop behind it.

Set `ATHENA_FAILSAFE_SERVICE_TOKEN` to the backend's `FAILSAFE_SERVICE_TOKEN`.
The backend side is athena-backend's `safety/service_token.py`, with
`FAILSAFE_SERVICE_USER` naming the account the token acts as. This server then
presents the token in the `X-Failsafe-Service-Token` header on every stop it
relays, and sends the stop at once without waiting for a sign-in:

| Stop this server relays | Backend route (athena-backend `safety/stops.py`) |
|---|---|
| A failsafe pause, stand-down or terminate drafted | `failsafe:commands` POST |
| A signature on a pause, stand-down or terminate | `failsafe:submit-signature` |
| The withdrawal of a resume or a release (it keeps an engine stopped) | `failsafe:cancel-command` |
| The stop lane's reads: the failsafe state (and the console's status read of it), the command list, one command | `failsafe:state`, `failsafe:commands` GET, `failsafe:command-detail` |
| A deployment paused (Recompute with `paused: true`) | `deployment-recompute` |
| A claim revoked or contradicted | `claim-transition` |
| A Stop's mirror into the backend's record of a scan started through it, sent after the engine's answer and never awaited by it (see [Scans start through Athena-Backend](#scans-start-through-athena-backend-the-hybrid)) | `POST /api/pentest/scans/<uuid>/stop/` |
| A deleted client's engagement withdrawn (moved off `running`; never deleted) | `PATCH /api/pentest/engagements/<id>/` with a status |

The header goes on nothing else: not on a resume or a release or a signature on
one, the withdrawal of a stop, a lift or a routine recompute, any other claim
move, the audit trail, any other read or write, or a sign-in or refresh. The
backend accepts the token only on a stop and ignores it anywhere else, so a
stolen one can stop things but cannot start anything. Where this server does
not know a command's action (a signature or a withdrawal whose command it could
not read), the request carries the header and the backend decides. If the
backend does not accept the token, the stop falls back to the service account:
a token already in hand rides along, and a 401 gets a fresh one and retries
once. This server does not relay the backend's dispatch kill switch, so it is
not in the table.

The token is never logged and never put in an answer. A control plane error
that quotes the request back has it taken out. It never reaches the browser,
because Vite passes only `VITE_` variables to the client. A value shorter than
the 32 characters the backend requires, or one no HTTP header can carry, is not
sent; start-up says why, without printing it. Unset, nothing changes: stops
sign in with the service account as before.

The service account's own token is renewed with the refresh token its sign-in
issued (`/api/token/refresh/`). The backend rotates the refresh token on every
refresh, so the rotated one is kept for the next. The password is used again
only when a refresh is refused.

Tests: `tests/a-stop-presents-the-service-token-and-waits-on-no-sign-in.test.ts`
(a pause, a stand-down, a pause's signature and a deployment pause each reach
the stop route within 300 ms while the sign-in answers 429, 500 or 401, or
hangs) and `tests/the-service-token-rides-on-every-stop-and-on-nothing-else.test.ts`
(the whole route list, no leaks, the unset case, the refresh).

## Each person reaches Athena-Backend as themselves

Every read this server relays from Athena-Backend, and every write that is not
a stop, goes there as the person who asked, with their own backend sign-in. The
backend's own tenant scoping applies to them: an owner sees only their own
deployments, and an admin or analyst sees every one. So do its role checks. And
it records them, not a shared account, as the one who acted: a reviewer and an
approver are two people. Until T6 every read went as ONE service account, an
analyst or admin that sees every tenant, and any deployment uuid a signed-in
person named was forwarded. One dashboard user could read another tenant's
reports, events and ROI.

- **Signing in.** When a person signs in here, the same username and password
  are sent to the backend's sign-in (`/api/token/`) in the background. The
  sign-in here is answered at once and never waits on the backend. If the
  backend refuses them (a different password there, no such account), or cannot
  be reached, they sign in to Athena-Backend from the banner on the Assurance
  page (`POST /api/auth/backend-sign-in` with their password there).
- **Where the token lives.** In this server's memory, keyed by the session, next
  to the session itself. The browser holds only the httpOnly session cookie, as
  before. No token is ever put in an answer, a URL, a log line or the browser's
  storage.
- **Renewal.** A token the backend refuses is renewed once with the person's
  refresh token, shared by all of that session's requests at that moment. The
  backend rotates it, and the rotated one is kept. A refused refresh ends the
  backend sign-in. The person signs in to the backend again: there is no
  password to fall back on, and never the service account.
- **Signing out revokes.** When a session ends (signing out, signing in again, an
  admin deactivating or removing the account, a password change ending the
  other sessions), its refresh token is revoked at the backend
  (`POST /api/token/revoke/`, athena-backend `safety/revoke.py`) in the
  background. Signing out never waits on it.
- **Refusals are shown.** A deployment the person's account cannot see is the
  backend's 404, passed on (`not_found` on the assurance screens, `not_served` on
  the financial views). A read their role may not make is its 403
  (`backend_refused`). A person with no backend sign-in the backend takes is
  answered 503 `backend_sign_in_required` and nothing is sent. It is never a 401,
  which would send the browser back to this console's sign-in, away from the
  kill switch.
- **API keys** carry no backend sign-in of their own. A request made with one is
  answered `backend_sign_in_required`, and nothing is sent to the backend for it.
- **SAFETY: stops are unchanged.** Every stop (the table in
  [Stops and the failsafe service token](#stops-and-the-failsafe-service-token))
  goes exactly as before: with the failsafe service token and the service
  account (`ATHENA_FAILSAFE_USER`). It never reads, waits for or renews a
  person's credential. A person whose backend sign-in is stale, refused or still
  in flight sends every stop as before.

What to set when deploying (the owner's notes):

1. **On Athena-Backend, one account per person** who uses this console, with the
   same username as their account here. Give each the role they should have
   there. A viewer sees only the deployments they own (set each deployment's
   owner). An analyst or an admin sees every tenant, so give those roles only to
   your own staff. With the same password as here, they are signed in to the
   backend automatically when they sign in here. Otherwise they sign in to it
   from the Assurance page.
2. **Deploy the Athena-Backend version with the sign-out route**
   (`/api/token/revoke/`). An older backend works, but a signed-out person's
   refresh token then stays valid until it expires (held by nobody: this server
   forgets it). The log says so.
3. **Keep** `ATHENA_FAILSAFE_URL`, `ATHENA_FAILSAFE_SERVICE_TOKEN`, and
   `ATHENA_FAILSAFE_USER` / `ATHENA_FAILSAFE_PASSWORD`. The last pair is now the
   stop credential and nothing else. Do not downgrade that account: a pause or
   stand-down needs an analyst, a terminate an admin.
4. The backend limits sign-ins per address. Every person's sign-in now comes from
   this server's address, so they share that address's budget (60 a minute by
   default).
5. Serve Athena-Backend over HTTPS (`ATHENA_FAILSAFE_URL=https://...`): each
   person's password now goes to it when they sign in, as the service account's
   always has.

What to remove: there was never a separate read credential. The one
service-account pair (`ATHENA_FAILSAFE_USER` / `ATHENA_FAILSAFE_PASSWORD`) served
both the reads and the stops. No read uses it now, so nothing is removed from
this server's environment. Keep the pair, as the stop credential. On the
backend, deactivate any account that existed only so this console could read
every tenant, if it is not the stop account.

Tests: `tests/each-person-reaches-the-backend-as-themselves.test.ts`. A backend
stand-in scopes by who asks. A cross-tenant read through this console is refused
and the right person's is served. No read goes as the service account, and none
falls back to it. Stops land with the person's sign-in stale, refused or hung.
Renewal, revocation, and no token in the browser are covered too.
`tests/the-service-token-rides-on-every-stop-and-on-nothing-else.test.ts` walks
the whole route list: every request that is not a stop goes as the signed-in
person.

## Scans start through Athena-Backend (the hybrid)

Every scan a person starts from the Athena or Penetration Testing page is
launched through Athena-Backend (`POST /api/pentest/scan/`, with the press's
`Idempotency-Key`), never sent to the engine by this dashboard itself: the
backend is the governance gate and the record. It records the owner's consent
with the scan (the box on the start form; a start without it is refused before
anything is sent, in the backend's own words), checks the client's engagement
-- its scope and its testing window -- and runs its preflight; then the engine
names the run, and this dashboard records the backend's scan id beside it. The
live view stays direct: the pages poll the engine's `GET /api/scans/{run_id}`
every 2 s, and the Stop is the engine's abort, sent directly and answered from
its headers exactly as before.

- **The engagement** (decision 2). One per client, created as the person the
  first time a scan starts for the client: `running`, scoped to every host of
  the client's sites, with the client's testing window -- 90 days from then
  when none was set, recorded on the client. A site added since widens the
  scope by PATCH; the scope is never narrowed, and the window is never
  re-dated on its own. Renewing the window is a person's act on the Clients
  page ("Renew / extend", behind a confirm step:
  `POST /api/clients/:id/testing-window/renew`), which re-dates the backend
  engagement as the person first, then records the window here; the
  engagement's own name, status and scope are read from the backend when
  asked (`GET /api/clients/:id/backend-engagement`). A deleted client's
  engagement is marked `completed` -- a stop by the backend's judgement, sent
  as every stop is -- and never deleted.
- **The record.** When the live poll first sees the run finished, a collect
  watch (`server/collect-watch.ts`: a row in `collect_watches`, resumed after a
  restart, bounded in interval and total, on the pattern of the retest watch)
  asks the backend to collect the run (`POST /api/pentest/scans/<uuid>/collect/`)
  as the person reading the page, until the record stands (200, or 409 and a
  read of it). Ending the watch is one storage step that succeeds only while
  it is still running, so of two dashboards that have the record, one files
  it: the backend's status word, verdict and label, error message, engagement
  and PDF (`findings.backend`), with the run's results and coverage as the
  record holds them. The scan pages show the record in three states -- not yet
  in the record, being collected, collected -- and "No verdict: the run did not
  finish." for a run that was stopped or failed; the PDF is relayed as the
  person (`GET /api/scans/:testId/backend-pdf`) only when the record has one.
  A scan started through the backend is never filed into this dashboard's own
  findings ledger (`findings`, `findingSightings`): the backend's record is its
  record. Rows this dashboard dispatched to the engine itself, before the
  hybrid, keep their ledger and their labels, by source (see
  [The record is the source](#the-record-is-the-source-engagements-adoption-the-ledger-by-source)).
- **The stop mirror** (decision 6). A Stop sent from here -- the scan's own,
  the kill switch's, a delete's -- is mirrored into the backend's record of the
  scan (`POST /api/pentest/scans/<uuid>/stop/`) AFTER the engine's answer went
  out, and is never awaited by anything that answers a stop: it presents the
  failsafe service token and waits on no sign-in, and only when that attempt
  fails is it sent once more as the person. The page says whether the stop was
  mirrored (`abort_mirrored` / `abort_mirror_failed` in the log). A stop the
  engine refused is mirrored too, since the backend's own stop may reach the
  run; one the engine said had already ended is not.
- **No break-glass** (decision 11). No direct launch path remains for a
  person-initiated scan: with the backend unreachable, refusing, or the person
  not signed in to it, a start is refused with the reason, and nothing is sent
  to the engine. The engine's own refusal (a loopback target, say) comes back
  through the backend verbatim. A launch the backend did not answer is said to
  be of unknown outcome, and the row the backend made is adopted from its list.

Two preconditions when deploying:

1. **The stop account** (decision 6). `FAILSAFE_SERVICE_USER` on the backend
   must be an account the backend lets stop a scan and withdraw an engagement
   (an admin), so the mirror and the withdrawal are taken on the service token.
   If they are not, the mirror falls back once to the person's credential; one
   that still fails is logged and shown as not mirrored. The Stop itself is
   unchanged either way.
2. **One tenant for both engine keys** (decision 7). The engine scopes a run to
   the tenant of the key that launched it. The key this dashboard polls and
   stops with (`ATHENA_ENGINE_KEY`) must see the runs the backend's key starts.
   If the first direct read of a new run answers 404, the row is marked
   `stop: "backend"`: no direct Stop is offered, and the page names what
   reaches the run -- the backend's own Stop on the scan's record, the kill
   switch (which sends the stop by id and mirrors it into the record) and the
   failsafes. The first direct read that succeeds clears the mark and brings
   the Stop back.

Also: authenticated scanning (a login block on the Penetration Testing page)
is refused with `auth_not_carried_by_backend`, since the backend's launch
carries no login block and the scan would run anonymously; nothing is sent.
The report's recipient e-mail goes to the backend only when the person opted
in on the start form and gave an address. A retest of a scan started through
the backend runs and shows its verdict as every retest does; its verdict is
then recorded in the backend as a retest check (see
[Retest checks](#retest-checks-a-retests-verdict-in-the-backends-record-as-what-it-is)),
never into this dashboard's own ledger, which has no finding of a backend scan
to file it on.

### Retest checks: a retest's verdict in the backend's record, as what it is

A retest asks the engine whether a finding is still there, and the engine
answers `closed`, `still_open` or `inconclusive` -- "an absence on a retest that
looked, not proof of a fix", in its own words. That verdict is a CHECK, and
Athena-Backend records it as exactly that: a `RetestCheck` against the finding
the record holds (athena-backend #189, owner decision 8), PULLED from the
engine by the backend with its own operator key -- never typed in by this
dashboard or anyone else -- so "the backend read it from the engine" is true of
every row.

- **When, and who asks** (`server/retest-check-watch.ts`). Only after this
  dashboard's own retest watch has ended with a verdict and filed what it files
  itself (`server/retests.ts`; `finding_checks` stays the dashboard's own
  filing), and only for a retest of a scan that names a backend scan, a
  bounded watch asks the backend to record the verdict, as the person who
  pressed Retest -- their own backend sign-in, lent in memory at the 202 and on
  every signed-in read of the retest, never the service account. The backend
  finding is found from the record itself: the deployments under the scan's
  backend engagement, their findings, the one whose `scan_uuid` is the scan's
  (or whose `engine_run_id` is the scan run the retested twin was listed
  under) and whose `finding_type` is the verdict's. Then
  `POST /api/assurance/findings/<uuid>/retest-checks/collect/` with
  `{run_id, twin_run_id}` -- the retest run, and the scan run the twin was
  listed under. The backend reads the engine itself and decides identity
  itself; where several findings of the type stand, its 409 with the
  candidates is the word, never a guess here.
- **What comes back, and where it is kept.** The outcome is filed on the retest
  watch's row (`retest_watches.result.backend`), and the retest views say it in
  four states and never a fifth: `recorded` -- the backend answered 201, or 200
  with the row it already held -- "Recorded in the Athena-Backend as a retest
  check (not closure evidence)"; `not_in_record` -- 404 (the engine has no run
  the backend's key can read: a run of another tenant, decision 7; or no scan
  of the record ran under that twin run), 409 or 422 (an identity that does not
  hold), in the backend's own words, asked once and never retried -- "Not in the
  Athena-Backend record: <the backend's reason>"; `asking` -- 202 (the backend
  reads the run as still going), 503 (it could not read the engine), a 403, a
  person with no backend sign-in, or a finding the record does not list yet:
  asked again at a bounded interval for a bounded total, "Athena-Backend is
  being asked to record this retest check", and never read as recorded from
  silence; `unwatched` -- the deadline reached: "stopped asking", where it
  stood and never an outcome. A retest of a scan this dashboard recorded
  directly from the engine has no backend record to be in: nothing is sent, and
  the views say "Not in the Athena-Backend record: the scan it looked again at
  was recorded by this dashboard directly from the engine, …". Logged as
  `retest_check_recorded`, `retest_check_not_in_record` or
  `retest_check_unwatched`, filed by the watch, never as a person's act. A
  dashboard that restarts resumes every asking still open, as nobody until a
  person reads the retest.
- **What it is NOT.** A retest check is not closure evidence and closes
  nothing. It never changes the backend finding's status, `last_seen`, retest
  flag, remediation state or closure standing -- `closure` on the finding is
  what a closure stands on, and no check moves it; the backend's
  `finding-closure-evidence` route stays the engine service's, for Minotaur's
  replay documents. On this side, nothing is filed into `findings` or
  `finding_checks` from the backend's answer, and no verdict is derived here:
  the backend's check is shown as the backend served it. A verdict the engine
  answered the Retest press itself with (no 202, so no watch) is not asked into
  the backend's record by this dashboard yet, and its panel says nothing of the
  backend for it -- not "recorded", not "not in the record".
- **Where it is shown.** The retest panel, under the verdict, reading the run
  again while the backend is asked; the Findings page's run-by-run list, beside
  each check a watch filed; and the Risks page's Backend record section, whose
  "Retest checks" column lists the backend finding's own `retest_checks` (the
  serializer's latest ten, newest first: the verdict word, whether the record
  knows it, the run's state -- `aborted` for a run stopped after its check was
  recorded -- and when the engine checked) under the same label, "None
  recorded" for a finding with none. Every word lives in
  `client/src/lib/backendRecordCopy.ts` and lints clean against the persona
  fence.
- **SAFETY.** Nothing here is on a stop's path. The retest's Stop
  (`POST /api/retests/:runId/abort`) authorises from memory, sends the
  engine's abort and writes after, exactly as before; the kill switch stops
  every known run by id without reading. The asking starts after the retest
  watch has ended, off every request path; no stop, no 202 and no kill switch
  awaits a collect, and a collect that fails is recorded on the row and asked
  again -- never anything else.

Tests: `tests/a-retest-check-collect-is-read-by-its-answer-field.test.ts` (the
stand-in's route and the client's reading of each answer),
`tests/a-retest-of-a-hybrid-scan-is-recorded-in-the-backend-as-a-retest-check.test.ts`
(the watch, end to end, and the kill switch while a collect is held) and
`tests/a-retest-check-is-labelled-as-what-it-is-on-every-screen.test.tsx` (the
labels); the hard gates `tests/a-stop-goes-first-and-a-retest-verdict-is-never-lost.test.ts`
and `tests/a-running-retest-keeps-its-stop-on-every-screen.test.tsx` stand unchanged.

Tests: `tests/every-scan-starts-through-the-backend-and-its-stop-stays-direct.test.ts`,
`tests/a-finished-hybrid-scan-is-collected-into-its-backend-record.test.ts`,
`tests/a-backend-record-is-collected-once-across-a-restart.test.ts`,
`tests/a-stop-is-mirrored-to-the-backend-record-after-its-answer.test.ts`,
`tests/a-testing-window-is-renewed-only-by-a-person-s-act.test.ts` and
`tests/the-backend-record-panel-shows-three-states-and-never-a-verdict-from-silence.test.tsx`;
the stand-in backend they drive is `tests/helpers/hybrid-backend-stand-in.ts`,
pinned by `tests/the-hybrid-backend-stand-in-answers-the-pinned-shapes.test.ts`.

## The record is the source (Engagements, adoption, the ledger by source)

Athena-Backend is the record of every scan started through it -- from this
dashboard or from anywhere else -- and of the findings and deployments its
ingest made of them (owner decisions 1 and 4). This dashboard reads that record
as the signed-in person and shows it as it stands; it never derives a figure
from silence, never files a backend finding into its own ledger, and never adds
the backend's population to its own.

- **The record, read as the person** (`server/backend-scans.ts`,
  `server/assurance.ts`). `GET /api/record/engagements` reads the engagements
  the person can see, every page of the backend's scans list (DRF `next`
  followed, up to a bound) and the deployments with the engagement each was
  ingested under; `GET /api/record/clients/:id/findings` reads a client's
  findings in the record -- those of every deployment under the client's
  engagement, each with the scan it came from (`scan_uuid`, `engine_run_id`)
  and the row here for that scan. Every read is bounded by the read deadline
  and on no stop's path. A part that could not be read is answered as unread,
  with the reason: an empty list is a measurement, an unreadable one is not.
- **Adoption** (`server/backend-adoption.ts`, `POST /api/record/adopt`). Every
  scan the backend lists for the person that this dashboard has no row for --
  started from another dashboard, from the backend's own console, or by a
  launch whose answer was lost -- gets one row, from the record alone: the run
  id the record names (never one a person supplies), the target, the backend
  scan and engagement ids, `source: "backend"` and when it was adopted. A
  pending record reads running until the engine's live word; a finished one
  (completed, stopped, failed) is adopted with the detail's results and
  coverage, its counts and the record's snapshot, so the scan page answers it
  from the record and asks the engine nothing. One row per backend scan (a
  unique index on `findings.backendScanId`; a database that already holds
  duplicates opens and reports them). No client or site is ever made up: the
  client is the one whose `backendEngagementId` names the engagement, and a
  scan under an engagement no client here names has `tests.client_id` null and
  reads "Not linked to a dashboard client". An adopted running scan takes the
  hybrid's rule before any direct Stop: marked `stop: "backend"` until the first
  direct read of its run by this dashboard's key succeeds, sent after the
  sync's answer and never awaited by it; from then its Stop is the engine's
  abort, and the kill switch stops it as it stops every other. The sync is
  asked once per sign-in from the app's shell and again when the Engagements
  page loads, is throttled per session on the server, adopts at most 25 rows
  per sync (the rest wait for the next), and is never on a stop's path: a Stop
  and the kill switch are each answered while a sync is held at the backend's
  list. Nothing is filed into this dashboard's own findings ledger by it.
- **The Engagements page** (`/engagements`, beside Assurance). Each engagement
  the person can see, with the dashboard client it is linked to or the plain
  word that it is linked to none (its own heading), the backend's client name,
  scope hosts, status word and testing window ("Window ended" once it has
  passed), its scans counted by the backend's status words and verdict labels
  from the list's rows -- "no scans recorded" only of a list read whole, the
  reason and no count where the list could not be read -- and the deployments
  ingested under it with their decision, findings count and coverage manifest
  state. Each scan's outcome is the backend's: the verdict label of a completed
  one, "Stopped on the engine: …" and "Failed on the engine: …" from the
  record's error message, "The launch's answer is still awaited" for a pending
  scan the engine has not named a run for. An adopted row opens the scan page
  (`/athena?test=<id>`), its report through the row's relay; a deployment opens
  the Assurance page narrowed to it (`/assurance?deployment=<uuid>`). A person
  with no backend sign-in is told to sign in and shown no list.
- **The ledger by source** (decision 1). `findings` and `finding_sightings`
  carry `source`, `"dashboard-direct"` for every row this dashboard filed
  directly from the engine -- the rows written before the column existed read
  so too. Those rows stay: read-only, labelled by their source on every surface
  ("recorded by this dashboard directly from the engine"), and never counted
  as the backend's record. The Risks page shows the client's findings in the
  Athena-Backend record in their own section (severity, title, status label,
  deployment, engine run, the scan each came from) above its own register,
  which stays under its own label; the Overview's record tiles count the
  backend's findings from its deployments, this dashboard's own ledger's open
  findings and the engine's live runs on three tiles from three sources, never
  one sum; the Tests page filters its rows by source and says of an adopted
  row where it came from.

Tests: `tests/the-record-is-read-as-the-person-and-never-as-empty.test.ts`,
`tests/backend-launched-scans-are-adopted-into-the-record-index.test.ts`,
`tests/the-engagements-page-shows-the-record-and-counts-no-silence.test.tsx`,
`tests/the-ledger-is-labelled-by-source-and-never-summed.test.tsx`; the
run-id gate `tests/a-test-is-given-an-engine-run-only-by-the-scan-that-started-it.test.ts`
says adoption writes only a run id the backend record names, and the
kill-switch gate stops an adopted scan as it stops every other.

## Relay reads never hold a stop

A browser keeps few connections to this server (Chromium, so Electron: six over
HTTP/1.1), and a stop needs one. So every read this server relays from a backend,
other than a stop's, holds the browser's connection for at most **one total
deadline: 20 s, headers and body together** (`server/read-deadline.ts`).

- **What is bounded:** every assurance read (`/api/assurance/*`, GET), the
  economics reads, and the engine's and the assistant's display reads
  (`ENGINE_RELAY_READS`, `ASSISTANT_RELAY_READS` in `server/routes.ts`).
- **At the deadline:** the browser is answered `504 {"code":"backend_timeout"}`,
  or cut where the answer had begun. A control-plane read is cancelled with it,
  headers and body.
- **In the browser:** every query passes React Query's AbortSignal
  (`client/src/lib/queryClient.ts`). A read is cancelled when its screen is left
  or shows something else.
- **What is never bounded:** a stop, pause, stand-down, terminate or revoke.
  - The deadline is laid on GETs only, and no stop is a GET.
  - The control-plane client never gives a stop, or any write, a read's
    cancellation signal (`readSignalFor`).
  - The failsafe console's reads, which the control plane judges stops, are not
    under it. `server/failsafe.ts` bounds each of them itself.
  - Stops in the browser are mutations (`apiRequest`), which take no signal.

## Economic Exposure (financial views)

The **Economics** screen (`/economics`, under Tools) shows one scenario version's
financial exposure exactly as Athena-Backend's economics routes serve it: the
scenario card, the distribution (P10, P50, P90, mean, expected annual loss and
severe-but-plausible, for gross and retained cash), the cost waterfall (the
market-value reaction on its own line, never in cash), the sensitivity tornado,
current against residual (the remediation option's ROI, with the deployment's
standing decision and the gross line beside a retained headline), the currency
bridge (the report's valuation date and its conversions), the Validity Card, and
the receipt: its reference, the result's own report to download, and the
receipt's signed bytes.

The version is picked, not typed: a deployment from the deployments list, then
one of its scenario versions from the backend's scenario list, a page at a time
(25 a page, as served). Each version shows its templates, its latest exposure
run's status, and that run's grade, banner and exclusion from every total, with
why. Paging moves only to the `previous` and `next` pages the list names.
Picking a version reads its latest exposure run.

It reads five things through this server (`server/economics.ts`), all named by
uuid or page number. No other parameter is forwarded.

| Route | Reads |
| --- | --- |
| `GET /api/economics/report?deployment=&scenario=[&simulation=][&download=1]` | the report of one result (`mythos.economics.report/v2`) |
| `GET /api/economics/events?deployment=&scenario=` | the scenario's events and their templates |
| `GET /api/economics/roi?deployment=&scenario=` | the remediation option's economics |
| `GET /api/economics/scenarios?deployment=[&page=][&page_size=]` | the deployment's scenario versions, a page at a time (a page size of at most 100) |
| `GET /api/economics/receipt?deployment=&receipt=&digest=` | a Financial Exposure Receipt's signed DSSE envelope, as stored, as a download |

A receipt is the report's `receipt_id`, sent to the backend dashed; `digest` is the
report's `receipt.document_digest`, the digest the page shows. The receipt's bytes
are passed on only when both of these hold, and otherwise refused (502) with none
of them sent:

- their SHA-256 is the `X-Content-SHA256` the backend sent with them;
- the envelope's payload is the document whose digest the page shows.

The page checks both again on the bytes it receives, before it saves them. A missing
header is refused too. When both agree, the bytes go out exactly as they came, with
`Content-Disposition: attachment`, `nosniff`, `no-store` and the header.

How a read is passed on:

- Only a backend 200 with a JSON media type is passed on, as its bytes, unmodified;
  anything else is refused (502) and none of it is sent.
- Every answer is `Content-Type: application/json`, `X-Content-Type-Options:
  nosniff` and `Cache-Control: no-store`. The report's download is
  `Content-Disposition: attachment; filename="economics-report.json"`, pinned to
  the result on screen. A receipt is `financial-exposure-receipt-<id>.json`.
- A backend 4xx is quoted; a 5xx, an unreachable backend or a timeout is a fixed
  sentence and code (the cause is logged on the server).
- **SAFETY:** one total deadline, 20 s for headers and body together, bounds every
  read (see [Relay reads never hold a stop](#relay-reads-never-hold-a-stop)): past
  it the browser's connection is answered (504) or cut, and the backend read
  cancelled, headers or body. Every economics route is mounted behind
  `boundedRelayRead`. The screen cancels its reads, the picker's and the receipt
  download included, when it is left or shows another scenario. So stalled
  economics reads never fill the browser's few connections to this server ahead
  of a stop. The reads go to the backend as the signed-in person, as the
  assurance reads do: a deployment their account cannot see is the backend's 404
  (`not_served`) or 403, shown, never its documents (see
  [Each person reaches Athena-Backend as themselves](#each-person-reaches-athena-backend-as-themselves)).

The rules the views keep, each pinned by a test (`tests/economics-*.test.ts*`):

- The browser does no arithmetic on money: every amount is the backend's decimal
  string, shown as served, at the currency's minor unit as the backend states it
  (JPY 0 places, KWD 3), and never parsed to a float.
- Scenarios are never totalled; a portfolio total is the backend's to make. The
  scenario list carries no figure; the picker adds nothing up.
- A result graded Unknown (or not graded, or refused) carries the report's banner,
  "Unknown: not for capital decisions", above every figure.
- A refused result shows its refusal code and kept inputs, by name, and no figure;
  beside it the ROI view shows the refusal and nothing else.
- `excluded_from_totals` and every downgrade reason are shown; stale or downgraded
  data is marked.
- A residual (counterfactual) run is shown only against the current run, never as
  exposure. The guard fails closed: a result's figures are shown only when its
  report says it is the scenario's own run (`residual_of: null`) and the ROI read
  has settled, served or answered "not served" by the backend itself.

"Not served" is read from the document, never written in: it is shown only where
the served document lacks the field. A field the backend serves as not reported
shows the backend's reason. The valuation date is the currency bridge's, with
where the backend read it from. While a run converts nothing (`conversions: []`),
the bridge shows the backend's statement why. A v1 report, which has no currency
bridge, says both are not served. The fixtures the tests read are the backend's own
answers at Athena-Backend master e7ee3eb, headers included. They are synthetic,
and are regenerated by `tests/fixtures/economics/generate.py`.

## Retries and duplicates

People press again when a button's answer never arrives: the connection
dropped, the page reloaded, or the wait gave up. Before this change, a second
press of Start scan started a second scan of the same customer, and a second
Push filed a second ticket. Now each press of Start scan, Retest or a
connector's Push gets its own `Idempotency-Key` (`crypto.randomUUID`, made by
the page: `client/src/lib/keyedPress.ts`, `shared/idempotency.ts`). The same
key goes with a press sent again only while that press's outcome is unknown,
and only when it asks for exactly the same thing. Every other press is a new
action with a new key. No key is ever made or sent again with a new key on its
own.

This server checks the key (1 to 255 printable ASCII characters; anything else
is refused 400 as a bug in the page, and nothing is sent). It passes the key on
scoped to the signed-in account (`server/idempotency.ts`):

| Press | Passed on to | What a press sent again gets |
|---|---|---|
| Start scan (`POST /api/scans`) | the backend's `POST /api/pentest/scan/`, which reads the key and replays its first answer (`Idempotent-Replayed`); the backend launches the engine with the scan's own key | The first press's answer, naming the same backend scan and the same run, marked `replayed`. The row that press recorded is the answer: no second backend scan, no second row, no second log line. A run the first press started but never recorded here is recorded once, by this press. |
| Retest (`POST /api/tests/:testId/retest`) | the engine's `POST /api/remediation/retest`, which does not read a key yet | Unchanged: while the first retest may still be running, its held slot refuses a second one (409), with no engine call. |
| Push (`POST /api/assurance/deployments/:uuid/connectors/:connector/push`) | the backend's push, which reads the key (athena-backend #113) | The first push's answer, marked `replayed`, with no second ticket and no second log line. |

What the answers mean on screen:

- **Replayed:** this is the scan (or push) the earlier press started, and no new one was started.
- **Unknown** (`scan_outcome_unknown`, `push_outcome_unknown`, `idempotency_in_flight`):
  "We don't know whether this started. Check the scans list" (for a push, the
  connector's system). The first press is still being answered, or it raised,
  or no answer came back. The same press may be sent again with its key; it is
  never sent again with a new one.
- **A bug** (`idempotency_bug`, `idempotency_key_invalid`): the key itself was
  refused (the same key with another request, or a key that is not one). It is
  shown as a bug, and nothing was started.

A stopped engine refuses a scan pressed again exactly as it refuses a new one,
and that refusal is shown as a refusal. Admission runs first on every request:
the session, the kill switch, the AI Control switches and Max Concurrent Tests.
Stops never carry a key: a scan's or a retest's Stop, the kill switch and the
failsafe relays send none, and every stop is processed every time. Without a
key (a caller other than these pages), nothing changes: a start sent again
starts again. Tests:
`tests/a-press-sent-again-with-its-key-starts-one-scan-and-is-recorded-once.test.ts`
(against answers the engine sent at 79ba4af,
`tests/fixtures/engine-idempotency/`) and
`tests/a-press-keeps-its-key-only-while-its-outcome-is-unknown.test.ts`.

## Known gaps

- Scans started from the Athena and Penetration Testing pages start through
  Athena-Backend and are in its record (see
  [Scans start through Athena-Backend](#scans-start-through-athena-backend-the-hybrid)),
  and every scan the backend lists that this dashboard has no row for is
  adopted into one (see
  [The record is the source](#the-record-is-the-source-engagements-adoption-the-ledger-by-source)).
  Rows recorded before that, by this dashboard directly from the engine, stay:
  read-only, labelled by their source (`source: "dashboard-direct"`) on every
  surface, never counted as the backend's record, and no backend verdict, claim
  or report applies to them. The two populations are not reconciled here. A
  retest of a scan started through the backend shows its verdict but files it
  into neither record, and no retest is authorised from here for an adopted
  scan whose engagement no dashboard client names. The backend's
  `retest_checks` on a finding are read but not yet shown. Authenticated
  scanning cannot start through the backend yet (`auth_not_carried_by_backend`).
- A retest pressed again after its first retest has finished starts a second
  retest. The engine reads the key only on `POST /api/scan` so far, and the held
  slot covers a retest only while it may be running.

- The Windows icon at `build/icon.ico` is a placeholder and must be replaced
  before shipping an installer.
- Pentest Scan, Athena Scan and the CVE Classifier read the Mythos engine, and AI
  Chat reads the assistant endpoint; none shows placeholder data. Each is only as
  connected as its configuration (see the table above): with no engine set, the
  scan screens say so and their button stays down, and with no assistant set, AI
  Chat answers nothing.
- The **AI Health** screen shows readings the server takes every minute, and
  detection only as the engine measured it: the engine runs its detection
  benchmark once each time it starts and reports it on its `/health`. The
  screen shows the share of attack cases caught
  (security retained) beside the share of legitimate cases let through
  (utility retained, 1 − the false-positive rate), for the tuned and the
  holdout corpus, with the counts, the run, the commit and the time. Each share
  shows its change since the latest earlier measurement that differs, so a
  change that raises one and lowers the other is visible. These figures
  describe the corpora checked in beside the engine's code, not traffic in
  general, and no Validity Card has been issued for that benchmark. When there
  is no measurement, the screen shows no number and says why. That covers no
  engine, an engine older than the report, a run not finished, and a report the
  dashboard cannot read. Detection accuracy and the false-positive rate are
  not shown as single figures, and the Achilles and Minotaur measurements are
  not on this screen.
