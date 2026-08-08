# Argus - SETUP

Detailed setup instructions, verified against `package.json`, `.env.example`, and `server.ts` on 2026-08-08. For the condensed fast-path version, see [QUICK_START.md](./QUICK_START.md). Previously this file was identical boilerplate shared with 7 other stub docs in this repository — replaced with real content.

---

## Prerequisites

- **Node.js 18+** (20 LTS recommended). This is a native requirement — `better-sqlite3` compiles a native addon during `npm install`, and older Node versions may not have prebuilt binaries available.
- No database server to install — SQLite is file-based and bundled via `better-sqlite3`.
- No Python runtime needed for anything the running app actually uses — the `python-platform/` directory is a fully separate, disconnected reimplementation.

## Step-by-step installation

### 1. Clone and install
```bash
git clone <this-repo>
cd Multi-Agent-AI-Trading-Platform
npm install
```
This installs both `dependencies` and `devDependencies` from `package.json`, including `drizzle-kit`, `esbuild`, and `tsx`. Watch for `better-sqlite3`'s native build step in the install output — if your environment blocks install scripts (some sandboxed CI/agent environments do), you may need to explicitly allow it (e.g. `npm install-scripts approve better-sqlite3` on npm 10+, or run the install without the restriction).

### 2. Environment file
```bash
cp .env.example .env
```
Edit `.env`. See [CONFIGURATION.md](./CONFIGURATION.md) for the complete, verified list of every environment variable the code actually reads — `.env.example` itself is missing `FINNHUB_API_KEY`, which one of the real news providers uses.

**Nothing in `.env` is strictly required to start the server.** Every integration (Alpaca, each AI provider, each news API) degrades gracefully to "idle" or "DATA_UNAVAILABLE" rather than crashing when its key is absent — see [AI_CONTEXT.md](./AI_CONTEXT.md) §30 for exactly what that degraded state looks like in practice (short version: the bot runs but produces almost no trade activity with zero keys configured).

### 3. Database

No manual step. `src/server/db/index.ts` runs Drizzle's `migrate()` automatically the moment it's imported, which happens as soon as `server.ts` starts. The database file is created at `data/argus.db` (or `/data/argus.db` if that path exists and is writable, for container deployments) on first run if it doesn't already exist.

Do **not** run `npm run db:migrate` expecting it to do something different — that script (`tsx database/migrate.ts`) points at a path that doesn't exist in this repository and will fail immediately.

### 4. Start the dev server
```bash
npm run dev
```
This runs `tsx server.ts`, which internally starts Vite in middleware mode for the frontend — one process serves both. Open `http://localhost:5000` (or your configured `PORT`).

### 5. First-run configuration

The Setup Wizard will appear. Read [AI_CONTEXT.md](./AI_CONTEXT.md) §5 before relying on it for anything beyond entering AI provider keys — it doesn't persist across a refresh and has no backend enforcement power. For broker setup specifically, also read the `BrokerManager.initialize()` note in [BROKER_ENGINE.md](./BROKER_ENGINE.md) — a freshly configured broker connection may not become the active broker on the very next server restart without that gap being addressed.

## Verifying the install worked

```bash
npx tsc --noEmit
```
Should report 0 errors in application code (2 pre-existing errors are expected in the untracked, unwired `src/server/backtesting/LookaheadGuard.ts` — that file is not on any live execution path).

```bash
npm run lint
```
This does **not** actually lint or typecheck anything — it's a no-op placeholder script (`tsx --eval "console.log('Skipping standard TSC compile for rapid deployment')"`). Use `npx tsc --noEmit` above for real type verification.

## Production build

See [DEPLOYMENT.md](./DEPLOYMENT.md).

---

**See Also**:
- [QUICK_START.md](./QUICK_START.md) — condensed fast path
- [CONFIGURATION.md](./CONFIGURATION.md) — full environment variable reference
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master current-state reference
