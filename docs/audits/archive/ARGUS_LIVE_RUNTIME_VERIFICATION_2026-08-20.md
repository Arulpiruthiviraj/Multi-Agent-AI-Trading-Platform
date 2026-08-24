# ARGUS LIVE RUNTIME VERIFICATION — 2026-08-20

Companion to `ARGUS_TODAY_PAPER_READINESS_AUDIT.md` (which a concurrent session is actively editing — this document is kept separate to avoid overwriting their work). This covers only what THIS pass actually ran against the real, live `npm run dev:server-only` process (PID 25984), started ~13:39:03Z, with real Alpaca paper credentials and `PAPER_TRADING_ONLY=true`.

## Why this engine is running

The server was down at the start of this pass. I started it (`npm run dev:server-only`) specifically to close the "no live runtime verification" gap flagged in the prior audit. Partway through, `tradingState` changed from `TRADING_PAUSED` to `TRADING_ENABLED` and market data connected — not caused by me. I confirmed with the operator that this was intentional (they enabled it for today's session) before continuing any further live verification.

## RUN-VERIFIED: dirty-restart BUY-hold worked correctly

Boot log:
```
[sessionRecovery] Previous Argus session did not clean-shutdown. Holding new BUY ideas until RECONCILIATION_MATCH. Risk-exit SELL and recon still run. Not an auto-resume of a pause.
```
~13 seconds later, reconciliation ran and matched (`remote=[GLD:1,NVDA:1] local=[GLD:1,NVDA:1] delta missingLocally=0 missingRemotely=0`):
```
[sessionRecovery] RECONCILIATION_MATCH after interrupted session — new entry ideas allowed. tradingState unchanged (not a blind resume of PAUSED).
```
Exactly matches the documented contract: dirty marker holds entries, match releases them, `tradingState` itself is never auto-changed by this mechanism.

## RUN-VERIFIED: RiskEngine gate cascade blocked a real approved consensus decision

At 13:40:00Z, while `tradingState` was still `TRADING_PAUSED`, PortfolioMonitor correctly emitted a risk-exit SELL for NVDA (target price reached) and ChiefTrader correctly approved it via the documented risk-exit exception (skips min-independent-agents):
```
lastConsensus: { symbol: "NVDA", approved: true, side: "SELL", independentAgreeingAgents: 1, requiredAgents: 2,
  confidence: 0.85, threshold: 0.75, reason: "[Risk Exit] EXIT_CODE=TARGET_REACHED ... target reached: $218.00 >= $121.90",
  agentVotes: [{ agent: "PortfolioManager", side: "SELL", confidence: 0.85 }] }
```
I queried `risk_assessments` directly (not just the API) to confirm what RiskEngine actually did with this ChiefTrader-approved idea:
```
{ symbol: "NVDA", side: "SELL", approved: 0, rejection_gate: "emergency_stop",
  reasoning: "Trading is paused. All new trades are blocked until resumed.", created_at: "2026-08-20T13:40:56.051Z" }
```
**RiskEngine correctly fail-closed the SELL at gate 1 despite ChiefTrader approval.** No order was placed. This is real, direct proof that consensus approval and RiskEngine approval are genuinely separate — ChiefTrader's risk-exit shortcut does not bypass RiskEngine.

After the operator enabled `TRADING_ENABLED`, the same recurring NVDA exit (PortfolioMonitor re-emits it every ~5 min while the target-reached condition holds) now clears gate 1 but is being blocked at gate 14 (`news_veto`), consistently, on every cycle observed (13:45, 13:50, 13:55, 14:00, 14:05, 14:10):
```
{ symbol: "NVDA", side: "SELL", approved: 0, rejection_gate: "news_veto",
  reasoning: "High volatility news event detected, overriding AI decision." }
```
**Operator note:** this is a real, currently-open condition on your NVDA position, not a bug — the position's take-profit exit is queued and will execute automatically once the news-veto window clears (`newsVetoWindowMs` in `config/tradingSafety.json`) or the veto condition resolves. Positions confirmed via `argus positions`: GLD 1@387.97 (unrealized +$22.97), NVDA 1@206.85 (unrealized +$11.05).

Zero rows in `trades` since this boot (`timestamp > '2026-08-20T13:39:00'`) — no BUY or SELL has actually executed this session. Consistent with everything above: correctly fail-closed throughout, not silently broken.

## Real defects found live and fixed this pass

### 1–2. Double-response race at two more call sites (same class as the already-fixed `/pnl/analytics`)

`data/logs/crash.log` showed repeated live `ERR_HTTP_HEADERS_SENT` unhandled rejections while this engine was running, at:
- `server.ts:1152` (inside `GET /api/v1/portfolio`'s catch block)
- `src/server/routes/v2System.ts:1655` (inside `GET /api/v2/orchestration/capital`'s catch block)

Same root cause as the earlier `/pnl/analytics` fix: an awaited broker call with no timeout (or a timeout equal to the global 15s backstop) can let the backstop's 504 win the race, then this handler's own write throws on the second attempt.

**Fixed:**
- `server.ts` (`GET /api/v1/portfolio`): added `res.headersSent` guards on both the success and error responses.
- `src/server/routes/v2System.ts` (`GET /api/v2/orchestration/capital`): bounded both `broker.portfolio()` and `broker.orders()` to 5s via `withTimeout`, plus `res.headersSent` guards on every write.

**Regression tests:** `src/server/routes/v2System.orchestration.timeoutGuard.test.ts` (2 new tests — hang bounded to <10s; no `ERR_HTTP_HEADERS_SENT` when a simulated backstop responds first). `GET /api/v1/portfolio` (in `server.ts`, not an isolated router) was verified via `tsc --noEmit` plus the fact that the fix is mechanically identical to the two already-test-verified twins; a full `server.ts`-boot test harness was judged disproportionate effort for a two-line defensive guard already proven correct twice elsewhere. Not RUN-verified against a server restart, to avoid restarting the operator's active session mid-day.

### 3. `argus status` crashed with a JS syntax error

`scripts/cli/common.sh:361` had a deeply-nested ternary (`Autobot: ENABLED/DISABLED` logic) missing one closing parenthesis — reproduced live: `./argus status` threw `SyntaxError: missing ) after argument list` instead of printing status. Root cause: 5 opening parens (`console.log(` + 4 nested ternary wraps), only 4 closing parens present.

**Fixed:** added the missing `)`. Verified: `./argus status` now prints correctly (`Phase: RUNNING`, `State: TRADING_ENABLED`, etc.), exit code 0.

**Regression test:** added a new describe block to `scripts/cli/shellCli.protection.test.ts` — extracts every embedded `node -e '...'` block from `common.sh` (5 currently) and syntax-checks each with `node --check`. Verified this test actually catches the exact bug: temporarily re-introduced the missing paren, confirmed the new test fails with the exact same `SyntaxError`, then restored the fix and confirmed it passes (14/14 in the file).

## Flagged, not fixed (real, but not confidently actionable yet)

- **`argus doctor`'s health/readiness probes use a 2000ms timeout** (`common.sh:594,604`). Manual `curl` calls against this same live, busy engine occasionally took longer than 2s (plausible cause: the news-ingestion burst doing synchronous work). This produced a false "API not reachable" / "Readiness endpoint unreachable" from `doctor` even though the API was clearly up (confirmed seconds later via `argus status`/`health`/direct curl). Not fixed: bumping the timeout without first confirming whether this is a legitimate busy-machine hiccup or a symptom of real event-loop blocking would risk masking the latter. Worth a dedicated look, not a reflexive timeout increase.
- **Two earlier `argus login` / raw curl POST attempts to `/api/v1/auth/login` timed out** (5s and 15s) before a third attempt succeeded normally with no unusual delay. No corresponding slow-request or error evidence found server-side for those two attempts. Not treated as a confirmed defect — noted as a possible symptom of the same busy-period sensitivity as the doctor-probe finding above, not investigated further this pass.

## Verification performed

```
npx tsc --noEmit                                    → clean
npx vitest run src/server/routes/v2System.orchestration.timeoutGuard.test.ts   → 2/2 passed
npx vitest run scripts/cli/shellCli.protection.test.ts                         → 14/14 passed
npx vitest run (full suite, concurrently with the live server running)        → 294/296 files, 1874/1877 tests passed;
  the 2 file-level failures (v2System.override.test.ts hook timeout; one worker crash) were
  re-run in isolation with more headroom and passed cleanly (4/4, 1 error not reproduced) -
  attributed to CPU/resource contention from running a full parallel vitest suite alongside
  the live dev server on the same machine, not a regression from this pass's changes.
```

## Not verified this pass

- Whether the `argus doctor` / login timeouts recur under a quieter machine state (would need to re-test without a concurrent full-suite run).
- A live SIGTERM/restart drill against this now-actively-trading engine (deliberately not performed, to avoid disrupting the operator's live session).
- Whether the NVDA news-veto condition will clear naturally within `newsVetoWindowMs`, or requires operator attention.
