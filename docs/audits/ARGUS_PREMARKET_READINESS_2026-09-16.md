# ARGUS — Final Overnight Pre-Market Readiness (2026-09-16, prepared for the next RTH session)

## What this document is and isn't

Sections 1–4 below were executed and verified tonight, with real evidence. Sections 5–11 of the
originating mandate — watching the actual 09:30–10:30 ET open, capturing a live trade lifecycle if
one occurs, classifying the first blocker if none does — **cannot be performed tonight**, because the
market is closed. Nothing in those sections is fabricated or pre-answered here. What follows for
those sections is a tested, ready-to-run runbook for whoever is watching at the next open (this
session, if still live, or a future session picking this up) — not a report of results that don't
exist yet.

## 1. Current production state — verified

| | |
|---|---|
| PID | 25936 (unchanged all evening — not restarted for this pass, correctly) |
| Uptime | ~76 minutes at check time |
| Git HEAD | `2d8670b` (unchanged; both fixes remain uncommitted working-tree changes, consistent with this session's practice throughout) |
| `paperTradingOnly` | `true` |
| `LIVE_NO_GO` | yes |
| Trading state | `TRADING_ENABLED` |
| Broker | `ibkr_gateway`, authenticated |
| Market data | connected |
| Watchdog | `READY`, PID 16060 (unchanged) |
| Reconciliation | clean (`matches: 1, mismatches: null`, latest check) |
| Positions | flat |
| Open orders | 0 |
| RSS / heap | 747.2 MB / 110.8 MB |

**No restart performed** — the process was already healthy; restarting it for this pass would have
been exactly the "restart without a genuine reason" this session has repeatedly declined to do.

## 2. Test contamination — verified none

| Check | Result |
|---|---|
| Trades today (`data/argus.db`) | 0, unchanged |
| Portfolio | `[]`, unchanged |
| `agent_confidence_calibration` | 38 rows, all `RAW_BETA_BINOMIAL`, unchanged |
| Synthetic/seed markers in today's `agent_predictions` | 0 |
| Tonight's new certification tests | Ran exclusively against isolated in-memory/temp SQLite DBs (the same `resetOpportunityScanForTests()` + vitest test-DB pattern already used everywhere in this codebase) — never touched `data/argus.db` |

## 3. Tomorrow's live funnel telemetry — prepared and tested tonight

New file: **`scripts/morning_funnel_status.ts`** — read-only (`better-sqlite3`, `{ readonly: true }`),
safe to run at any time including while the live engine is running (never a second writer, never
touches trading state). Usage:

```
npx tsx scripts/morning_funnel_status.ts [YYYY-MM-DD]   # defaults to today
```

Reports, in one pass: distinct symbols scanned/admitted at the discovery layer;
`ADV_BELOW_FLOOR` vs `ADV_DATA_UNAVAILABLE` counts; subscribe requests broken down by reason
(including the new `BROAD_UNIVERSE_TOPUP` tag, so tomorrow's observer can directly see whether the
fix is contributing real requests); IBKR entitlement-rejection counts by symbol; distinct-symbol
reach per agent (Technical/Kronos/Quant/Java); the full decision funnel (ideas → consensus → risk →
orders); and a sample symbol trace table for AAPL/AMD/AMZN/AVGO/SPY/QQQ/GLD covering exactly the
columns the mandate asked for (admitted / subscribe requests / IBKR rejections / per-agent reach).

**Verified working tonight** against tonight's real data (see §6 below for what that test run
incidentally revealed) — not merely written, actually run and confirmed correct.

The `WATCHLIST_SUBSCRIBE_REQUESTED` event's `reason` field already distinguishes
`SNAPSHOT_HOT_SWAP` / `SEED_UNIVERSE_EXPANSION` / `BROAD_UNIVERSE_TOPUP` (the last one new tonight).
Combined with `IBKR_MARKET_DATA_ERROR` (entitlement rejection) and `SUBSCRIPTION_ALREADY_ACTIVE`
(already-active, no-op), tomorrow's observer can distinguish every category the mandate named except
two that don't currently have a dedicated event: `CAPACITY_WAIT` and `PACED/THROTTLED` are not
separately instrumented today — a symbol that didn't make a cycle's top-N cut simply produces no
subscribe-request event that cycle, which is observationally indistinguishable from "not yet
reached" versus "explicitly paced." This is a real, honestly-disclosed observability gap, not fixed
tonight (adding a new event type is exactly the kind of speculative change the mandate said not to
make).

## 4–5. Watching the open — runbook, not a report

This cannot be executed until the market opens. When it can:

1. Run `npx tsx scripts/morning_funnel_status.ts` at approximately premarket, 09:30, 09:35, 09:45,
   10:00, 10:15, and 10:30 ET, saving each output.
2. Do not intervene, restart, or change any threshold merely because trade count is zero at any of
   these checkpoints.
3. Only restart if a genuine fault appears (broker disconnect, reconciliation mismatch, crash) — not
   for a non-critical reason.

### Tomorrow's actual diagnostic question

With the AMZN/AVGO subscription-planning gap now closed, the useful question at the open is no
longer "why didn't this symbol get subscribed" — that code path has evidence behind it. It's:

