# 21 — Security audit (read-only)

Findings, not remediations.

- API keys in `.env` and encrypted `broker_connections` / provider rows. `ENCRYPTION_SECRET` or `data/.encryption_key`.
- Auth on when `AUTH_PASSWORD` set; **no-auth when unset**; production boot refuses unauthenticated.
- Session secret required with password in real deploy.
- CORS: review `server.ts` — **UNKNOWN tightness** without re-quoting every origin line this pass.
- WebSocket: same origin/auth as HTTP — **verify** login gate; hooks still run on login screen (fetch leak risk if not gated).
- Logging: avoid printing secrets; scan writes `npm run security:scan-writes`.
- Prompt injection: news/LLM text into prompts — **PARTIAL** (parseResearchNote nulls numbers; RiskEngine still required).
- Chaos routes: exist — must not be exposed in production without auth.
- File import-db: restart required; treat as privileged.
- IBKR localhost Gateway TLS.
- No claim of pentest.

**P0 remaining:** `/signals` unauthenticated behavior depends on AUTH; still bypasses RiskEngine if reachable.
