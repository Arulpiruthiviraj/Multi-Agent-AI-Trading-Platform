# Argus × OpenAlice Integration Audit

Investigation only — nothing in Argus was modified for this pass. OpenAlice was shallow-cloned
(`github.com/TraderAlice/OpenAlice`, commit `7253ad5`) and its actual source was read directly —
tool implementations, the MCP server, news/market data config, license — not just the README, per
the explicit instruction not to assume capability from marketing copy.

---

## 1. OpenAlice Capability Audit

| Capability | Available? | Evidence | Integration method |
|---|---|---|---|
| Programmatic/local API | **Yes** | `src/server/mcp.ts` — a real MCP server (`@modelcontextprotocol/sdk`), Streamable HTTP transport, on `http://127.0.0.1:47332/mcp` | MCP client from Argus |
| Headless operation | **Yes** | Real `Dockerfile` (multi-stage, non-Electron), `docker-compose.yml`, `packages/cli/bin/openalice.mjs` — no browser required for the MCP/tool layer | Run as a background service |
| CLI invocation | **Yes** | `openalice.mjs` CLI entrypoint (`remote:ssh` script uses it); workspace-local `alice*`/`traderhub` CLI shims proxy the same tool catalog over HTTP (`registerCliRoutes` in `mcp.ts`) | Shell out, or use the HTTP gateway directly |
| Structured JSON results | **Yes** | Every tool is a Vercel-AI-SDK `tool({ inputSchema: z.object(...), execute })`; MCP wraps `execute`'s return value directly (`wrapToolExecute`) — real typed objects, not free text | Parse the MCP tool-call response body |
| Submit an async research task | **Yes, but not a single call** | Issues are files (`.alice/issues/<id>.md`) created via `createIssue`/`issue_*` tools; an agent session (not a tool call) does the actual work; results land in the Inbox (`inbox_push`/`inbox_read`) | Create issue → poll Inbox — see §7 latency |
| Independent market data | **Partial** | Primary vendor is **yfinance** (`src/tool/market-vendors.ts`) — different from Argus's Alpaca. Real, structurally independent for price data. | N/A |
| Independent news | **Partial, with real overlap** | `src/domain/news/config.ts` config lists 15+ RSS feeds. **3 are byte-identical to Argus's own** `NewsProviderManager.ts` feeds: `feeds.a.dj.com/rss/RSSMarketsMain.xml` (WSJ), `finance.yahoo.com/news/rssindex` (Yahoo), and the same CNBC `id=100003114` topic feed. The other ~12 (Fed, ECB, FT, Economist, NYT Business/Economy, SeekingAlpha, crypto-specific, Asia-focused) are real incremental sources Argus doesn't have. | N/A |
| Independent technical/fundamental analysis | **Yes, mechanically** | `src/tool/analysis.ts`, `quant.ts`, `equity.ts`, `etf.ts`, `sector-rotation.ts` — real deterministic calculations over the yfinance vendor data, separate codebase from Argus's `RSIEngine`/`MACDEngine` | N/A |
| Model-independent from Argus | **Architecturally yes, not by default** | OpenAlice does **not** run its own fixed LLM. It delegates the actual reasoning to whichever native coding-agent CLI a workspace is configured with (`src/workspaces/adapters/{claude,codex,opencode,pi,shell}.ts`) — README confirms: "OpenAlice does not replace Claude Code, Codex, opencode, Pi... it gives them a trading-shaped place to work." Independence depends entirely on *which* CLI/model you point a given workspace at | Deliberately pick a model Argus's own `AIRouter` isn't concurrently using |
| Runs Claude/Codex/opencode/Pi without a separate API implementation | **Yes** | Confirmed by the adapter files above — these wrap the *native* CLI (its own login/session), not a raw HTTP call OpenAlice reimplements | N/A |
| "Trading as Git" safely ignorable | **Yes, structurally, if configured for it** | `allowAiTrading: () => boolean = () => false` (`src/tool/trading.ts:210`) is a real master switch, default `false` (stage + require human approval in the Web UI). More importantly: if the OpenAlice instance Argus talks to has **zero UTA/broker accounts registered** (`listUTAs` returns empty), every trading tool is structurally inert regardless of what's called — see §9 | Run a research-only OpenAlice instance with no broker credentials configured at all |

