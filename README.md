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
checkout can be opened; they are not meant to survive into any real use. Set
`ATHENA_SKIP_SAMPLE_DATA=true` to seed the accounts without the sample clients,
tests and documents.

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
| `ATHENA_SKIP_SAMPLE_DATA` | unset                          | Seed users only, no sample records |
| `COOKIE_SECURE`           | `false`                        | Set to `true` when serving over HTTPS |
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

This is not the same thing as the installer's seeded rows
(`ATHENA_SKIP_SAMPLE_DATA`): those are real database rows, counted like any
other, with a notice on each screen that shows them and a button to remove them.

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
- The Pentest Scan, CVE Classifier, AI Chat and AI Health screens
  still display placeholder data. They are not yet connected to the Mythos
  engine; that is the next phase of work.
