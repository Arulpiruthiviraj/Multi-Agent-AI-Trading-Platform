# 29 — Knowledge transfer (condensed)

Paste this into another AI as starting context.

Argus is a single Node.js trading terminal (Express + Vite + ws + SQLite, port 3000 hardcoded). Live path: EventBus TRADE_IDEA_GENERATED → ChiefTrader (≥2 agents, 0.75 bar, optional LLM debate) → RiskEngine (18 gates, AI cannot skip) → OMS → BrokerManager.placeOrder → trades/fills. Default broker InternalPaper; Alpaca is the only unattended live adapter. LIVE real-money is **NO-GO**: no OOS edge, NewsAgent last pass 44.6%/242, walk-forward failed, last scored env had zero organic closed paper trades.

Do not rewrite the live path. Do not add a second kill switch. settings.budget is allocation not broker equity. Quant off unless QUANT_ENGINE_ENABLED=true. Five CORE strategies; 15 experimental per env; 760 taxonomy names are aliases. Stop sizing uses 5% assumption not ATR. Canadian routing blocked IIROC. GET /api/v1/signals bypasses RiskEngine — still present.

2026-08-15 software hardening (unit-tested): Alpaca/AI AbortController timeouts; OMS inbound fill ingest + orphan cancel or TRADING_PAUSED; recon pause actually blocks emergency_stop; backtest daily-loss/drawdown/consecutive-loss/rate-limit inequalities; strategy BT exits use live TP/trail on close; Arena RNG P&L widgets → AwaitingSignal. Still missing: AI in backtest, full 18-gate BT, /signals removal, Autobot-off tick gate, IBKR unattended, validated edge.

UI: 21 tabs, mixed real/mock. Observatory is the real trace. Login hooks still run. 44 SQLite tables. AIRouter providers: Gemini, OpenAI, DeepSeek, Nvidia, Ollama-compat. Extra env keys without classes. Local Chronos :8008, Ollama :11434. OpenAlice non-blocking. tsc currently fails OpenAliceVerificationService.

Paper: mechanically possible. High win rate: not a feature. Tests: vitest ≥128 files + 1 Playwright spec. Config: config/*.json fail-boot. Docs: docs/ARGUS.md, FINAL_ANALYSIS.md §32, this folder.

Engineer: EventBus/OMS/RiskEngine/SQLite/Vite. Quant: StrategyEngine + BacktestRiskParity ≠ live 18 gates. Trader: paper only; ignore fabricated tabs. AI engineer: AIRouter only; null invented numerics; debate does not size orders.
