# Offline forensic tooling

**Classification: OFFLINE-FORENSIC** (per the 2026-09-14 overnight remediation's observability
safety classification — mandate section 29). These scripts run only against artifacts already on
disk (`.heapsnapshot` files), as a fully standalone Node process. They are never imported by the
application, never run inside the trading process, and must never be added to any live code path.

## `analyze_heap_snapshot.mjs`

Streams a `.heapsnapshot` file and aggregates node count/self_size by V8's coarse 15-value type
enum (string, object, array, closure, ...). Memory footprint is O(1) with respect to file size —
verified live (2026-09-14) against a real 2.04GB snapshot under a hard `--max-old-space-size=512`
cap, completed in ~11s.

```
node --max-old-space-size=512 scripts/forensic/analyze_heap_snapshot.mjs <path-to-.heapsnapshot>
```

## `sample_heap_snapshot_strings.mjs`

Streams a `.heapsnapshot` file's `strings` table and returns a bounded, evenly-spaced sample
(never the full table) — useful for spotting a dominant string pattern (e.g. a specific field or
id format) without a full parse.

```
node --max-old-space-size=512 scripts/forensic/sample_heap_snapshot_strings.mjs <path> <sampleEveryN> <maxSamples>
```

## Known limitation

Neither script parses the `edges` array, so neither can compute real retainer paths / dominators
(the question "who is holding a reference to this object" requires cross-referencing nodes against
edges, a substantially larger undertaking). They answer "what exists in the snapshot," not "what is
retaining it." For a full retainer-path analysis, load the `.heapsnapshot` file into Chrome
DevTools' Memory panel on a machine with enough free RAM headroom that doing so cannot compete with
or destabilize anything else running (never the live trading host under memory pressure).

## 2026-09-14 P1-A finding, using these tools

Real run against `argus-2026-09-14T20-17-52-271Z-first-warning.heapsnapshot` (2.04GB, captured live
during the P1-B incident): 30,377,433 nodes, 92,056,473 edges. `string` nodes dominate — 18,271,808
of them (59.5% of total self_size, 861MB). A bounded content sample showed the dominant recurring
shape is `trace_<SYMBOL>_<epochMs>_<hash>` (the exact format of `generateTraceId()`), interleaved
with ISO-8601 timestamps, UUIDs, and full agent-reasoning text blobs (Chronos/TechnicalAgent
explanation strings) — consistent with retained decision/trace-lifecycle data, though not proven to
a specific owner. `EventStore.ts`'s in-memory ring (`recentEvents`, `tradeTraces`) was investigated
as the leading hypothesis and **ruled out by evidence**: its configured caps
(`eventStoreMaxRecentEvents: 200`, `eventStoreMaxTraces: 500`) are small and correctly enforced —
far too small to account for 18M+ retained strings. The true retaining owner remains
**UNRESOLVED** — see `docs/audits/ARGUS_MASTER_REMEDIATION_BASELINE.md` for the full record and
next-step recommendation.
