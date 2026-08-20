# Superseded — Headless Architecture Audit (Phase 0 / B)

**Superseded by** [`ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md`](ARGUS_PHASE_D_ENGINE_DAEMON_FINAL_AUDIT.md).

Living operator/developer architecture: [`ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md`](ARGUS_HEADLESS_RUNTIME_ARCHITECTURE.md).

This snapshot described a pre-daemon baseline (`start-headless.ts` as a direct `server.ts` entry, Vite static import). Current entries: `scripts/argus-engine.ts`; headless scripts **delegate**. Vite is dynamically imported when `isWebUiEnabled()`.
