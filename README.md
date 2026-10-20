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

### First sign-in

On first start the database is created with ONE account, `admin`, and no
password is written anywhere in this repository:

- Set `ATHENA_INITIAL_ADMIN_PASSWORD` (at least 12 characters) before the
  first start to choose the admin's first password; or
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
