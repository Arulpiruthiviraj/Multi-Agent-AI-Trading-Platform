# Argus - CHANGELOG

Real change history. Previously this file was identical placeholder boilerplate shared with 7 other stub docs in this repository and contained no actual changelog entries — replaced with a real one, grounded in `git log` and the verified fixes/documentation corrections made during the 2026-08-08 audit pass.

No formal semantic-versioning releases have been tagged for this project — entries below are grouped by real commit and by audit/fix session instead.

---

## Unreleased — 2026-08-08 audit + fix pass

**Fixes applied to the live agent pipeline** (verified against source, not aspirational):
- Fixed the currentPrice propagation gap: `TechnicalAgent`/`PortfolioMonitor` now attach `currentPrice` to `TRADE_IDEA_GENERATED`; `ChiefTraderAgent` carries it through `CHIEF_APPROVED_IDEA`; `RiskAgent`/`RiskEngine` fall back to `MarketDataWorker`'s live price and refuse (rather than defaulting to a hardcoded `$150`) if none is available.
- Fixed a confidence-scale bug in `ChiefTraderAgent`'s multi-provider debate branch (was pushing `50`/`80` on a 0–100 scale into a 0–1-scale weighted-average pool, which could auto-approve almost any debated trade). Also fixed the same class of bug in `MacroAgent`/`FundamentalAgent`'s unnormalized LLM confidence.
- Fixed `RiskEngine`'s news-veto query, which previously checked `news_articles.impactScore` — a column that doesn't exist on that table — so it could never actually veto anything. Now correctly queries `news_clusters.impactScore`.
- Implemented real ATR-based position sizing in `RiskEngine`, backed by a new real 1-minute OHLC bar aggregator in `MarketDataWorker` (built from real Alpaca trade prints), with an honestly-flagged flat-5% fallback when insufficient bar history exists.
- Implemented real daily-loss, consecutive-loss, and 30% concentration circuit breakers in `RiskEngine`, computed from real `trades`/portfolio state rather than in-memory counters.
- Wired realized P&L capture in `OrderManagementService` (needed for the circuit breakers above) and a day-rollover `currentDailyLoss` mirror in `TradingEngine` for UI display.
- Replaced the session-auth mechanism's literal `"dummy_signature"` with real HMAC-SHA256 signing and verification, and added the previously-missing `/api/v1/auth/login`/`logout`/`status` endpoints (the password gate was previously unreachable — there was no way to ever set the session cookie).
- Fixed the WebSocket wildcard event-forwarding bug (`server.ts` assumed a single `{eventType, payload}` object; `EventBus`'s real wildcard signature is `(eventName, payload)`), which had been silently delivering malformed `{type: undefined, data: <string>}` messages to every connected client.
- Fixed `EncryptionService`: removed the silent "return plaintext on failure" fallback and the hardcoded default encryption key baked into the source; now generates and persists a real random key when `ENCRYPTION_SECRET` is unset. Removed an unused duplicate copy of this service.
- Added debate/idea-emission cooldowns (`ChiefTraderAgent`, `NewsEngine`) to bound AI cost amplification from rapid-fire duplicate ideas.
- Removed a duplicate, dead `/api/v1/system/export-db` route registration and fixed both DB export/import routes to point at the real `data/argus.db` path (they previously pointed at a nonexistent `database/argus.db` and always 404'd).
- Changed the default server port from `3000` to `5000` to match what every doc already claimed.
- Replaced 9 copy-pasted catch blocks across unrelated endpoints that were returning a hardcoded fake-news fallback object on error with real `{error: message}` responses.
- Changed `AIRouter`'s provider health/success-rate tracking from an ad hoc `+1`/`-5` drift counter to a proper exponential moving average of real outcomes.

**Full current-state audit performed** (32-section report): identified that Kronos cannot produce output under any configuration (dead trigger event + unconditional throw in inference), that 3 of 5 broker adapters are non-functional stubs, that `BrokerManager.initialize()` is never called from the server's own startup sequence, that AI cost tracking is fake across every provider, and that authentication is disabled by default. Full findings in [AI_CONTEXT.md](./AI_CONTEXT.md).

**Documentation corrected** (this pass): every `.md` file in the repository root was checked against source and corrected where it described fictional classes, nonexistent API routes, invented database columns, or aspirational feature status presented as fact. See the "Last audited" note at the bottom of each corrected file.

---

## Commit history (from `git log`, real hashes/messages — chronological, oldest first)

```
70e81e8  Initial commit
aeb1744  feat: initialize multi-agent trading platform
0601f7f  feat(notifications): add support for outbound webhooks
d1d5032  feat(server): integrate Alpaca WebSocket for live quotes
00362f4  feat(system): add mission control and scheduler
3864a0f  feat(trading): integrate Chief Trader Agent and Digital Twin
4329c3c  feat(ui): add AI coach and system validation suite
da520be  feat: integrate v2 backend and persistence layer
fff8ac5  feat(infra): implement real-time event WebSocket bridge
e6c2ff7  feat: implement core infrastructure and broker support
62b2c2e  feat(agents): implement AlphaVantage data integration
```

No commit dates were available at documentation-write time without running `git log` with an explicit date format — re-run `git log --format="%h %ad %s" --date=short` yourself if you need exact dates; don't trust a fabricated date here.

---

**See Also**:
- [AI_CONTEXT.md](./AI_CONTEXT.md) — master current-state reference
- [REMEDIATION_PLAN.md](./REMEDIATION_PLAN.md), [CODE_AUDIT_REPORT.md](./CODE_AUDIT_REPORT.md), [FINAL_ANALYSIS.md](./FINAL_ANALYSIS.md) — earlier point-in-time audit snapshots (dated, not living docs)
