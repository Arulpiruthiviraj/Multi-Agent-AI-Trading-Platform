# Argus forensic SQL

Read-only queries against the current Drizzle schema (`src/server/db/schema.ts`).

Column names are SQLite names (snake_case), not TypeScript camelCase.

There are **no SQL foreign keys** in this schema. Joins below are **APPLICATION-LEVEL**.

Default DB path: `data/argus.db` (gitignored). Example:

```bash
sqlite3 data/argus.db < docs/sql/01_recent_trades.sql
```

Do not write, VACUUM into a new file, or enable LIVE/Autobot from these scripts.

Evidence: CODE-VERIFIED against `schema.ts` (2026-08-18). Runtime row presence is DATABASE-VERIFIED only when a local DB exists and the query is executed.
