/**
 * ==========================================================
 * Module: explainer catalog
 *
 * Hover copy for dashboard metrics. Three parts only:
 *   what — plain-English definition
 *   why  — why it matters in trading / quant
 *   how  — how Argus calculates or uses it (honest; no fabricated engines)
 * ==========================================================
 */

export interface ExplainerEntry {
  title: string;
  what: string;
  why: string;
  how: string;
}

export const EXPLAINER_CATALOG = {
  allocatedCapital: {
    title: 'Allocated Capital',
    what: 'The dollar slice of a broker account that Argus is allowed to commit. It is not the full account equity.',
    why: 'A trading system that treats broker cash as its budget can over-commit the rest of the account. Allocation is a hard authority ceiling.',
    how: 'This is `settings.budget` (Allocated Budget Limit). RiskEngine gate `argus_capital_allocation` blocks BUYs that would exceed remaining allocation after open positions and pending buys.',
  },
  portfolioValuation: {
    title: 'Portfolio Valuation',
    what: 'Mark-to-market value of cash plus open positions at the latest broker/live prices.',
    why: 'P&L, drawdown, and position size all depend on current value, not what you paid.',
    how: 'Read from the active broker portfolio snapshot (equity / position market values). Missing prices show as unavailable — they are not invented.',
  },
  todaysPnl: {
    title: "Today's P/L",
    what: 'Profit or loss attributed to the current America/New_York trading session.',
    why: 'Intraday P&L is what daily-loss kill-switches and session reviews actually watch.',
    how: 'Argus tracks session P&L against day-start equity for the daily-loss gate. The dashboard figure is the live session delta from broker/equity state, not a simulated number.',
  },
  totalEquity: {
    title: 'Total Equity',
    what: 'Broker-reported account equity: cash plus the market value of holdings.',
    why: 'Position sizing, concentration caps, and drawdown are measured against equity, not cash alone.',
    how: 'Hero ribbon uses the portfolio snapshot from the active broker (`total_equity`). Distinct from Argus allocated capital.',
  },
  cashBalance: {
    title: 'Cash Balance',
    what: 'Settled cash sitting at the broker, not yet tied up in positions.',
    why: 'You can have equity in stocks and still be unable to buy if cash/buying power is gone.',
    how: 'Broker `cash` from the same portfolio snapshot. Buying power can differ (margin). Argus still cannot spend more than remaining allocation.',
  },
  positionsValuation: {
    title: 'Positions Valuation',
    what: 'Market value of open stock (and other) holdings, excluding idle cash.',
    why: 'Shows how much of the book is at market risk versus sitting in cash.',
    how: 'Sum of position quantity × current/entry price from the broker portfolio snapshot.',
  },
  unrealizedPnl: {
    title: 'Unrealized P&L',
    what: 'Paper profit or loss on open positions: current price versus average entry, not yet locked in by a SELL.',
    why: 'Unrealized P&L can vanish. Risk and reflection treat closed (realized) trades differently from open marks.',
    how: 'Broker `unrealizedPnl` / snapshot `unrealized_pnl`. Realized P&L only appears after a filled SELL is booked in `trades`.',
  },
  portfolioHealthscore: {
    title: 'Portfolio Healthscore',
    what: 'A compact 0–100 style snapshot of whether the book is within configured risk bounds.',
    why: 'A single number is a dashboard hint, not a substitute for gate-by-gate RiskEngine results.',
    how: 'Taken from the portfolio snapshot `health_score` when the backend provides it. If missing, the ribbon shows that it is unavailable rather than fabricating a score.',
  },
  sqliteWal: {
    title: 'SQLite WAL Mode',
    what: 'Write-Ahead Logging: SQLite writes new changes to a `-wal` file so readers are not blocked by writers.',
    why: 'The live loop (ticks, trades, traces) writes constantly. WAL keeps the UI and agents from stalling on every insert.',
    how: 'Boot sets `PRAGMA journal_mode = WAL` in `src/server/db/index.ts`. DB export checkpoints WAL first so the downloaded file includes recent commits.',
  },
  riskEngineGates: {
    title: 'Risk Engine Gates',
    what: 'An ordered checklist every Chief-approved idea must pass before OrderManagement may place an order.',
    why: 'LLMs do not get to skip math. One failed gate blocks the order; all gates are still recorded for audit.',
    how: 'RiskEngine.evaluateRisk records emergency stop, daily loss, consecutive loss, portfolio drawdown, order rate, market hours, data freshness, news veto, price validity, sizing/concentration, sell-position-exists, Argus allocation, and daily buy notional. First failure is the reported reason.',
  },
  maxDrawdown: {
    title: 'Max Drawdown',
    what: 'The worst peak-to-trough drop in equity over a period, usually as a percent.',
    why: 'Two strategies with the same return can feel completely different if one had a 40% hole.',
    how: 'Live trading uses settings `maxPortfolioDrawdownPct` (default 15% from peak) as a RiskEngine gate. Backtest widgets that still show canned percents are simulation UI, not live book drawdown.',
  },
  sharpeRatio: {
    title: 'Sharpe Ratio',
    what: 'Average excess return per unit of volatility — a rough “was the ride worth the bumpiness?” score.',
    why: 'High returns with violent swings often have a mediocre Sharpe; allocators care about that.',
    how: 'Agent performance stats expose a Sharpe-like field from scored predictions where enough real outcomes exist. Thin samples are not treated as a live trading signal.',
  },
  winRate: {
    title: 'Win Rate',
    what: 'Share of closed trades (or scored predictions) that were profitable.',
    why: 'Win rate without payoff size is misleading — many 60% systems still lose money.',
    how: 'ReflectionEngine / `agent_performance_stats` update from real scored outcomes. Paper-validation reports refuse to treat win rate as meaningful below a closed-trade floor.',
  },
  brokerEquity: {
    title: 'Broker Equity',
    what: 'What the broker thinks the whole account is worth.',
    why: 'Useful for sanity checks; it is not Argus’s spending limit.',
    how: 'GET `/api/v2/orchestration/capital` reads the active broker. RiskEngine still sizes against Argus remaining allocation.',
  },
  buyingPower: {
    title: 'Buying Power',
    what: 'How much the broker will let you deploy right now (cash plus any margin).',
    why: 'Orders can fail at the broker even when Argus allocation remains.',
    how: 'Broker `buyingPower` from the live portfolio call. Sufficient-size and allocation gates both have to pass.',
  },
  argusAllocation: {
    title: 'Argus Allocation',
    what: 'How much of `settings.budget` is already used versus still free for new BUYs.',
    why: 'Stops Argus from treating a $100k broker account as a $100k bot when you only allocated $10k.',
    how: 'CapitalAllocation snapshot: used = open BUY exposure + pending BUY notionals; remaining = allocated − used. Gate `argus_capital_allocation`.',
  },
  dailyBuyNotional: {
    title: 'Daily Buy Notional',
    what: 'Cumulative dollars of BUY orders (filled or still open) on the current NY session.',
    why: 'A daily-loss kill-switch only fires after you are already losing. A buy-notional cap limits how much you can put to work in one day.',
    how: 'RiskEngine gate `daily_buy_notional`. Paper uses reviewed `maxDailyBuyNotionalDollars`. LIVE always applies `restrictedLiveMaxDailyBuyNotionalDollars`.',
  },
  paperVsLive: {
    title: 'Paper vs LIVE',
    what: 'Paper simulates fills on a paper/internal broker. LIVE sends orders that can commit real capital.',
    why: 'Mode mistakes are the most expensive UI errors in a trading terminal.',
    how: 'TradingEngine `tradingMode`. LIVE adds file-reviewed restricted-live ceilings. This environment’s readiness docs still mark LIVE as NO-GO until validation exists.',
  },
  consensusThreshold: {
    title: 'Consensus Threshold',
    what: 'The weighted-confidence bar ChiefTrader requires before emitting a CHIEF_APPROVED_IDEA.',
    why: 'A single loud agent is not a trade. Independent agreement plus a confidence floor is the point of the debate.',
    how: '`tradingSafety.consensusApprovalThreshold` (JSON, not a UI knob) plus a minimum number of independent agreeing agents. HOLD from debate or BearResearcher can still veto.',
  },
  headerApiStatus: {
    title: 'API status chip',
    what: 'A header lamp that the Argus HTTP process is serving this UI.',
    why: 'If the SPA is on screen, the API that rendered it is up. It is not a probe of Alpaca, IBKR, or news vendors.',
    how: 'Static ACTIVE while this session is loaded. Real feed/broker health is on Diagnostics (MarketDataWorker, BrokerManager).',
  },
  headerLlmStatus: {
    title: 'LLM chip',
    what: 'A header label for the language-model layer agents use through AIRouter.',
    why: 'The debate path can fail over across providers; a single name in the header is not a live latency probe.',
    how: 'This chip currently prints GEMINI as a display label. Actual calls go through AIRouter (`/api/v1/config/routing`). Local Ollama is $0 when that route is selected.',
  },
  headerMarketSession: {
    title: 'Market session chip',
    what: 'Intended to show whether the US regular session is open.',
    why: 'RiskEngine market_hours blocks new entries when Alpaca /v2/clock is closed or the clock request fails (fail-closed).',
    how: 'This header chip is a static CLOSED label today — not the Alpaca clock. Use Diagnostics MD-006 / RiskEngine for the live session.',
  },
  headerSearch: {
    title: 'Search',
    what: 'Opens the in-app command palette to jump to symbols, tabs, and settings.',
    why: 'The terminal has many desks; search is navigation, not an order ticket.',
    how: 'Shortcut Cmd/Ctrl+K. Does not place trades or change RiskEngine.',
  },
  headerCoach: {
    title: 'AI Coach',
    what: 'Side panel that explains recent Argus behavior in plain language.',
    why: 'Operators should be able to ask “why” without reading EventBus traces first.',
    how: 'Opens the Coach panel. It does not approve orders and cannot bypass RiskEngine.',
  },
  headerAlerts: {
    title: 'Price alerts',
    what: 'Local price-threshold notifications you configure in this browser.',
    why: 'A reminder is not a RiskEngine gate and not an order.',
    how: 'Opens the Custom Alerts modal. History is stored in localStorage, not the trades table.',
  },
  headerExport: {
    title: 'Export',
    what: 'Download diagnostics / memory-oriented logs from this session.',
    why: 'Incident review needs artifacts, not screenshots of the ribbon.',
    how: 'Opens the export modal. Does not change trading state.',
  },
  ribbonNominal: {
    title: 'Nominal badge',
    what: 'A green label next to Portfolio Healthscore when a score is present.',
    why: 'It is a ribbon hint, not a passed RiskEngine evaluation.',
    how: 'Shown whenever `health_score` exists on the portfolio snapshot. Gate-by-gate results live in risk_assessments.',
  },
  ribbonRiskRules: {
    title: 'Active risk rules strip',
    what: 'A compact caption of drawdown / sector / size language on the tab bar.',
    why: 'Operators glance here, but live ceilings are settings + tradingSafety.json + RestrictedLiveMode.',
    how: 'This strip is static UI copy (including Size $100). Live max trade size is `settings.maxTradeSize`; drawdown is `maxPortfolioDrawdownPct`.',
  },
  tabDashboard: {
    title: 'Autonomous Dashboard',
    what: 'Overview of Autobot status, allocation, session P&L, and subsystem lamps.',
    why: 'This is the “is the engine on and what is the book doing?” desk.',
    how: 'Reads broker snapshot, Autobot config, and integrity checks. Enabling Autobot is Mission Control, not this tab.',
  },
  tabCommand: {
    title: 'Mission Control',
    what: 'Start/stop Autobot, budget, strategy focus, and the Guardrails panel.',
    why: 'This is the operator desk for the live EventBus path — not the legacy /signals simulation.',
    how: 'POST `/autobot/toggle` and settings. Kill switch is emergency-stop / TRADING_PAUSED (one switch, not a second).',
  },
  tabPortfolio: {
    title: 'Holdings & Positions',
    what: 'Open positions and cash from the active broker.',
    why: 'You cannot size or flatten what you cannot see.',
    how: 'Broker portfolio snapshot. Flatten/liquidate still goes through Chief-approved SELL ideas and RiskEngine — not a raw closePosition bypass.',
  },
  tabArena: {
    title: 'Trading Arena',
    what: 'Visualizer desk for correlation-style views and trade ledgers.',
    why: 'Some widgets here are live; others are educational. Hover labels call out which.',
    how: 'Do not treat every chart as a live accuracy feed. FINAL_ANALYSIS.md is the honesty matrix for fabricated vs real.',
  },
  tabNews: {
    title: 'News Intel',
    what: 'Headlines and clusters from RSS plus any configured paid news APIs.',
    why: 'NewsAgent evidence and the news_veto gate (high-impact clusters, direction-blind, 4h window).',
    how: 'NewsEngine ingest into `news_articles` / `news_clusters`. Empty match is not an outage.',
  },
  tabOpportunities: {
    title: 'Opportunity Feed',
    what: 'Candidate symbols / ideas the UI lists for review.',
    why: 'A listed opportunity is not a Chief-approved order.',
    how: 'Must still pass ChiefTrader consensus and every RiskEngine gate before OMS.',
  },
  tabScanner: {
    title: 'Strategy Scanner',
    what: 'Quant strategy scanner UI (QuantSignalsPanel) over real daily bars.',
    why: 'Quant is additive evidence. It is off unless QUANT_ENGINE_ENABLED=true.',
    how: 'QuantSignalAgent only participates when that flag is on. SMC live evaluateAll needs QUANT_SMC_STRATEGY_ENABLED.',
  },
  tabIntelligence: {
    title: 'Intelligence',
    what: 'Macro / research-style workspace.',
    why: 'Qualitative notes are not prices or EV.',
    how: 'Bull/Bear research (if enabled) is interpretive. LLM-invented numbers are rejected.',
  },
  tabAgents: {
    title: 'Agent Network',
    what: 'Map of agents and how they relate on the EventBus path.',
    why: 'Digital Twin glow is from real WebSocket events only; looping theater scenes are architecture, not ticks.',
    how: 'Weights for ChiefTrader come from agent_performance_stats (defaults in config/agentWeights.json). Unused agents do not vote.',
  },
  tabEvaluation: {
    title: 'Agent Evaluation',
    what: 'Scored prediction / win-rate style evaluation of agents.',
    why: 'Thin samples are not a license to trade harder.',
    how: 'Backed by agent_performance_stats / learning-summary. Alerts use configured min-prediction floors.',
  },
  tabKronos: {
    title: 'Kronos Model',
    what: 'Local Chronos time-series forecast service status and dashboard.',
    why: 'Optional evidence. Kronos down does not by itself block RiskEngine.',
    how: 'GET LOCAL_AI_SERVICE_URL/health (127.0.0.1:8008). npm run dev starts the Python service unless ARGUS_SKIP_CHRONOS.',
  },
  tabLearning: {
    title: 'Learning & Evolution',
    what: 'Backtests, daily P&L, trade journal, and memory rules from Reflection.',
    why: 'Learned rule text is injected into ChiefTrader debate prompts, not into RiskEngine math.',
    how: 'learned_rules / memoryRules. Walk-forward and strategy backtests are separate from the live path.',
  },
  tabMemory: {
    title: 'Vec Event Memory',
    what: 'Semantic search over stored market/news event memory.',
    why: 'Precedent search is research, not an order.',
    how: 'Queries persisted event/news memory. Missing hits are empty results, not fabricated precedents.',
  },
  tabObservatory: {
    title: 'Observatory',
    what: 'Transaction-centric view of what actually happened on a trade.',
    why: 'This is the honest “why did we trade / not trade” desk.',
    how: 'Assembles consensus, risk_assessments, gates, and fills from SQLite. Missing fields were never written.',
  },
  tabActivity: {
    title: 'Activity Log',
    what: 'Chronological log of system/agent activity for this process.',
    why: 'Useful for debugging loops; not a substitute for event_traces.',
    how: 'UI log stream. Durable decision lifecycle is event_traces / Observatory.',
  },
  tabDiagnostics: {
    title: 'Diagnostics',
    what: 'Live probes: why not trading, capital vs broker, optional models.',
    why: 'This page never bypasses RiskEngine. Optional Chronos/Ollama/OpenAlice can be FAILED without blocking gates by themselves.',
    how: 'GET /api/v2/diagnostics. Retry reconnects MarketDataWorker or re-probes models.',
  },
  tabAudit: {
    title: 'Observability & Tracing',
    what: 'Event traces and pipeline observability (not a fake distributed-tracing product).',
    why: 'Audit what ChiefTrader / RiskEngine / OMS actually emitted.',
    how: 'event_traces and related tables. High-frequency ticks are not all durably stored.',
  },
  tabValidation: {
    title: 'Validation',
    what: 'Paper / walk-forward / readiness style checks.',
    why: 'LIVE remains NO-GO until validation exists. Adding UI does not raise readiness scores.',
    how: 'Reports and checks from this environment. Do not treat a green widget as LIVE authorization.',
  },
  tabDeployment: {
    title: 'Deployment',
    what: 'How this Node process is run (dev vs bundled server).',
    why: 'Companions (Chronos, Ollama, OpenAlice, IBKR Gateway) start from `npm run dev`, not `dev:server-only`.',
    how: 'Operational runbook. PORT is hardcoded 3000 in server.ts.',
  },
  tabSettings: {
    title: 'Settings & Keys',
    what: 'Budget, risk knobs, broker selection, and encrypted API keys.',
    why: 'Allocation and keys are how the live path is allowed to talk to brokers and models.',
    how: 'settings row + encrypted brokerConnections. LIVE still needs the confirmation phrase. No second kill switch here.',
  },
  tabDocumentation: {
    title: 'Documentation',
    what: 'In-app academy: live path, gates, what is real vs fabricated.',
    why: 'Stops the UI from being mistaken for a second trading engine.',
    how: 'Loads reviewed config JSON for thresholds. Not an order surface.',
  },
  engineRunBadge: {
    title: 'Engine run state',
    what: 'Whether Autobot is enabled (Running Live) or idle (Engine Paused).',
    why: 'Ideas on the EventBus path are not generated by Autobot when it is off.',
    how: 'Derived from autoBotEnabled and tradingState !== EMERGENCY_STOP. Kill switch is still RiskEngine emergency_stop.',
  },
  operationMode: {
    title: 'Operation mode',
    what: 'Paper vs LIVE vs simulator as stored on TradingEngine.',
    why: 'LIVE can commit real capital; paper must not be confused with it.',
    how: 'autoBotConfig.tradingMode. LIVE adds restricted-live ceilings. Readiness docs still mark LIVE NO-GO here.',
  },
  handsOffMode: {
    title: 'Hands-off mode',
    what: 'A local dashboard toggle for “don’t nag me” UX.',
    why: 'It looks like a safety switch; it is not.',
    how: 'React useState only. It does not pause TradingEngine, flatten, or skip RiskEngine.',
  },
  realizedPerformance: {
    title: 'Performance curve',
    what: 'Equity / session points plotted when the analytics endpoint has real rows.',
    why: 'An empty chart means no history yet — not a zeroed fake line.',
    how: 'Fetched performance series. “Awaiting Data” is honest empty, not $0 fabricated.',
  },
  newsEngineStatus: {
    title: 'News Engine lamp',
    what: 'Whether a news provider is configured according to integrity checks.',
    why: 'Unconfigured paid APIs degrade NewsAgent; RSS may still run.',
    how: 'Integrity check `news_provider_configured`. Online here is configuration, not “headlines are always fresh”.',
  },
  aiRouterGateway: {
    title: 'AI Router Gateway',
    what: 'Which LLM provider name Autobot config currently points at.',
    why: 'All LLM calls must go through AIRouter (failover, cost, health).',
    how: 'autoBotConfig.selectedAiProvider display. Health/failover is AIRouter, not this string alone.',
  },
  dailyLossLimitMetric: {
    title: 'Maximum daily loss',
    what: 'Session loss cap used by the daily-loss kill-switch.',
    why: 'Stops the bot from digging after a bad day. It is not a cumulative buy-notional cap.',
    how: 'settings.dailyLossLimit. RiskEngine daily_loss uses a fraction of this (`dailyLossKillSwitchFraction` in tradingSafety.json).',
  },
  maxTradeSizeMetric: {
    title: 'Max single trade size',
    what: 'Default FIXED_DOLLAR cap per order (settings.maxTradeSize).',
    why: 'Often binds before the 20% symbol concentration cap on large accounts.',
    how: 'PositionSizing.ts. Stop-per-share assumption is tradingSafety.stopLossAssumptionPct (not ATR). PERCENT_OF_EQUITY is opt-in.',
  },
  maxOpenPositionsMetric: {
    title: 'Max open positions',
    what: 'Cap on how many names can be open at once.',
    why: 'Concentration and operational risk, not a performance tweak.',
    how: 'settings.maxOpenPositions, plus RestrictedLiveMode’s lower cap when tradingMode is LIVE.',
  },
  emergencyBreaker: {
    title: 'Emergency circuit breaker',
    what: 'Whether tradingState is EMERGENCY_STOP.',
    why: 'This is the one kill switch. Do not add another.',
    how: 'TradingEngine.setTradingState. RiskEngine emergency_stop fails unless tradingState === TRADING_ENABLED.',
  },
  agentWinRateMetric: {
    title: 'Agent win rate',
    what: 'Share of scored/closed outcomes that were profitable, when enough samples exist.',
    why: 'Win rate without payoff size and sample size is not a go-live metric.',
    how: 'learning-summary / closed trades in `trades`. “Awaiting Trades” means none scored yet.',
  },
  learnedRulesMetric: {
    title: 'Learned rules',
    what: 'Count of reflection-extracted rules stored for debate context.',
    why: 'Memory is prompt context for ChiefTrader, not a RiskEngine override.',
    how: 'learned_rules / memoryRules. Truncated into the debate prompt per tradingSafety debateLearnedRule* caps.',
  },
  recentTradesList: {
    title: 'Recent executed trades',
    what: 'Latest rows from the real `trades` table (live path), not portfolio.json.',
    why: 'Legacy GET /api/v1/signals is quarantined (HTTP 410) and is not this list.',
    how: 'SQLite trades. Empty means no fills on the EventBus path yet.',
  },
  aiEngineOps: {
    title: 'AI engine operations',
    what: 'Which live-path agents are intended to run when Autobot is on.',
    why: 'Green lamps here follow Autobot enabled — they are not independent heartbeats per agent.',
    how: 'TechnicalAgent, NewsEngine, RiskEngine, and ChiefTrader are on the EventBus path. Unused agents (e.g. MarketRegimeAgent) do not vote.',
  },
  subsystemIntegrity: {
    title: 'Subsystem integrity',
    what: 'Compact lamps for news config, SQLite WAL, and RiskEngine.',
    why: 'A green lamp is not a passed order. Optional models have their own Diagnostics cards.',
    how: 'Integrity checks + static WAL mode. RiskEngine still evaluates every proposal.',
  },
  activeRiskLimits: {
    title: 'Active risk limits',
    what: 'The configured daily-loss, max trade size, open-position cap, and kill-switch state.',
    why: 'These are the numbers RiskEngine actually reads from settings — unlike the static tab-strip caption.',
    how: 'autoBotConfig / settings row. Restricted LIVE mode can tighten ceilings further; it is not a UI knob.',
  },
} as const satisfies Record<string, ExplainerEntry>;

export type ExplainerId = keyof typeof EXPLAINER_CATALOG;