---

## 2. Argus Integration Architecture (recommended)

```
                         ┌─────────────────────────┐
                         │      MARKET DATA         │
                         │   (Alpaca WS - Argus)    │
                         └────────────┬────────────┘
                                      │
              ┌──────────────────────┼──────────────────────┐
              │                      │                      │
     Technical/News/Fundamental/Macro/Kronos agents (Argus, unchanged)
              │                      │                      │
              └──────────────────────┼──────────────────────┘
                                      ▼
                         ┌─────────────────────────┐
                         │   EvidenceAggregator     │  (Argus, unchanged)
                         └────────────┬────────────┘
                                      ▼
                         ┌─────────────────────────┐
                         │     ChiefTraderAgent     │  (Argus, unchanged)
                         └────────────┬────────────┘
                                      ▼
                         ┌─────────────────────────┐
                         │     EscalationPolicy     │  (Argus - extend the real one
                         │  (confidence/disagreement)│   already built for FinBERT)
                         └────────────┬────────────┘
                          escalate?  │  no → skip straight to RiskEngine
                              yes    ▼
                         ┌─────────────────────────┐
                         │ OpenAliceVerificationAdapter │  (NEW, Argus-side, read-only)
                         │  ExternalVerificationProvider │
                         └────────────┬────────────┘
                                      │  MCP call (research tools only -
                                      │  never trading.ts/trading-compact.ts)
                                      ▼
                         ┌─────────────────────────┐
                         │   OpenAlice (separate     │  own process, own workspace,
                         │   process, loopback MCP)  │  ZERO broker/UTA accounts
                         └────────────┬────────────┘
                                      │  VerificationResult (BUY/SELL/HOLD,
                                      │  confidence, thesis, sources)
                                      ▼
                         ┌─────────────────────────┐
                         │  ESCALATION_DECISION-style│  logged with provenance
                         │  real event on EventBus   │  (model/data-source hash,
                         └────────────┬────────────┘   see §6 provenance model)
                                      ▼
                         ┌─────────────────────────┐
                         │       RiskEngine          │  (Argus, unchanged, still
                         │  (still the sole gate)     │   authoritative - see §Risk)
                         └────────────┬────────────┘
                                      ▼
                              OrderManagementService → BrokerManager → Alpaca
```

`OpenAlice` never touches `BrokerManager`, never receives Alpaca credentials, and never has an
edge into `OrderManagementService`. It sits entirely upstream of `RiskEngine`, contributing one more
piece of *evidence* that `RiskEngine` can still override.

---

## 3. Recommended Integration Pattern: **Escalation-only (Architecture C), never Parallel or Post-consensus-blocking**

**Not Parallel (A).** Given the real latency finding in §7 — genuine independent research from OpenAlice
is an asynchronous agent-driven workflow, not a sub-second tool call — running it on *every* tick alongside
TechnicalAgent/NewsAgent/etc. would either block the live pipeline for tens of seconds to minutes per
decision, or require Argus to poll an Inbox for every single trade idea. Neither fits the existing
event-driven, mostly-synchronous consensus loop.

**Not unconditional Post-consensus (B).** Same latency problem, just moved one stage later — every
`CHIEF_APPROVED_IDEA` would stall waiting on an external agent session.

**Escalation-only (C), triggered by real existing Argus signals** is the only pattern compatible with
both the latency reality and the "no human in the loop" requirement:

- ChiefTrader confidence in the ambiguous band (Argus's real threshold is 0.75 for auto-approval; a
  natural additional band would be e.g. 0.75–0.85 — "approved, but not by a wide margin")
- Real agent disagreement already visible in `EvidenceAggregator`'s `disagreements` array
- A real high-impact-news-veto-adjacent event (Argus already has this signal — `RiskEngine`'s
  news-cluster check)
- Proposed position size crossing a real dollar/percentage threshold

**Adversarial mode (D) should be the *query mode*, not a separate architecture.** When escalation
fires, send OpenAlice a `BLIND_RESEARCH` request (symbol + horizon only — never "does this look like a
BUY to you") so its independent conclusion isn't anchored on Argus's own. This is cheap to do (it's a
field on the same request) and directly avoids the confirmation-bias risk the user flagged.

