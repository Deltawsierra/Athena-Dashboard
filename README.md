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
| `ATHENA_FAILSAFE_PASSWORD`| unset                          | Service-account password. Analyst-role to draft pause/stand-down; admin-role to draft terminate. |
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

## Known gaps

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
