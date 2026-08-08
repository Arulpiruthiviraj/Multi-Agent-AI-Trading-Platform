# Argus - DEPLOYMENT

Real deployment reference, verified against `package.json` and the current absence of any CI/container tooling for this application, 2026-08-08. Previously identical boilerplate shared with 7 other stub docs — replaced with real content.

---

## ⚠️ Before deploying anywhere reachable by anyone else

This application is **not production-ready**. Specifically, before deploying beyond your own machine:

1. **Set `APP_PASSWORD`.** Without it, every `/api/*` route — including trade execution — is open with no authentication.
2. **Understand that the WebSocket has no authentication at all**, regardless of `APP_PASSWORD`. Anyone who can reach the port sees the full live event stream. Put it behind a reverse proxy with its own access control if this matters for your deployment.
3. **Fix or work around the `BrokerManager.initialize()` gap** (see [BROKER_ENGINE.md](./BROKER_ENGINE.md)) before assuming your configured broker is actually active in a fresh deployment.
4. **Do not select Questrade/Interactive Brokers/Coinbase** — they throw on the first real order.
5. **There is no automated test suite.** Manual verification in Paper mode is currently the only verification available.

See [AI_CONTEXT.md](./AI_CONTEXT.md) for the full current-state audit.

---

## Build (real, from `package.json`)

```bash
npm run build
# 1. vite build          -> compiles the React app to dist/
# 2. esbuild server.ts --bundle --platform=node --format=cjs --packages=external
#      --sourcemap --outfile=dist/server.cjs

npm start
# node dist/server.cjs
```

`NODE_ENV=production` makes `server.ts` serve `dist/` as static files instead of using Vite's dev middleware.

## What does NOT exist for deployment

- **No Dockerfile, no `docker-compose.yml`, no CI configuration** for this Node/React application. (A fully separate, disconnected Python reimplementation under `python-platform/` has its own `Dockerfile`/`docker-compose.yml` — irrelevant to deploying the actual running app described in this doc set.)
- **No process-manager configuration** (no PM2 config file, no systemd unit) checked into the repo.
- **No health-check endpoint dedicated to orchestration probes** — the closest real thing is `GET /api/v2/system/status`, which reports `SystemBootstrap`'s running state, not infrastructure health.

## Database in production

- `data/argus.db` (or `/data/argus.db` if that absolute path exists and is writable — `db/index.ts` checks `fs.existsSync('/data')` first, useful for container volume mounts).
- Migrations run automatically on process start.
- SQLite is a single file with no built-in replication — if you need multiple app instances, you'll need to either pin all instances to a shared volume (risking write contention, since there's no `SQLITE_BUSY` retry logic in this codebase) or migrate to a client-server database, which would require changing the Drizzle adapter in `src/server/db/index.ts`.

## Reverse proxy / TLS

Not configured in this repo. If you put this behind Nginx/Caddy/similar:
- Forward WebSocket upgrades for the `/ws` path specifically (the server only upgrades connections whose `pathname === '/ws'`).
- Terminate TLS at the proxy; the app itself has no HTTPS/WSS handling of its own.

## Environment checklist for a real deployment

See [CONFIGURATION.md](./CONFIGURATION.md) for the full variable list. Minimum for a meaningfully functional deployment: `APP_PASSWORD`, `AUTH_SESSION_SECRET`, `ENCRYPTION_SECRET`, `ALPACA_API_KEY`/`ALPACA_SECRET_KEY`, at least one AI provider key.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference and full current-state risk assessment
- [CONFIGURATION.md](./CONFIGURATION.md) — environment variables
- [SETUP.md](./SETUP.md) — local development setup
