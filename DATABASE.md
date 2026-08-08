# Argus - DATABASE

Design notes, backup, and maintenance for the real SQLite database. For the full table-by-table schema reference, see [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) — this file previously duplicated identical boilerplate with 7 other stub docs and has been replaced with distinct, real content.

---

## File location and engine

- **Real path**: `data/argus.db` (plus `-shm`/`-wal` companion files, since `journal_mode = WAL` is set in `src/server/db/index.ts`).
- **Not** `sqlite.db` at the repository root — that file is an orphaned leftover from earlier development; nothing in the current code reads or writes it.
- **Engine**: `better-sqlite3` (synchronous, in-process — every query blocks the Node event loop for its duration).
- **ORM**: Drizzle.

## Design philosophy (as actually built, not aspirational)

The schema is a flat, denormalized collection of 20 tables rather than a strictly normalized relational design — most tables have no foreign key constraints even where a logical relationship exists (e.g. `ai_models.providerId` references `ai_providers.id` conceptually but isn't declared as an FK in `schema.ts`). This is consistent with the app's overall approach: fast iteration over strict relational integrity.

Two tables exist with complete schemas and **zero writers found anywhere in the codebase** during the 2026-08-08 audit: `event_traces` and `prediction_engine_weights`. If you're adding a feature that seems like it should already be tracked in one of these tables, verify — it probably isn't being written to yet.

## Performance characteristics (real, not tuned)

- Because `better-sqlite3` is synchronous, every `db.select()`/`db.insert()` call blocks the event loop. `RiskEngine.evaluateRisk()` alone issues up to 4 sequential DB queries per trade proposal (settings, trades history for circuit breakers, news_clusters for the veto check, and an implicit portfolio lookup via the broker).
- No connection pooling is relevant here (SQLite is a single file, single process) but there is also no explicit `SQLITE_BUSY` retry logic anywhere in the codebase — if you introduce concurrent writers (e.g. running the server in a cluster), expect lock contention with no graceful handling.
- `NewsProviderManager.fetchAllLatest()` awaits its 7 providers **sequentially** in a `for` loop, not in parallel — this isn't a database issue but is the dominant latency source in the news pipeline's 10s cycle.

## Backup

```bash
# Stop the server first if you want a guaranteed-consistent snapshot (WAL mode
# means a copy taken while the server is running can miss recently-committed
# but not-yet-checkpointed pages)
cp data/argus.db data/argus_backup_$(date +%Y%m%d).db
```

There's also a real, working HTTP-based backup/restore pair:
```http
GET  /api/v1/system/export-db   # downloads the live data/argus.db file
POST /api/v1/system/import-db   # overwrites it with a raw octet-stream upload (50mb limit)
```
Both were previously broken (pointed at a nonexistent `database/argus.db` path) — fixed to use the real path exported from `src/server/db/index.ts`. Note `import-db` writes directly to the file the running process has open via `better-sqlite3` — restart the server after importing rather than assuming the in-memory connection picks up the new file contents live.

## Migrations

Run automatically on every server start (`db/index.ts` calls Drizzle's `migrate()` at import time, before anything else touches the DB). There is nothing to run manually — `npm run db:migrate` is broken (points at a nonexistent `database/migrate.ts`) and should not be relied on.

To add a schema change: edit `src/server/db/schema.ts`, then `npx drizzle-kit generate`, review the output under `drizzle/`, and let it apply automatically on the next server start.

---

**See Also**:
- [DATABASE_SCHEMA.md](./DATABASE_SCHEMA.md) — full table reference
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master reference
