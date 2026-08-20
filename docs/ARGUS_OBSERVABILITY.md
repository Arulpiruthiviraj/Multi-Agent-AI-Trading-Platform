# ARGUS observability (opportunity overlay)

Decision reconstruction remains `getDecisionTrace(traceId)` (7 tables). See `docs/ARGUS_LOGGING_AND_OBSERVABILITY.md` and `CLAUDE.md` §4.

Overlay extras (not a second ledger):

- `WATCHLIST_SUBSCRIBE_REQUESTED` / `OPPORTUNITY_SCAN_COMPLETED`
- `IDEA_RATE_LIMITED` / `AI_RATE_LIMITED`
- In-memory candidates on `GET /api/v2/continuous-intelligence/status`
- Screener ideas use `generateTraceId(symbol)` like other agents

AAPL “why discovered” today: seed list membership, not a 5000-name scan.
