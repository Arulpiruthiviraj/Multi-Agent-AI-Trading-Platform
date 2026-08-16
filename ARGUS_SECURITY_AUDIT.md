# ARGUS_SECURITY_AUDIT

Scope: this increment does not re-litigate Phase 20; it restates production blockers.

## Findings that remain binding

- `ENCRYPTION_SECRET` or `data/.encryption_key`; encrypt/decrypt fail-closed.
- Production must not boot unauthenticated (`AUTH_PASSWORD`).
- Do not log API keys/tokens.
- Research import forbids `eval`/`placeOrder` payload keys.
- LLM cannot `placeOrder`.
- Dev unauthenticated mutating APIs: loopback / token patterns (Phase 20); GET/`/ws` may still be open if auth unset — **do not expose that on the public internet**.

## Not claimed

Penetration test of a deployed host, broker OAuth token theft model, and WAF posture are **UNAVAILABLE** as certified PASS.

LIVE remains **NO-GO** independent of this file.