Because a real OpenAlice research task is not fast, escalation must be **non-blocking**: Argus's
existing pipeline continues (RiskEngine still evaluates and can still execute on Argus's own evidence),
and the OpenAlice verdict — when it eventually arrives — is logged as additional evidence and used to
adjust *future* confidence/weighting, not to gate *this* specific already-in-flight decision. Treating
it as a real-time blocking gate would be architecturally dishonest given the actual latency profile.

---

## 4. API / Adapter Design (proposed, not implemented)

```typescript
// Argus-side only. Never call anything from src/tool/trading*.ts on the OpenAlice side.
interface ExternalVerificationProvider {
  verifyTrade(request: VerificationRequest): Promise<VerificationResult>;
  healthCheck(): Promise<VerificationHealth>;
}

interface VerificationRequest {
  traceId: string;
  symbol: string;
  mode: 'BLIND_RESEARCH' | 'TRADE_VERIFICATION' | 'ADVERSARIAL_REVIEW';
  horizon: string;
  timeoutMs: number;
  // Minimum-context only - see §9. Never the full portfolio/strategy/credentials.
}

interface VerificationResult {
  provider: 'openalice';
  status: 'APPROVE' | 'REJECT' | 'HOLD' | 'UNAVAILABLE' | 'INVALID';
  direction: 'BUY' | 'SELL' | 'HOLD';
  confidence: number;
  thesis?: string;
  supportingEvidence?: string[];
  contradictingEvidence?: string[];
  dataTimestamp?: string;
  model?: string;          // which CLI/model actually answered - real, not assumed
  dataSources?: string[];  // real vendor/feed ids used, for the provenance model in §6
  latencyMs: number;
  correlationId: string;
}
```

**Real constraint this design must respect, found during inspection**: OpenAlice does not expose a
single "research + verdict" tool. `verifyTrade()` cannot be a thin MCP-call wrapper — it must itself
implement the create-issue → wait-for-agent-session → read-Inbox sequence, or drive a workspace agent
session directly. That is real integration work, not a stub.

---

## 5. Failure-State Matrix

| OpenAlice state | Argus behavior |
|---|---|
| Healthy, responds in time | Log `OPENALICE_VERIFICATION_COMPLETED`, feed into evidence/weighting for future decisions |
| Timeout | `OPENALICE_VERIFICATION_TIMEOUT` — treat as `UNAVAILABLE`, continue on Argus's own evidence (fail-open for *this* trade, since OpenAlice is additive, not required — see policy states below) |
| Unavailable (connection refused / MCP down) | `OPENALICE_VERIFICATION_FAILED` — same fail-open; also mark OpenAlice `UNKNOWN` in a health check, same convention as every other "Warning: X unavailable" in this codebase (Kronos, local AI stack) |
| Malformed/invalid response | `OPENALICE_VERIFICATION_FAILED`, log the raw payload for inspection, do not attempt to coerce a verdict out of it |
| Stale `dataTimestamp` | Discard the result as if `UNAVAILABLE` - a stale independent opinion is worse than none |
| Agent session crashed mid-research | Same as timeout - the issue/session state is inspectable in OpenAlice's own workspace for later debugging, but Argus doesn't wait on recovery |
| Suspiciously repetitive / identical verdict across many symbols | Flag for human review in a log, do not auto-disable — this needs a real statistical baseline first (same principle as not letting the UI declare a "best model" from 12 predictions) |
| High confidence, disagrees with Argus | This is the *interesting* case, not a failure - log it distinctly (`OPENALICE_VERIFICATION_CONFLICT`) for later analysis, but do not let it retroactively veto an already-decided trade |

**Policy states**, matching the user's own framing:

- `OPENALICE_OPTIONAL` (recommended starting posture) — escalation fires opportunistically; any
  failure mode above simply means "no second opinion this time," never a block.
- `OPENALICE_REQUIRED` — only sensible after real paper-trading evidence shows OpenAlice's verdicts
  are worth waiting on; if adopted, failure/timeout should fail-closed (`HOLD`) for that specific trade,
  matching the user's explicit preference for fail-closed when verification is mandatory.

Given the real latency profile, `OPENALICE_REQUIRED` with fail-closed is not viable for anything faster
than daily-horizon strategies — see §7.

---

## 6. Independence Assessment

| Dimension | Score | Why |
|---|---|---|
| Data independence | **5/10** | Market data (yfinance vs. Alpaca) is genuinely independent. News has *confirmed, byte-identical* overlap on 3 major feeds (WSJ Markets, CNBC, Yahoo) — not a guess, verified against both repos' actual RSS URLs — offset by ~12 real feeds Argus doesn't have. Fundamentals: both ultimately depend on data-vendor coverage that wasn't independently traced further; treat as unverified, not assumed independent. |
| Model independence | **7/10, conditional** | Architecturally strong — OpenAlice delegates to whatever native coding-agent CLI a workspace runs, structurally decoupled from Argus's own `AIRouter`. But this is a *deployment choice*, not a guarantee: score drops to near 0 if the OpenAlice workspace happens to be configured against the same underlying model Argus is currently escalating to (e.g., both landing on the same Gemini key). Must be deliberately configured and periodically re-verified against whatever Argus's `AIRouter` is actually routing to *that week* (recall: 6 of 7 of Argus's own paid keys are currently dead, so Argus itself is mostly running local Ollama right now - configuring OpenAlice against a real paid model would currently maximize independence almost by default). |
| Reasoning independence | **6/10** | A full coding-agent session doing multi-step tool-calling research is genuinely different reasoning from Argus's single-shot agent prompts, not just "another interface to the same LLM call." But it's reasoning over data that materially overlaps with Argus's own (see data independence), so agreement between the two is partly circular by construction, not purely independent confirmation. |
| Execution independence | **10/10, if configured correctly** | Zero, if and only if the OpenAlice instance Argus talks to has no broker/UTA accounts registered at all. This is a real, structural guarantee (not a promise) — `listUTAs()` returning empty makes every trading tool inert regardless of what's called through the unauthenticated MCP surface. This is the one score in this table that's binary and enforceable, not a judgment call. |

---

## 7. Latency Assessment — the single most important finding

OpenAlice's individual data tools (`searchBars`, `calcIndicators`, `listMarketVendors`, news archive
queries) are fast, ordinary HTTP/tool calls — sub-second to a few seconds. **But that is not what
"ask OpenAlice for an independent verdict" actually is.** A real research verdict requires a coding-agent
session working through multiple tool calls and producing a synthesized conclusion, and that session's
lifecycle is the product's actual async design: create an issue → an agent picks it up (on its own
schedule or triggered by the app's internal Pump/scheduler, not by an external caller) → the agent
researches over real wall-clock time → a report lands in the Inbox. There is no single MCP tool that
collapses this into one fast call.

| Horizon | Viable? |
|---|---|
| Scalping / 1m | **No** — not remotely close |
| 5m | **No** |
| 15m | **No, borderline unrealistic** |
| 1h | **Maybe, if the escalation is non-blocking** (fire the request, let the verdict arrive whenever it arrives, use it for the *next* decision on that symbol rather than this one) |
| 4h | **Yes, non-blocking** |
| Daily | **Yes** — the only horizon where even a blocking wait is plausibly acceptable |

This finding alone rules out Architectures A and B (both assume the verdict is available before the
current decision needs to move forward) and is why §3 recommends escalation-only, non-blocking.

---

## 8. Cost Assessment

| Configuration | Additional AI workload |
|---|---|
| Argus only | Baseline (already measured this engagement: mostly $0 local Ollama, 6 of 7 paid keys currently dead) |
| Argus + OpenAlice on every trade | A full agent session (multiple tool calls, one coding-agent CLI invocation) per trade idea - given Argus's TechnicalAgent alone can fire on every qualifying tick, this would be a large, uncapped, per-symbol-recurring cost regardless of which model OpenAlice's workspace uses |
| Argus + OpenAlice on escalation only | Bounded by how often ChiefTrader's confidence lands in the ambiguous band or agents disagree - realistically a small fraction of ideas, consistent with the local-first/escalate-only philosophy already built into `EscalationPolicy.ts` this engagement |

Escalation-only is the only option consistent with the cost-minimization principle this whole engagement
has been built around.

---

## 9. Security Assessment

**What OpenAlice must never receive** (all real, concrete Argus internals, not abstractions):

- Alpaca/broker API keys or the encrypted rows in `broker_connections`
- Real position sizes, `portfolio` table contents, or account equity
- `RiskEngine`'s actual gate thresholds/parameters
- `ChiefTraderAgent`'s or `EvidenceAggregator`'s source code or internal weighting
- Any ability to write to Argus's own database

**Minimum-context request** (matches the `VerificationRequest` shape in §4): symbol, a time horizon
label, and the fact that a decision is being considered - never *what* Argus's own agents concluded
when using `BLIND_RESEARCH` mode, never portfolio state, never credentials.

**The concrete, real security finding from source inspection**: OpenAlice's MCP endpoint - the one
exposing this whole tool catalog, trading tools included - is **unauthenticated by design**;
`src/server/mcp.ts`'s own comment states its security model is "only local processes can reach it" and
explicitly does not add an auth layer. This means:

1. Argus and the OpenAlice instance it talks to should run on the **same host**, both bound to
   loopback - this is what the unauthenticated design assumes and requires.
2. In OpenAlice's own Docker deployment, the maintainers deliberately do **not** expose the MCP port
   (47332) outside the container (`docker-compose.yml`), only the web UI (47331) - so a naive
   "point Argus at a remote OpenAlice container" plan will not reach the MCP surface without
   either re-exposing that unauthenticated port (undoing a real security decision the maintainers
   made) or co-locating both processes in the same container/network namespace.
3. Given (1) and the unauthenticated flat tool catalog, the **structural** safety guarantee - not
   just a policy Argus's own client code promises to follow - is running the OpenAlice instance with
   zero broker/UTA accounts configured, as established in §1/§6.

**License note (real, not assumed)**: OpenAlice is **AGPL-3.0**. Calling its MCP API over HTTP as an
arms-length client - never importing its packages into Argus's own process, never modifying and
redistributing OpenAlice itself as a service - is the standard, well-established way projects consume
AGPL software without triggering its network-copyleft clause (the same pattern used for MongoDB
Community/Elasticsearch-under-SSPL-style services). This is an engineering read, not legal advice; if
Argus is ever intended to stay closed-source, confirm this with real counsel before integrating,
exactly as the Wealthsimple/SnapTrade ToS tension in `FINAL_ANALYSIS.md` was flagged rather than
resolved unilaterally.

---

## 10. Implementation Roadmap

**Status update (implemented in a later pass of this same engagement):** Phases 1-3 are real and
live-verified for graceful degradation (no real OpenAlice instance exists in this environment, so
the actual MCP round-trip is unverified - see below). Phase 4 is only partially real. Phases 5-7
remain deliberately not started, for the same reason cited below.

- **Phase 1 - Read-only OpenAlice verification. ✅ Implemented.**
  `src/server/integrations/openalice/{types,OpenAliceMcpClient,OpenAliceAdapter,prompt}.ts`. Real
  MCP client via `@modelcontextprotocol/sdk` (already a dependency, previously unused - no new
  dependency added). `OpenAliceAdapter.requestVerification()` calls `issue_create` with an explicit
  `id` (used later for inbox correlation) and `when: {kind:'at', at: <now>}` - confirmed against
  OpenAlice's real source (`src/tool/issue-tools.ts`) that without `when` set, the issue is inert
  and no agent ever picks it up. `pollForReports()` calls `inbox_read({self:true, limit:50})`,
  matches entries by `origin.issueId`, and parses a fenced ` ```json ` block out of the free-text
  report (`parseVerificationJson`). Zero UTA accounts / trading tools ever touched - only
  `issue_create` and `inbox_read` are called, both confirmed read/board-only.
  **Not live-verified against a real running OpenAlice instance** - unit-tested against a mocked
  MCP client instead (`OpenAliceAdapter.test.ts`).
- **Phase 2 - EventBus integration. ✅ Implemented.** `OPENALICE_VERIFICATION_REQUESTED` /
  `_COMPLETED` / `_TIMED_OUT`, registered in `EventStore.ts` alongside the other decision-lifecycle
  events so they're durably persisted to `event_traces` with the same envelope. New
  `openalice_verifications` table (migration `0008`) is the fuller, OpenAlice-specific record
  (request + result + latency), following the exact pattern `escalation_decisions` set earlier in
  this engagement.
- **Phase 3 - EscalationPolicy extension. ✅ Implemented.** `shouldTriggerOpenAliceVerification()`
  in `EscalationPolicy.ts` - triggers on confidence in the uncertain band `[0.75, 0.85]` (Chief's own
  approval floor is 0.75) or any recorded `EvidenceAggregator` disagreement. Wired into
  `ChiefTraderAgent.evaluateConsensus()` immediately after approval, strictly fire-and-forget
  (`OpenAliceVerificationService.requestVerification()` never awaited, never throws into the
  caller). `OpenAliceVerificationService` is a no-op when `OPENALICE_ENABLED` / `OPENALICE_MCP_URL`
  aren't both set - live-verified via a temporary diag route that `IntegrityValidator`'s new
  `openalice_reachable` check correctly reports `UNKNOWN` (not a fabricated PASS) in that state.
- **Phase 4 - Evidence integration. ⚠️ Partially implemented - real gap, not hidden.** Completed
  verifications are persisted (`openaliceVerifications`, queryable via
  `OpenAliceVerificationService.recentForSymbol()`) and broadcast as
  `OPENALICE_VERIFICATION_COMPLETED`. What is **not** built: nothing currently reads a past
  `openaliceVerifications` row back into `EvidenceAggregator` as a weighted `Evidence` entry for the
  *next* decision on that symbol, as originally scoped below. Today the result is durable and
  visible (DB + event) but otherwise inert for decision-making - the same "write-only" shape this
  repo already has for `learned_rules` (see CLAUDE.md's Reflection/Learning Loop section). Closing
  this gap needs a real design decision (how stale can a verdict be before it's ignored? does
  `ChiefTraderAgent` query synchronously - reintroducing a latency dependency - or does
  `OPENALICE_VERIFICATION_COMPLETED` update an in-memory cache `ChiefTraderAgent` checks on the next
  idea for that symbol?) that wasn't made casually here.
- **Phase 5 - Paper-trading evaluation.** Not started. Accumulate enough decisions with an attached
  OpenAlice verdict to compare agree/disagree outcomes - the same statistical-significance
  discipline `BacktestEngine` already enforces (don't declare a verdict "better" below ~20 samples).
- **Phase 6 - Statistical evaluation.** Not started. Only after Phase 5 has a real sample: does
  agreement/disagreement with OpenAlice correlate with real outcome quality, and under which market
  regime?
- **Phase 7 - Adaptive signal, only if Phase 6 shows real evidence.** Not started, explicitly not
  before then - this mirrors the exact discipline already applied to XGBoost this engagement
  (trained, evaluated, deliberately not wired in on an inconclusive result).

---

## Final Question

> Can OpenAlice realistically be integrated into Argus as a fully autonomous, optional, read-only AI
> verification gate that improves decision quality without introducing a human-in-the-loop, execution
> authority, excessive latency, duplicate evidence, or a new single point of failure?

**YES — but only with restrictions.**

- No human-in-the-loop: achievable. `allowAiTrading` and Trading-as-Git are OpenAlice's own concerns,
  irrelevant to Argus as long as Argus's adapter never calls a trading tool and the shared instance has
  no broker accounts registered.
- No execution authority: achievable, and can be made structural (zero UTA accounts), not just
  a promise - the strongest finding in this whole audit.
- Excessive latency: **not avoidable for the live intraday pipeline** - OpenAlice's real research
  capability is an asynchronous, minutes-scale agent workflow, not a fast API call. This is why the
  integration must be escalation-only and non-blocking, and why it's only really practical for
  ≥1h-horizon decisions.
- Duplicate evidence: partially avoidable. Market-data independence is real; news independence is
  only partial (confirmed 3-feed overlap); model/reasoning independence depends on deliberately
  configuring OpenAlice's workspace against a model Argus itself isn't concurrently using.
- New single point of failure: avoidable by construction, since every failure mode in §5 degrades to
  "continue on Argus's own evidence," never a required dependency, under the recommended
  `OPENALICE_OPTIONAL` policy.

The restriction that matters most: treat OpenAlice as a slow, partially-independent, escalation-only
second opinion that Argus logs and learns from over time - not as a real-time verification gate a live
trade can wait on. Attempting the latter (Architectures A or B in the user's own framing) would be
building against a latency profile the actual source code does not support.
