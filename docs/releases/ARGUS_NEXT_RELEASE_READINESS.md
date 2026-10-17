# Argus next PAPER release readiness — 2026-10-17

## Decision

**NO_GO for unattended or automatic PAPER activation from this audit.** This worktree is not deployed or runtime-verified. The focused disk safety corrections are tested, but broader certification categories remain NOT_RUN. Keep `LIVE_NO_GO`. Any supervised PAPER session still requires the repository's separate current operational checklist and operator supervision.

## Changes in this worktree

- Set `config/syntheticArtifacts.json`'s minimum free space to 26 GiB, aligned with `config/diskSafety.json`'s 15+8+3 GiB reserves.
- Removed the legacy environment override that could lower the simulator's disk floor.
- Added a 26 GiB preflight to the `marketOpen.ts` parent before spawning each isolated child, checking the volume that contains the simulator DB.
- Added bounded candidate attributes to `IDEA_RATE_LIMITED` events for future suppression analysis; the rate cap and protective-exit exemption are unchanged.
- Added config parity and override regression assertions. Disk guard, artifact lifecycle, and saturated EventBus lineage suites passed 16/16.

These changes do not touch trading decisions, thresholds, broker state, `.env`, live runtime, or order code. The simulator was not run and the fix is not deployed.

## Release sequence

1. Review the isolated `main` diff and commit to local `main` only after source review.
2. Run typecheck/build and the full relevant disk/simulator tests on a machine with sufficient headroom; run the market-open simulator only after measuring expected artifact growth and preserving the 26 GiB reserve.
3. Review the complete test manifest and unchanged consensus/Risk/OMS invariants.
4. Merge/push/deploy only under a separate release authorization; do not hot-reload into a running trading process.
5. If deployed, verify the running SHA and disk-guard/watchdog/reconciliation state independently. No auto-resume on disk recovery.

## Outstanding blockers

- Full source-build and full-suite results: NOT_RUN.
- Market-open historical replay and production-scale load: NOT_RUN.
- Mutation test outcomes: NOT_RUN.
- Authenticated IBKR historical order/fill reconciliation: NOT_VERIFIED.
- Full discovery-to-quant opportunity coverage for eight of ten Oct. 16 names: insufficient point-in-time data.
- Current runtime health and broker connectivity: NOT_VERIFIED by this isolated audit.
- Empirical trading edge: not established.
