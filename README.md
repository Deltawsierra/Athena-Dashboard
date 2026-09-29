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

On first start the database is created and seeded with two admin accounts:

| Username    | Password       |
| ----------- | -------------- |
| `admin`     | `admin123`     |
| `testadmin` | `testpass123`  |

**Change both passwords after your first sign-in.** They exist so a fresh
checkout can be opened; they are not meant to survive into any real use.

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
| `ATHENA_FAILSAFE_URL`     | unset                          | Base URL of the failsafe control plane (Athena-Backend). Enables the Failsafe console. |
| `ATHENA_FAILSAFE_USER`    | unset                          | Service-account username the console uses to reach the control plane. |
| `ATHENA_FAILSAFE_PASSWORD`| unset                          | Service-account password. Analyst-role to draft pause/stand-down; admin-role to draft terminate. Its token is renewed with the refresh token; the password is used again only when a refresh is refused. |
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

The header goes on nothing else: not on a resume or a release or a signature on
one, the withdrawal of a stop, a lift or a routine recompute, any other claim
move, the audit trail, any other read or write, or a sign-in or refresh. The
backend accepts the token only on a stop and ignores it anywhere else, so a
stolen one can stop things but cannot start anything. Where this server does
not know a command's action (a signature or a withdrawal whose command it could
not read), the request carries the header and the backend decides. If the
backend does not accept the token, the stop falls back to the service account:
a token already in hand rides along, and a 401 gets a fresh one and retries
once. This server does not relay the backend's dispatch kill switch or an
engagement's withdrawal, so neither is in the table.

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
| Start scan (`POST /api/scans`) | the engine's `POST /api/scan`, which reads the key (athena-engine #77) | The first press's answer, naming the same run and marked `replayed`. The row that press recorded is the answer: no second row, no second filing, no second log line. A run the first press started but never recorded here is recorded once, by this press. |
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
