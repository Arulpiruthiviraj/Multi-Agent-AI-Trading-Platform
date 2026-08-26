# Java Quant Core

Short entry point. The two real, detailed documents are:

- **[`JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md`](JAVA_QUANT_CORE_MIGRATION_BLUEPRINT.md)** — the
  design/proposal doc: architecture diagram, migration matrix (what was/wasn't ported and why),
  API schemas, phased roadmap. Kept at its original filename rather than renamed, since it is
  cited by exact path from multiple TypeScript/Java source comments, `ARGUS_CLI.md`, and the
  status audit below — renaming it would have required updating every one of those citations for
  a purely cosmetic gain.
- **[`../audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md`](../audits/JAVA_QUANT_CORE_MIGRATION_STATUS_AUDIT.md)**
  — phase-by-phase implementation status (VERIFIED / SCOPED, test counts, what's real vs. a
  disclosed gap).

## The one-paragraph version

`quant-core-java/` is a standalone Java 26 process (loopback-only, port 8085, default **off** —
`QUANT_JAVA_CORE_ENABLED=false`; **this deployment currently has it set `true`** — check the live
`.env`, don't assume the default) that computes indicator math, evaluates the 5 CORE quant
strategies' decision logic, and runs a demonstration backtester. It has **zero broker imports, zero
credentials, and no `.placeOrder()` equivalent**. When enabled, `src/server/services/
QuantCoreBridge.ts` forwards live ticks to it and logs shadow-parity divergence — every one of its
~10 HTTP calls to the Java process is wrapped in a hard timeout
(`tradingSafety.quantJavaCoreRequestTimeoutMs`), confirmed from source 2026-08-26 — it does **not**
emit trade ideas unless a **second**, independent flag (`QUANT_JAVA_CORE_LIVE_IDEAS_ENABLED`) is
also set (**confirmed unset** in this deployment's `.env` as of 2026-08-26), and even then it only
ever calls the same `eventBus.emitTradeIdea()` every other agent uses (see
`docs/architecture/MULTI_AGENT_CONSENSUS.md`) — never a shortcut around ChiefTrader, RiskEngine, or
OMS. With the bridge active, expect periodic `QUANT_CORE_PARITY_DIVERGENCE` observability events
(TS vs. Java indicator math disagreeing beyond floating-point noise, e.g. MACD by double-digit
percent in observed samples) — informational only, not itself a defect in either implementation,
but a real, open item before Java could ever become authoritative for a CORE calculation (see
CLAUDE.md's Java 26 Engine Authority rule 9, parity tests).

## Known, disclosed boundary

The 5 CORE strategies' upstream feature pipeline (RegimeEngine/trend/volume/priceAction/
supportResistance/MarketContext) is **not** ported to Java. Wiring them to evaluate real live bars
in Java requires that work first — tracked in the status audit's §2, not silently assumed done.

## Data access

Java never writes to `data/argus.db` (Node.js is the sole writer — see `CLAUDE.md`'s "SQLite: one
writer" invariant). The backtester's `SqliteBarLoader` opens it **read-only** with a 5s
`busy_timeout`, verified safe under real concurrent Node writes
(`quant-core-java/src/test/java/.../SqliteBarLoaderConcurrencyTest.java`). Parity-divergence
records and backtest reports are the only persisted outputs, and both go through the existing
TypeScript-owned paths (`observability_events`, generated markdown reports) — never a new
Java-owned table in the live database.

## CLI

```bash
./argus quant-core   # connectivity + enabled state
./argus parity       # recent shadow-parity divergences
./argus replay run --engine java ...   # the DIFFERENT demonstration backtester, not real replay
```

See `ARGUS_CLI.md` §4/§8 for details on each.
