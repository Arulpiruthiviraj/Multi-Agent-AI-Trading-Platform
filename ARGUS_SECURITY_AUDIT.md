# ARGUS_SECURITY_AUDIT

## This increment

`enforceAuthConfigOrExit` no longer logs `ARGUS_DEV_TOKEN=...`. Token is still generated for loopback/header auth.

## Standing controls

- Production without `AUTH_PASSWORD`: fatal exit.
- Mutating `/api/v1` `/api/v2` require session or loopback+dev token.
- WS session when auth enabled.
- EncryptionService fail-closed.
- Override is an authenticated order **proposal**, still RiskEngine.
- Research cannot place orders.

## Residual

Unauthenticated **GET** if password unset. Bind localhost. No pentest **PASS**. LIVE independent **NO-GO**.