> For symbols the discovery system legitimately admits, what proportion progresses through
> subscription → usable market data → agent evaluation → consensus, and where does the first
> remaining bottleneck actually occur?

Walk each admitted symbol down this tree and stop at the first "NO" — that's the real bottleneck for
that symbol, not a guess:

```
ADMITTED
   |
SUBSCRIPTION_REQUESTED?
   |-- NO  -> subscription-planning/path issue (the class of bug fixed tonight - should be rare now)
   `-- YES
        |
      IBKR_ACCEPTED?
        |-- NO  -> entitlement/capacity/external broker issue (the known, disclosed limitation)
        `-- YES
             |
           DATA_RECEIVED?
             |-- NO  -> ingestion/connectivity issue
             `-- YES
                  |
                AGENT_EVALUATED?
                  |-- NO  -> routing/coverage issue
                  `-- YES
                       |
                     CONSENSUS >= 0.75?
                       |-- NO  -> evidence/calibration/consensus gate (today's dominant, legitimate reason)
                       `-- YES
                            |
                          RISK PASS?
                            |-- NO  -> legitimate risk rejection
                            `-- YES -> ORDER -> FILL -> POSITION -> P&L
```

`scripts/morning_funnel_status.ts`'s sample-symbol-trace table already reports enough columns
(admitted / subscribe requests / IBKR rejections / per-agent reach) to place most admitted symbols on
this tree without additional instrumentation; consensus/risk/order stages are already covered by the
existing `transaction_traces`/`risk_assessments`/`trades` counts the script also prints.

## 6. What tonight's script test-run incidentally showed (end-of-day, NOT a market-open result)

Running `morning_funnel_status.ts` against tonight's *already-closed* session data (for verification
only, not as tomorrow's answer) showed something worth flagging now rather than waiting:

| Symbol | Admitted (latest) | Subscribe requests today | IBKR rejections today | Technical | Kronos | Quant | Java |
|---|---|---|---|---|---|---|---|
| AAPL | NO* | 367 | 129 | 0 | 4 | 3 | 36 |
| AMD | NO* | 410 | 132 | 2 | 3 | 0 | 0 |
| **AMZN** | NO* | **9** | **5** | 0 | 0 | 0 | 0 |
| **AVGO** | NO* | **9** | **5** | 0 | 0 | 0 | 0 |
| SPY | not scanned (core anchor) | 367 | 5 | 101 | 533 | 0 | 0 |
| QQQ | NO* | 367 | 5 | 139 | 590 | 210 | 0 |
| GLD | not scanned (core anchor) | 366 | 5 | 105 | 466 | 169 | 0 |

\* "Admitted: NO" reflects each symbol's *most recent* discovery-cycle verdict, which fluctuates
cycle to cycle with real-time price/volume/ADV — it does not contradict the earlier same-day finding
that these symbols *were* admitted at other points; discovery is a continuously-rescanned process,
not a one-time decision.

**AMZN and AVGO — which earlier tonight showed zero subscribe attempts at all — now show real
subscribe requests and real IBKR rejections**, in the hours since the fix was deployed and observed.
This is incidental (end-of-day, market-closed) confirmation that the `BROAD_UNIVERSE_TOPUP` fix is
genuinely reaching the subscription layer for exactly the symbol class it was built for, and that the
remaining blocker for them is the same IBKR entitlement wall AAPL/AMD already hit — not a residual
code gap. This is evidence, not a substitute for tomorrow's live-market observation, and is reported
here as exactly that.

**Precise scope of what this confirms, stated deliberately:** this establishes that the
subscription-*planning*/top-up code path is functioning — admitted symbols now genuinely reach a
subscribe attempt. It does **not** establish that IBKR capacity or entitlement coverage is sufficient
for the broader ~192-symbol admitted universe once real trading-hours volume and cycle frequency are
in play. Those are two different, independent questions, and only the first one has evidence behind
it tonight. Only tomorrow's live funnel can answer the second.

Java column is worth a brief note: AAPL shows 36 `JavaCoreEnsemble`/`JavaFactorComposite`-class
predictions despite 0 real-time ticks (per Technical=0) — these are Java's own shadow-tracking
predictions (which run on delayed/cached snapshot data independent of the IBKR streaming feed, per
earlier findings this session), not evidence AAPL reached the live real-time pipeline.

## 7–11. Not executed tonight — explicitly deferred to the live session

Trade-forcing prohibitions, the live trade lifecycle capture template, and the "first blocking
stage" classification all require real market hours and are not run here. They are ready to apply
the moment real data exists — the funnel script and this document's checklist are the preparation for
that, not a substitute for it.

## Final status (as of tonight, pending live confirmation)

**ENGINEERING READINESS: READY**
**PAPER-TRADING READINESS: READY**
**LIVE ALPHA VALIDATION: NOT ESTABLISHED** — unchanged, and cannot be established until real market
hours produce real agent evaluations against the repaired universe.
**REAL-MONEY READINESS: NO**

Production left exactly as instructed: running, untouched, paper-only, `LIVE_NO_GO`, PID 25936,
watchdog healthy, reconciliation clean, flat, zero open orders. No speculative change was made
tonight. The next real test is tomorrow's actual market open.
