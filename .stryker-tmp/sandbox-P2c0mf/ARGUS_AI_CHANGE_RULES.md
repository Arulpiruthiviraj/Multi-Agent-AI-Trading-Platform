# ARGUS AI change rules

Any future AI agent (or human) modifying Argus **must**:

1. Read `ARGUS_ARCHITECTURE_CONTRACT.md` and `CLAUDE.md` first.
2. Inspect `src/server/architecture.protection.test.ts` and `src/server/research/phase21.invariants.test.ts`.
3. Preserve the execution spine: ideas → ChiefTrader → RiskEngine → PositionSizing → OMS → Broker.
4. Preserve fail-closed trading. Absence of data, AI, or consensus is NO_TRADE / HOLD / pause — not a fabricated fill.
5. Preserve `PAPER_TRADING_ONLY` and 5-layer LIVE arming. Do not arm LIVE to demonstrate a feature.
6. Preserve reconciliation safety: never auto-flatten, never auto-resume pause, never skip broker init before recon.
7. Preserve all 24 RiskEngine gates. Do not skip gates to increase fills.
8. Preserve consensus safety: `consensusApprovalThreshold` 0.75 and `minIndependentAgreeingAgents` 2. Do not manufacture agreement.
9. Add regression tests for any architectural or safety-adjacent change.
10. **Never bypass** an existing safety layer to increase trade count.

Discovery, scanners, Technical, Kronos, Quant, News, Fundamental, Macro, and UI **never** call `placeOrder` and **never** emit `CHIEF_APPROVED_IDEA`.

If a requested feature requires replacing or weakening a protected component: **stop** and document the conflict instead of implementing a shortcut. When in doubt, the rule is simple: never bypass a protected component for convenience.
