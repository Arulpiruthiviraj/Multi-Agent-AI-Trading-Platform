/**
 * ==========================================================
 * Module:
 * schema.ts
 *
 * Purpose:
 * Core implementation and logic for the schema.ts module within the Argus Trading Terminal.
 *
 * Responsibilities:
 * - State management and logic execution for schema
 * - Interface with backend APIs and EventBus
 * - Render UI components (if React)
 *
 * Inputs:
 * - Module dependencies and injected props
 *
 * Outputs:
 * - Formatted data or React Elements
 *
 * Emits:
 * - Relevant system events
 *
 * Dependencies:
 * - Standard Argus architecture layers
 *
 * Called By:
 * - Argus Routing / Parent Components
 *
 * Never:
 * - Mutate global state directly without EventBus
 * - Call AI providers directly (Must use AIRouter)
 *
 * ==========================================================
 */

import { sqliteTable, text, integer, real, index, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  email: text('email').notNull(),
  passwordHash: text('password_hash'),
  createdAt: integer('created_at').default(Date.now())
});

export const sessions = sqliteTable('sessions', {
  sessionToken: text('session_token').primaryKey(),
  username: text('username').notNull(),
  expiresAt: integer('expires_at').notNull(),
  lastSeen: integer('last_seen').notNull(),
  createdAt: integer('created_at').default(Date.now()),
});

export const settings = sqliteTable('settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  tradingMode: text('trading_mode').notNull().default('Paper'),
  riskLevel: text('risk_level').notNull().default('Balanced'),
  selectedBroker: text('selected_broker'),
  selectedAiProvider: text('selected_ai_provider'),
  budget: real('budget').default(50000),
  strategy: text('strategy').default('Momentum Focus'),
  maxTradeSize: real('max_trade_size').default(3000),
  dailyLossLimit: real('daily_loss_limit').default(5000),
  takeProfitPct: real('take_profit_pct').default(15),
  trailingStopPct: real('trailing_stop_pct').default(5),
  minAiConfidence: real('min_ai_confidence').default(75),
  autoBotEnabled: integer('auto_bot_enabled', { mode: 'boolean' }).default(false),
  adversarialDebateMode: integer('adversarial_debate_mode', { mode: 'boolean' }).default(true),
  // Persists whether the Setup Wizard has ever been completed/skipped - the wizard previously
  // had no persistence at all (a plain useState(false) in App.tsx), so it force-reopened on
  // every single page load/reload regardless of prior completion.
  onboardingComplete: integer('onboarding_complete', { mode: 'boolean' }).default(false),
  createdAt: integer('created_at').default(Date.now()),

  // P0 trading-safety kill switch + max-loss protection (FINAL_ANALYSIS.md Section 15.22 #4/#5).
  // Persisted (not just in-memory on TradingEngine.state) so an emergency stop survives a
  // process restart instead of silently resuming trading - the whole point of "require explicit
  // reactivation" is defeated if a crash/redeploy clears it for free.
  tradingState: text('trading_state').notNull().default('TRADING_ENABLED'), // TRADING_ENABLED | TRADING_PAUSED | EMERGENCY_STOP
  maxPortfolioDrawdownPct: real('max_portfolio_drawdown_pct').default(0.15), // peak-to-trough real equity drawdown cap
  peakEquity: real('peak_equity'), // running high-water-mark of real broker equity, null until first observed
  maxOpenPositions: integer('max_open_positions').default(10),
  maxOrdersPerMinute: integer('max_orders_per_minute').default(5),

  // E2B (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - optional, feature-flagged position-sizing mode.
  // Default 'FIXED_DOLLAR' preserves today's exact behavior (maxTradeSize as a flat dollar cap)
  // for anyone who hasn't opted in. 'PERCENT_OF_EQUITY' instead caps the order-notional gate at
  // percentOfEquityPct% of CURRENT equity (so the cap scales as the account grows/shrinks) -
  // PositionSizing.ts's risk-based/buying-power/concentration/correlation caps remain unchanged
  // and still bind under either mode; this only changes which number feeds the notional cap.
  positionSizingMode: text('position_sizing_mode').notNull().default('FIXED_DOLLAR'), // FIXED_DOLLAR | PERCENT_OF_EQUITY
  percentOfEquityPct: real('percent_of_equity_pct').default(2), // only read when positionSizingMode='PERCENT_OF_EQUITY'
});

// Immutable audit trail for every kill-switch state transition (Phase 1.4: "every
// activation/deactivation must be audited"). Distinct from tradingEngine.state.history (an
// ephemeral, capped, in-memory activity feed) - this is a durable, queryable record.
export const killSwitchEvents = sqliteTable('kill_switch_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fromState: text('from_state').notNull(),
  toState: text('to_state').notNull(),
  reason: text('reason').notNull(),
  actor: text('actor').notNull(), // authenticated username, or 'system' for automated transitions
  cancelledOrderIds: text('cancelled_order_ids'), // JSON array of broker order IDs cancelled by this transition, if any
  createdAt: text('created_at').notNull(),
});

export const brokerConnections = sqliteTable('broker_connections', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  brokerName: text('broker_name').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  secretEncrypted: text('secret_encrypted'),
  paperMode: integer('paper_mode', { mode: 'boolean' }).default(true),
  status: text('status').default('Disconnected'),
  // A single "broker" (e.g. IBKR) can expose multiple real sub-accounts, and non-US brokers
  // report native-currency balances (IBKR CAD accounts, Questrade TFSA/RRSP in CAD) rather than
  // always USD. Both were previously unrepresentable - every connection was implicitly a single
  // USD account.
  accountId: text('account_id'),
  currency: text('currency').default('USD'),
});

export const aiProviders = sqliteTable('ai_providers', {
  id: text('id').primaryKey(),
  providerName: text('provider_name').notNull(),
  displayName: text('display_name'),
  apiEndpoint: text('api_endpoint'),
  apiKeyEncrypted: text('api_key_encrypted'),
  defaultModel: text('default_model'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(1),
  active: integer('active', { mode: 'boolean' }).default(true),
  health: text('health').default('Healthy'),
  latency: real('latency').default(0),
  quota: real('quota').default(0),
  requests: integer('requests').default(0),
  tokens: integer('tokens').default(0),
  inputTokens: integer('input_tokens').default(0),
  outputTokens: integer('output_tokens').default(0),
  cost: real('cost').default(0),
  successRate: real('success_rate').default(100),
  lastFailure: text('last_failure'),
  lastSuccess: text('last_success'),
  createdAt: text('created_at'),
  updatedAt: text('updated_at')
});

export const aiModels = sqliteTable('ai_models', {
  id: text('id').primaryKey(),
  providerId: text('provider_id'),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  displayName: text('display_name'),
  capabilities: text('capabilities'),
  predictedOhlc: text('predicted_ohlc'),
  marketStructure: text('market_structure'),
  momentum: text('momentum'),
  actualResult: text('actual_result'),
  mae: real('mae'),
  rmse: real('rmse'),
  mape: real('mape'),
  directionalAccuracy: real('directional_accuracy'),
  contextWindow: integer('context_window').default(8192),
  maxOutput: integer('max_output').default(4096),
  reasoningSupport: integer('reasoning_support', { mode: 'boolean' }).default(false),
  visionSupport: integer('vision_support', { mode: 'boolean' }).default(false),
  toolCalling: integer('tool_calling', { mode: 'boolean' }).default(false),
  structuredOutput: integer('structured_output', { mode: 'boolean' }).default(false),
  streaming: integer('streaming', { mode: 'boolean' }).default(true),
  pricingInput: real('pricing_input').default(0),
  pricingOutput: real('pricing_output').default(0),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  priority: integer('priority').default(1),
  latencyScore: real('latency_score').default(0),
  errorRate: real('error_rate').default(0),
  tokenUsage: integer('token_usage').default(0),
  estimatedCost: real('estimated_cost').default(0),
  lastUsedAt: text('last_used_at'),
  lastHealthCheck: text('last_health_check')
});

export const aiUsage = sqliteTable('ai_usage', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  predictedOhlc: text('predicted_ohlc'),
  marketStructure: text('market_structure'),
  momentum: text('momentum'),
  actualResult: text('actual_result'),
  mae: real('mae'),
  rmse: real('rmse'),
  mape: real('mape'),
  directionalAccuracy: real('directional_accuracy'),
  agent: text('agent'),
  promptTokens: integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  latency: real('latency').default(0),
  cost: real('cost').default(0),
  responseStatus: text('response_status'),
  retryCount: integer('retry_count').default(0)
});

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  quantity: real('quantity').notNull(),
  price: real('price').notNull(),
  status: text('status').notNull(), // PENDING, FILLED, REJECTED, CANCELED
  timestamp: text('timestamp').notNull(),
  reasoning: text('reasoning'),
  traceId: text('trace_id'),
  profitLoss: real('profit_loss'),
  newsUsed: integer('news_used', { mode: 'boolean' }).default(false),
  newsSentiment: real('news_sentiment'),
  newsConfidence: real('news_confidence'),
  newsSources: text('news_sources'),
  newsReasoning: text('news_reasoning'),
  // Phase 3 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - previously this row was written exactly
  // once, after the broker call (and optional fill-poll) had already resolved, so there was no
  // real PENDING->FILLED transition to replay - a trade just appeared fully-formed. OMS now
  // inserts this row immediately at submission and updates it as the broker order progresses.
  transactionId: text('transaction_id'),
  brokerOrderId: text('broker_order_id'),
  requestId: text('request_id'), // the idempotency key actually used (== id today, kept distinct in case that changes)
  submittedAt: text('submitted_at'),
  acceptedAt: text('accepted_at'),
  filledAt: text('filled_at'),
  // Phase 16B (ARGUS_PHASE16_READINESS_REPORT.md) - the real per-strategy stop/target a
  // QuantEngine-originated BUY was opened with (from ChiefTraderAgent's own
  // supportingQuantDetail.proposedStop/proposedTarget at approval time, threaded through
  // RiskAgent -> RiskEngine -> here), captured at the exact decision moment rather than
  // re-derived later from a nearest-timestamp heuristic. Null for every non-QuantEngine-sourced
  // trade (technical/news/fundamental-originated) - PortfolioMonitor.ts falls back to the
  // existing generic settings.takeProfitPct/trailingStopPct exit for those, unchanged.
  quantStrategyId: text('quant_strategy_id'),
  quantStopPrice: real('quant_stop_price'),
  quantTargetPrice: real('quant_target_price'),
  // Structured snapshot of the original QuantEngine thesis (regime, applicable regimes,
  // structural level, invalidation texts) so PortfolioMonitor can re-evaluate whether the
  // thesis is still valid - not just whether a numeric stop/target was hit.
  quantInvalidationJson: text('quant_invalidation_json'),
}, (table) => ({
  // Hardening pass, Phase 2: real duplicate-order idempotency at the DB level, closing the
  // check-then-act race in OrderManagement.ts's own pre-insert lookup (two concurrent
  // executeOrder() calls for the same traceId could both pass that check before either insert
  // landed). Confirmed zero existing duplicate or null traceId collisions in the live DB before
  // adding this. SQLite treats every NULL as distinct under a UNIQUE index, so this never blocks
  // a row with no traceId (legacy data, or any future code path that doesn't set one) - it only
  // ever rejects a genuine second INSERT for the same real traceId.
  traceIdUniqueIdx: uniqueIndex('idx_trades_trace_id_unique').on(table.traceId),
}));

// Thin by design - today's brokers (Alpaca, InternalPaperBroker) are single-shot market orders,
// so this will usually have 0-1 rows per order. Future-proofs partial fills without having to
// redesign `trades` later.
export const fills = sqliteTable('fills', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  orderId: text('order_id').notNull(), // FK trades.id
  brokerFillId: text('broker_fill_id'),
  quantity: real('quantity').notNull(),
  price: real('price').notNull(),
  filledAt: text('filled_at').notNull(),
});

export const dailyTradingSummary = sqliteTable('daily_trading_summary', {
  date: text('date').primaryKey(),
  totalTrades: integer('total_trades').notNull().default(0),
  totalVolume: real('total_volume').notNull().default(0),
  realizedPnl: real('realized_pnl').notNull().default(0),
  unrealizedPnl: real('unrealized_pnl').notNull().default(0),
  allocatedAmount: real('allocated_amount').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});

// Phase 3 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - RECONCILIATION_MISMATCH/MATCH were
// previously emitted live over EventBus/WS and never persisted anywhere - there was no way to
// ask "how many reconciliation mismatches happened last month." One row per reconciliation cycle
// (every 5 minutes), plus a point-in-time snapshot of both sides for real history (the live
// `portfolio` table only ever holds current state, no history).
export const reconciliationEvents = sqliteTable('reconciliation_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  checkedAt: text('checked_at').notNull(),
  broker: text('broker').notNull(),
  matches: integer('matches', { mode: 'boolean' }).notNull(),
  mismatches: text('mismatches'), // JSON array of MismatchDetail
  worstImpactDollars: real('worst_impact_dollars'),
  actionTaken: text('action_taken'), // e.g. 'TRADING_PAUSED', null if no action
});

export const portfolioSnapshots = sqliteTable('portfolio_snapshots', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  symbol: text('symbol').notNull(),
  quantity: real('quantity').notNull(),
  averagePrice: real('average_price'),
  currentPrice: real('current_price'),
  source: text('source').notNull(), // 'ARGUS' | 'BROKER'
  snapshotAt: text('snapshot_at').notNull(),
  reconciliationId: integer('reconciliation_id'), // FK reconciliation_events.id
});

export const portfolio = sqliteTable('portfolio', {
  symbol: text('symbol').primaryKey(),
  quantity: real('quantity').notNull(),
  averagePrice: real('average_price').notNull(),
  currentPrice: real('current_price'),
  lastUpdated: text('last_updated').notNull(),
  unrealizedPnL: real('unrealized_pnl'),
  brokerSource: text('broker_source'),
  currency: text('currency').default('USD'),
});

export const learnedRules = sqliteTable('learned_rules', {
  id: text('id').primaryKey(),
  agent: text('agent').notNull(),
  cause: text('cause').notNull(),
  rule: text('rule').notNull(),
  confidence: real('confidence').notNull(),
  timestamp: text('timestamp').notNull(),
});

export const agentPredictions = sqliteTable('agent_predictions', {
  id: text('id').primaryKey(),
  agentName: text('agent_name').notNull(),
  symbol: text('symbol').notNull(),
  prediction: text('prediction').notNull(), // BUY, SELL, HOLD
  confidence: real('confidence').notNull(),
  reasoning: text('reasoning').notNull(),
  timestamp: text('timestamp').notNull(),
  // Phase 1 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - the agent's own self-generated traceId,
  // previously dropped even though every TRADE_IDEA_GENERATED payload carries one. Lets this row
  // be joined to consensus_evidence.source_trace_id (and from there, to the transaction it fed)
  // without needing to eagerly know the transaction id at write time - most predictions are
  // logged before ChiefTraderAgent has evaluated consensus at all.
  traceId: text('trace_id'),
  // Only populated when this idea came from a real AI call (News/Fundamental/Macro) - null for
  // deterministic agents (Technical) and the FinBERT local-first path (no LLM call made).
  aiCallId: text('ai_call_id'),
  provider: text('provider'),
  latencyMs: real('latency_ms'),
});

export const agentPerformanceStats = sqliteTable('agent_performance_stats', {
  agentName: text('agent_name').primaryKey(),
  totalPredictions: integer('total_predictions').notNull().default(0),
  correctPredictions: integer('correct_predictions').notNull().default(0),
  winRate: real('win_rate').notNull().default(0),  
  averageReturn: real('average_return').notNull().default(0),
  profitFactor: real('profit_factor').notNull().default(0),
  sharpeRatio: real('sharpe_ratio').notNull().default(0),
  currentWeight: real('current_weight').notNull().default(1.0),
  lastEvaluated: text('last_evaluated').notNull(),
});

// Phase 1A (FINAL_ANALYSIS.md's 4-phase remediation plan) - real Beta-Binomial confidence
// calibration per agent, per stated-confidence bucket. Distinct from agentPerformanceStats.
// currentWeight above: that's a flat, agent-wide scalar driven by OVERALL win rate; this
// corrects a SPECIFIC agent's SPECIFIC stated confidence level against its own real historical
// accuracy at that level (e.g. NewsAgent's 80-90%-stated bucket resolving to ~34% real accuracy -
// a calibration failure a flat per-agent weight cannot see or correct). Written only by
// ReflectionEngine, from real prediction_outcomes - never estimated or guessed.
export const agentConfidenceCalibration = sqliteTable('agent_confidence_calibration', {
  agentName: text('agent_name').notNull(),
  bucketLow: real('bucket_low').notNull(), // inclusive lower bound of the stated-confidence bucket, e.g. 0.8
  bucketHigh: real('bucket_high').notNull(), // exclusive upper bound (1.0 bucket's upper bound is inclusive)
  wins: integer('wins').notNull().default(0),
  losses: integer('losses').notNull().default(0),
  // Beta-Binomial posterior mean: (wins + priorAlpha) / (wins + losses + priorAlpha + priorBeta),
  // prior centered on the bucket's own midpoint - shrinks toward the agent's OWN stated
  // confidence when real sample size is thin (e.g. a 1-prediction agent), and toward the real
  // observed accuracy once enough real outcomes exist to justify overriding the prior.
  calibratedConfidence: real('calibrated_confidence').notNull(),
  lastEvaluated: text('last_evaluated').notNull(),
}, (table) => ({
  agentBucketIdx: uniqueIndex('idx_agent_confidence_calibration_bucket').on(table.agentName, table.bucketLow),
}));

export const explainabilityReports = sqliteTable('explainability_reports', {
  traceId: text('trace_id').primaryKey(),
  symbol: text('symbol').notNull(),
  decision: text('decision').notNull(),
  reportText: text('report_text').notNull(),
  timestamp: text('timestamp').notNull(),
});

export const agentMemory = sqliteTable('agent_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  agentName: text('agent_name').notNull(),
  decision: text('decision').notNull(),
  reasoning: text('reasoning'),
  confidence: real('confidence'),
  result: text('result')
});

export const eventTraces = sqliteTable('event_traces', {
  id: text('id').primaryKey(),
  correlationId: text('correlation_id'),
  tradeId: text('trade_id'),
  timestamp: integer('timestamp').notNull(),
  source: text('source').notNull(),
  destination: text('destination'),
  eventType: text('event_type').notNull(),
  payload: text('payload'), // JSON string
  durationMs: integer('duration_ms'),
  success: integer('success', { mode: 'boolean' }).default(true),
  errorInfo: text('error_info'),
  // Links this event to the canonical transaction it belongs to (transactions.id), when known.
  // Nullable: most emitters still only carry their own self-generated traceId (correlationId
  // above) - transactionId is populated once TransactionRegistry has minted one (from
  // CHIEF_APPROVED_IDEA onward). See TRANSACTION_OBSERVATORY_ARCHITECTURE.md Phase 0.
  transactionId: text('transaction_id'),
});

export const memoryRules = sqliteTable('memory_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),

  ruleText: text('rule_text').notNull(),
  weight: real('weight').default(1.0),
  createdAt: integer('created_at').default(Date.now())
});

export const newsArticles = sqliteTable('news_articles', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content'),
  url: text('url'),
  source: text('source').notNull(),
  author: text('author'),
  publishedAt: text('published_at').notNull(),
  clusterId: text('cluster_id'),
  sentimentScore: real('sentiment_score'),
  credibilityScore: real('credibility_score'),
  relevanceScore: real('relevance_score'),
  summary: text('summary'),
  symbols: text('symbols')
});

export const newsClusters = sqliteTable('news_clusters', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  summary: text('summary'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  eventType: text('event_type'),
  sentimentScore: real('sentiment_score'),
  impactScore: real('impact_score'),
  timeHorizon: text('time_horizon'),
  isArchived: integer('is_archived', { mode: 'boolean' }).default(false),
  symbols: text('symbols')
});

export const newsProviders = sqliteTable('news_providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  apiKeyEncrypted: text('api_key_encrypted'),
  enabled: integer('enabled', { mode: 'boolean' }).default(true),
  lastFetch: text('last_fetch'),
  health: text('health').default('Healthy'),
  errorCount: integer('error_count').default(0),
  credibilityWeight: real('credibility_weight').default(1.0)
});

export const kronosPredictions = sqliteTable('kronos_predictions', {
  timeframe: text('timeframe').default('1m'),
  id: integer('id').primaryKey({ autoIncrement: true }),

  symbol: text('symbol').notNull(),
  prediction: text('prediction').notNull(),
  confidence: integer('confidence').notNull(),
  forecastHorizon: integer('forecast_horizon').notNull(),
  expectedMove: text('expected_move').notNull(),
  volatility: text('volatility').notNull(),
  support: real('support').notNull(),
  resistance: real('resistance').notNull(),
  model: text('model').notNull(),
  predictedOhlc: text('predicted_ohlc'),
  marketStructure: text('market_structure'),
  momentum: text('momentum'),
  actualResult: text('actual_result'),
  mae: real('mae'),
  rmse: real('rmse'),
  mape: real('mape'),
  directionalAccuracy: real('directional_accuracy'),
  timestamp: text('timestamp').notNull(),
  // Phase 4 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - the above actualResult/mae/rmse/mape/
  // directionalAccuracy columns were never populated (KronosMetrics.evaluateTrade() was an empty
  // stub, never called). Superseded by the new prediction_outcomes table + PredictionOutcomeEvaluator
  // instead of implementing that stub - one real evaluator for both agent_predictions and
  // kronos_predictions rather than two separate mechanisms. traceId/transactionId let a Kronos
  // forecast be joined to the transaction it may have contributed evidence to.
  traceId: text('trace_id'),
  transactionId: text('transaction_id'),
});

// Per-agent AI provider routing overrides (Phase 6). AIRouter.setAgentRoute() already existed and
// routeTask() already checks it, but nothing ever called it - AIProviderManagement.tsx's "Agent
// Routing" tab posted to a route that didn't exist. This table is the missing persistence layer.
export const agentRoutingOverrides = sqliteTable('agent_routing_overrides', {
  agentName: text('agent_name').primaryKey(),
  providerId: text('provider_id').notNull(),
  model: text('model'),
  updatedAt: text('updated_at').notNull(),
});

// Real historical OHLCV storage for the backtest/replay engine (Phase 2). Bar timestamp is the
// bar's OPEN time in epoch ms - the replay clock enforces that no agent sees a bar whose
// timestamp is later than the simulated "now".
export const ohlcvBars = sqliteTable('ohlcv_bars', {
  id: text('id').primaryKey(), // `${symbol}:${timeframe}:${timestamp}`
  symbol: text('symbol').notNull(),
  timeframe: text('timeframe').notNull(), // '1Min', '5Min', '15Min', '1Hour', '1Day'
  timestamp: integer('timestamp').notNull(), // bar open time, epoch ms
  open: real('open').notNull(),
  high: real('high').notNull(),
  low: real('low').notNull(),
  close: real('close').notNull(),
  volume: real('volume').notNull(),
  source: text('source').notNull().default('alpaca'),
}, (table) => ({
  symbolTimeframeTimeIdx: index('idx_ohlcv_symbol_tf_time').on(table.symbol, table.timeframe, table.timestamp),
}));

export const backtestRuns = sqliteTable('backtest_runs', {
  id: text('id').primaryKey(),
  createdAt: text('created_at').notNull(),
  status: text('status').notNull(), // RUNNING, COMPLETED, FAILED
  symbols: text('symbols').notNull(), // JSON array
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  timeframe: text('timeframe').notNull(),
  initialCash: real('initial_cash').notNull(),
  finalEquity: real('final_equity'),
  totalTrades: integer('total_trades').default(0),
  winRate: real('win_rate'),
  profitFactor: real('profit_factor'),
  sharpeRatio: real('sharpe_ratio'),
  sortinoRatio: real('sortino_ratio'),
  maxDrawdownPct: real('max_drawdown_pct'),
  cagr: real('cagr'),
  expectancy: real('expectancy'),
  errorMessage: text('error_message'),
  equityCurve: text('equity_curve'), // JSON array of {timestamp, equity}
  tradeLog: text('trade_log'), // JSON array of individual simulated trades
});

export const predictionEngineWeights = sqliteTable('prediction_engine_weights', {
  id: text('id').primaryKey(), // engine name e.g., 'Kronos', 'Technical'
  winRate: real('win_rate').default(0),
  accuracy: real('accuracy').default(0),
  averagePredictionError: real('average_prediction_error').default(0),
  precision: real('precision').default(0),
  recall: real('recall').default(0),
  roi: real('roi').default(0),
  sharpeContribution: real('sharpe_contribution').default(0),
  drawdownContribution: real('drawdown_contribution').default(0),
  lastUpdated: text('last_updated').notNull()
});

// Real local-first escalation decisions (EscalationPolicy.ts) - every time a caller had to decide
// "does this need a paid/reasoning-model call, or is a local signal already decisive," this
// records what local signal was checked, its confidence, and why escalation did or didn't happen.
// A real (if intentionally minimal) slice of the "AI call ledger" idea - not the full
// system_events/agent_decisions/model_predictions/prediction_outcomes/training_examples schema.
export const escalationDecisions = sqliteTable('escalation_decisions', {
  id: text('id').primaryKey(),
  timestamp: text('timestamp').notNull(),
  traceId: text('trace_id'),
  agent: text('agent').notNull(),
  task: text('task').notNull(), // e.g. 'news_sentiment_analysis'
  localSource: text('local_source').notNull(), // e.g. 'finbert'
  localSignalAvailable: integer('local_signal_available', { mode: 'boolean' }).notNull(),
  localConfidence: real('local_confidence'),
  decisiveThreshold: real('decisive_threshold').notNull(),
  escalated: integer('escalated', { mode: 'boolean' }).notNull(),
  reason: text('reason').notNull(),
  escalatedProvider: text('escalated_provider'),
});

// ==========================================================================================
// Transaction Observatory - Phase 0 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md)
//
// Fixes a real architectural bug: prior to this, "traceId" identified one agent's own
// emission, not one decision cycle. ChiefTraderAgent.evaluateConsensus() groups contributing
// ideas by symbol (not traceId), then reports whichever single idea's traceId happened to
// trigger the consensus check - so a trade approved on News's tipping vote would carry only
// News's traceId, orphaning Technical's/Kronos's contributing evidence under their own,
// different, self-generated ids. `transactions` is the new canonical unit: one row per symbol
// per consensus-evaluation-cycle, id minted once by ChiefTraderAgent (human-readable
// ARG-YYYY-MM-DD-NNNNNN format), with every contributing agent's evidence linked via
// `consensus_evidence` regardless of which agent's own id triggered the cycle.
// ==========================================================================================
export const transactions = sqliteTable('transactions', {
  id: text('id').primaryKey(), // 'ARG-2026-08-10-000123'
  symbol: text('symbol').notNull(),
  openedAt: text('opened_at').notNull(),
  closedAt: text('closed_at'),
  // OPEN (consensus approved, awaiting risk/order) | NO_CONSENSUS | RISK_REJECTED |
  // EXECUTED (order submitted to broker, awaiting fill) | ORDER_REJECTED (broker rejected/
  // canceled the order after risk approval) | FILLED | RECONCILED. Wired to real transitions by
  // TransactionLifecycleTracker - see its header comment for the real bug this fixes.
  status: text('status').notNull(),
  finalDecision: text('final_decision'), // BUY | SELL | HOLD | REJECTED
  outcome: text('outcome').default('PENDING'), // WIN | LOSS | PENDING | N_A
});

// ChiefTraderAgent's weighted-vote consensus math, persisted as first-class queryable columns
// instead of only existing inside one CHIEF_APPROVED_IDEA event payload.
export const consensusDecisions = sqliteTable('consensus_decisions', {
  transactionId: text('transaction_id').primaryKey(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(), // BUY | SELL | HOLD
  weightedConfidence: real('weighted_confidence').notNull(),
  threshold: real('threshold').notNull(),
  approved: integer('approved', { mode: 'boolean' }).notNull(),
  agreementsCount: integer('agreements_count').notNull().default(0),
  disagreementsCount: integer('disagreements_count').notNull().default(0),
  debateUsed: integer('debate_used', { mode: 'boolean' }).default(false),
  debateProviderCount: integer('debate_provider_count'),
  reasoning: text('reasoning'),
  createdAt: text('created_at').notNull(),
});

// Every contributing agent's evidence for a transaction, regardless of which agent's own
// self-generated traceId happened to trigger the consensus cycle. `sourceTraceId` is a soft
// reference back to that agent's own event_traces rows (agent_predictions/agent_decisions
// don't yet carry stable ids to hard-FK against - see Phase 1 in the architecture doc).
export const consensusEvidence = sqliteTable('consensus_evidence', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  transactionId: text('transaction_id').notNull(),
  sourceTraceId: text('source_trace_id'),
  agent: text('agent').notNull(),
  side: text('side').notNull(),
  confidence: real('confidence').notNull(),
  weight: real('weight').notNull(),
  reasoning: text('reasoning'),
  agreed: integer('agreed', { mode: 'boolean' }).notNull(), // did this agent's side match the final consensus side?
  currentPrice: real('current_price'),
});

// Phase 1 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - the AI call ledger. Before this, AIRouter's
// routeTask()/routeConsensus() sent the real prompt to the real provider and only the token
// counts/latency/cost survived into `ai_usage` - the prompt text and raw response were discarded
// in-memory as soon as the call returned. This table is the forensic record `ai_usage`'s
// aggregate counters were never meant to be; `ai_usage` stays as-is for existing dashboards.
// transactionId is deliberately nullable and NOT eagerly populated - most AI calls happen before
// ChiefTraderAgent has minted a transaction id at all (News/Fundamental/Macro analyze BEFORE
// consensus is evaluated). Join via traceId -> consensus_evidence.source_trace_id instead.
export const aiCalls = sqliteTable('ai_calls', {
  id: text('id').primaryKey(),
  traceId: text('trace_id'),
  transactionId: text('transaction_id'),
  agent: text('agent').notNull(),
  provider: text('provider').notNull(),
  model: text('model'),
  modelVersion: text('model_version'),
  promptVersion: text('prompt_version'),
  prompt: text('prompt'),
  rawResponse: text('raw_response'),
  parsedResponse: text('parsed_response'), // JSON string, when the caller successfully parsed structured output
  tokensIn: integer('tokens_in'),
  tokensOut: integer('tokens_out'),
  cost: real('cost'),
  latencyMs: real('latency_ms'),
  status: text('status').notNull(), // success | error
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

// Phase 2 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - RiskEngine's decision, persisted as a real
// row instead of only existing inside one RISK_ASSESSMENT_COMPLETED event payload. Confirmed
// design change (user sign-off): RiskEngine now evaluates every gate every time (previously
// early-exited on the first failure), so a rejected trade still has a complete gate-by-gate
// record - required for honest per-gate visualization instead of fabricating checkmarks for
// gates that never ran.
export const riskAssessments = sqliteTable('risk_assessments', {
  transactionId: text('transaction_id'),
  traceId: text('trace_id').primaryKey(), // proposal.traceId - not every risk check has a transactionId yet (e.g. legacy callers)
  symbol: text('symbol').notNull(),
  side: text('side').notNull(),
  approved: integer('approved', { mode: 'boolean' }).notNull(),
  maxQuantity: real('max_quantity').notNull(),
  rejectionGate: text('rejection_gate'), // which gate's failure determined the final reject, if any
  accountEquity: real('account_equity'),
  buyingPower: real('buying_power'),
  reasoning: text('reasoning'),
  createdAt: text('created_at').notNull(),
});

export const riskGateResults = sqliteTable('risk_gate_results', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  traceId: text('trace_id').notNull(), // FK risk_assessments.trace_id
  gateName: text('gate_name').notNull(),
  sequence: integer('sequence').notNull(),
  passed: integer('passed', { mode: 'boolean' }).notNull(),
  detail: text('detail'), // JSON - per-gate shape varies (e.g. {current, max, proposed} for concentration caps)
});

// Phase 4 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - separates what a model/agent predicted from
// what actually happened, using real point-in-time OHLCV bars (via HistoricalDataGateway) rather
// than ReflectionEngine's prior "nearest FILLED trade within 5 minutes" proxy. `sourceTable`
// disambiguates which table `predictionId` refers to (agent_predictions.id is a UUID text;
// kronos_predictions.id is an autoincrement integer stringified - both land in the same text
// column, so the source table must be recorded to join back correctly). `pnl` is only populated
// when a prediction is tied to a real executed trade with a known size - left null otherwise
// rather than fabricating a dollar figure from an unsized directional call.
export const predictionOutcomes = sqliteTable('prediction_outcomes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  predictionId: text('prediction_id').notNull(),
  sourceTable: text('source_table').notNull(), // 'agent_predictions' | 'kronos_predictions'
  symbol: text('symbol').notNull(),
  actualPrice: real('actual_price'),
  actualReturn: real('actual_return'),
  actualDirection: text('actual_direction'), // UP | DOWN | FLAT
  mfe: real('mfe'), // Maximum Favorable Excursion (return terms, signed positive = favorable), over the evaluation window
  mae: real('mae'), // Maximum Adverse Excursion (return terms, signed negative = adverse) - NOT Mean Absolute Error
  pnl: real('pnl'),
  outcome: text('outcome').notNull(), // WIN | LOSS | N_A
  evaluatedAt: text('evaluated_at').notNull(),
}, (table) => ({
  predictionSourceIdx: uniqueIndex('idx_prediction_outcomes_source').on(table.predictionId, table.sourceTable),
}));

// Phase 7 (TRANSACTION_OBSERVATORY_ARCHITECTURE.md) - materialized, batch-built training
// dataset. Never written live - only TrainingExampleBuilder writes here, and only after
// checking every contributing input's availableAt against decisionAt (point-in-time integrity,
// req #24). A transaction whose evidence fails that check is skipped, not silently included.
// "Do NOT automatically train models yet" (per the architecture doc) - this is dataset
// construction only, no training pipeline consumes it.
export const trainingExamples = sqliteTable('training_examples', {
  id: text('id').primaryKey(), // == transactionId, one training example per transaction for now
  transactionId: text('transaction_id').notNull(),
  observedAt: text('observed_at').notNull(), // earliest contributing evidence's own timestamp
  availableAt: text('available_at').notNull(), // when the consensus decision itself became known
  decisionAt: text('decision_at').notNull(), // when ChiefTraderAgent actually decided
  featureSnapshot: text('feature_snapshot').notNull(), // JSON - frozen evidence/consensus inputs as of decisionAt only
  label: text('label').notNull(), // JSON - real point-in-time outcome (PredictionOutcomeEvaluator)
  createdAt: text('created_at').notNull(),
});

// OpenAlice external verification requests/results (OpenAliceAdapter, OpenAliceVerificationService).
// OpenAlice is a separate, independent AI system reached only over MCP - it never has trading
// credentials and this table is read-only evidence for FUTURE decisions, never a retroactive
// edit to a trade that already executed. See OPENALICE_INTEGRATION_AUDIT.md.
export const openaliceVerifications = sqliteTable('openalice_verifications', {
  id: text('id').primaryKey(), // requestId, also the OpenAlice issue id
  traceId: text('trace_id').notNull(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(), // 'BUY' | 'SELL'
  mode: text('mode').notNull(), // 'BLIND_RESEARCH' | 'TRADE_VERIFICATION' | 'ADVERSARIAL_REVIEW'
  argusConfidence: real('argus_confidence').notNull(),
  argusReasoning: text('argus_reasoning').notNull(),
  status: text('status').notNull(), // 'PENDING' | 'COMPLETED' | 'TIMED_OUT' | 'FAILED'
  direction: text('direction'), // 'AGREE' | 'DISAGREE' | 'NO_OPINION', null until COMPLETED
  openaliceConfidence: real('openalice_confidence'),
  thesis: text('thesis'),
  supportingEvidence: text('supporting_evidence'), // JSON string array
  contradictingEvidence: text('contradicting_evidence'), // JSON string array
  rawResponse: text('raw_response'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  completedAt: text('completed_at'),
  latencyMs: integer('latency_ms'),
});

// Phase 1C (FINAL_ANALYSIS.md's 4-phase remediation plan) - real cache + rate-limit tracking for
// external data providers with a request quota (AlphaVantage's free tier: 25 requests/day).
// Root cause confirmed live against the real configured key: FundamentalAgent/MacroAgent were
// each polling every 60-75s, exhausting the daily quota within minutes, after which every
// subsequent call got AlphaVantage's rate-limit response and fell through to an honest
// DATA_UNAVAILABLE - not a bug in that fallback, but real, avoidable waste, since fundamentals/
// macro indicators don't change on a sub-minute cadence in reality either. `symbol` is null for
// provider-wide data that isn't per-symbol (e.g. MacroAgent's CPI/Fed-Funds/unemployment, which
// were previously wastefully re-fetched every cycle regardless of which "symbol" was nominally
// being analyzed that cycle, despite being symbol-independent).
export const externalDataCache = sqliteTable('external_data_cache', {
  id: text('id').primaryKey(), // `${provider}:${dataType}:${symbol ?? 'GLOBAL'}`
  provider: text('provider').notNull(), // 'alphavantage'
  dataType: text('data_type').notNull(), // 'fundamentals' | 'macro'
  symbol: text('symbol'), // null for symbol-independent data (macro indicators)
  payload: text('payload').notNull(), // JSON - the real last-successful response, never fabricated
  fetchedAt: integer('fetched_at').notNull(), // epoch ms of the last real successful fetch
  // Set when a fetch attempt hits the provider's real rate-limit response - suppresses further
  // real network calls until this real cooldown passes, instead of hammering an exhausted quota
  // every cycle and getting the same rejection every time.
  rateLimitedUntil: integer('rate_limited_until'),
});

// Additive quant decision layer (see plans/argus-quant-decision-layer plan, and
// src/server/quant/). One row per QuantSignalAgent evaluation cycle per symbol - regime and
// market-context are computed by Phase 2/3 (RegimeEngine.ts/MarketContext.ts) and persisted in
// full (JSON) for real auditability, matching this schema's existing convention of persisting
// full computed objects rather than a lossy summary (e.g. backtest_runs.equityCurve/tradeLog,
// consensus_evidence). `strategyEvaluations`/`groupedScores` are reserved, nullable columns for
// Phase 4 (Strategy Engine) and Phase 5 (Decision Layer) to populate later - designed in now to
// avoid a second migration once those phases land, not yet written by anything as of Phase 3.
export const quantAssessments = sqliteTable('quant_assessments', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  timeframe: text('timeframe').notNull(),
  regime: text('regime').notNull(), // JSON - full RegimeResult (RegimeEngine.ts)
  marketContext: text('market_context').notNull(), // JSON - full MarketContextResult (MarketContext.ts)
  strategyEvaluations: text('strategy_evaluations'), // JSON array - Phase 4, null until then
  groupedScores: text('grouped_scores'), // JSON - Phase 5, null until then
  aiContradictionAnalysis: text('ai_contradiction_analysis'), // JSON ContradictionAnalysisResult - Phase 7 (quant/ai/QuantContradictionAnalyzer.ts), null when no idea was emitted this cycle or no AI provider is configured
  emittedTradeIdea: integer('emitted_trade_idea', { mode: 'boolean' }).notNull().default(false),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  symbolIdx: index('idx_quant_assessments_symbol').on(table.symbol, table.createdAt),
}));

// Phase 10 of the additive quant layer - per-strategy, per-regime backtesting. Deliberately a
// SEPARATE table from `backtestRuns`, not a repurposing of it: backtestRuns is real, in-use, and
// scoped to the existing single hardcoded technical strategy BacktestEngine.run() already backtests
// - this table is scoped to running ONE named quant strategy (strategies/StrategyEngine.ts) via the
// new BacktestEngine.runStrategyBacktest(), with real regime-segmented results and a real,
// backtest-derived expected-value/Kelly readout (quant/risk/ExpectedValue.ts) neither
// backtestRuns nor the live RiskEngine/PositionSizing path has ever computed.
export const quantStrategyBacktests = sqliteTable('quant_strategy_backtests', {
  id: text('id').primaryKey(),
  strategyId: text('strategy_id').notNull(),
  symbol: text('symbol').notNull(),
  timeframe: text('timeframe').notNull(),
  startDate: text('start_date').notNull(),
  endDate: text('end_date').notNull(),
  status: text('status').notNull(), // RUNNING | COMPLETED | FAILED
  errorMessage: text('error_message'),
  initialCash: real('initial_cash'),
  finalEquity: real('final_equity'),
  totalTrades: integer('total_trades'),
  winRatePct: real('win_rate_pct'),
  profitFactor: real('profit_factor'),
  sharpe: real('sharpe'),
  sortino: real('sortino'),
  maxDrawdownPct: real('max_drawdown_pct'),
  expectancy: real('expectancy'),
  avgWinR: real('avg_win_r'),
  avgLossR: real('avg_loss_r'),
  avgR: real('avg_r'),
  maxConsecutiveLosses: integer('max_consecutive_losses'),
  regimeBreakdown: text('regime_breakdown'), // JSON - per-regime {count, winRatePct, expectancy}
  expectedValue: text('expected_value'), // JSON - ExpectedValueResult, real backtest-derived EV, null if insufficient sample size
  kelly: text('kelly'), // JSON - KellyResult, real backtest-derived Kelly suggestion, null if insufficient sample size
  tradeLog: text('trade_log'), // JSON
  equityCurve: text('equity_curve'), // JSON
  // E7 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - JSON {strategyReturnPct, symbolBuyAndHoldReturnPct,
  // spyBuyAndHoldReturnPct, outperformedSymbolBuyAndHold, outperformedSpyBuyAndHold}, computed from
  // the real bars this run already loaded (the traded symbol's own first/last close, and SPY's over
  // the same window) - never a second fetch, never an assumed benchmark return.
  benchmarkComparison: text('benchmark_comparison'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  strategySymbolIdx: index('idx_quant_strategy_backtests_strategy_symbol').on(table.strategyId, table.symbol),
}));

// E3 (BACKTEST_QUANT_HARDENING_ANALYSIS.md) - optional, per-candidate decision trace for a
// runStrategyBacktest() run, so "why did/didn't this bar produce a trade" is answerable after the
// fact instead of only the final trade log. Deliberately opt-in (StrategyBacktestConfig.
// verboseLogging) and a separate table from quant_strategy_backtests - a multi-year daily backtest
// evaluates thousands of candidate bars, most of which never become a trade, so this must never be
// written unconditionally on every run.
export const quantBacktestDecisionLog = sqliteTable('quant_backtest_decision_log', {
  id: text('id').primaryKey(),
  backtestRunId: text('backtest_run_id').notNull(), // quant_strategy_backtests.id, not FK-enforced (matches this schema's existing convention for cross-table references)
  symbol: text('symbol').notNull(),
  timestamp: integer('timestamp').notNull(), // bar timestamp (ms)
  regime: text('regime'), // RegimeLabel at this bar
  side: text('side').notNull(), // BUY | SELL - the side the strategy evaluated
  setupScore: real('setup_score'),
  confidence: real('confidence'),
  conditionsMet: text('conditions_met'), // JSON string[]
  conditionsFailed: text('conditions_failed'), // JSON string[]
  contradictions: text('contradictions'), // JSON string[]
  sizingQuantity: integer('sizing_quantity'), // 0 if sizing rejected the candidate
  sizingGates: text('sizing_gates'), // JSON SizingGateResult[], null when sizing was never reached (e.g. confidence gate already rejected)
  outcome: text('outcome').notNull(), // ENTERED | REJECTED_LOW_CONFIDENCE | REJECTED_NO_STOP | REJECTED_ZERO_SIZE
  reason: text('reason').notNull(), // human-readable explanation of `outcome`
  createdAt: text('created_at').notNull(),
}, (table) => ({
  runIdx: index('idx_quant_backtest_decision_log_run').on(table.backtestRunId),
}));

/**
 * Point-in-time AI/news/ChiefTrader ledger for historical replay.
 * publishedAtMs is when the fact existed in the world. asOfMs is the earliest simulated
 * clock at which a replay may read it. Ingestion MUST reject publishedAtMs > asOfMs
 * (look-ahead). Queries MUST filter publishedAtMs <= simulated now.
 */
export const tradeLifecycleTransitions = sqliteTable('trade_lifecycle_transitions', {
  id: text('id').primaryKey(),
  candidateId: text('candidate_id').notNull(),
  symbol: text('symbol').notNull(),
  state: text('state').notNull(),
  reason: text('reason'),
  source: text('source'),
  evidenceJson: text('evidence_json'),
  latencyMs: integer('latency_ms'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  candidateIdx: index('idx_trade_lifecycle_candidate').on(table.candidateId),
  createdIdx: index('idx_trade_lifecycle_created').on(table.createdAt),
}));

export const pitDecisionLedger = sqliteTable('pit_decision_ledger', {
  id: text('id').primaryKey(),
  asOfMs: integer('as_of_ms').notNull(),
  publishedAtMs: integer('published_at_ms').notNull(),
  symbol: text('symbol').notNull(),
  kind: text('kind').notNull(), // NEWS | NEWS_AGENT | CHIEF_TRADER | AGENT_REASONING
  agent: text('agent'),
  side: text('side'),
  confidence: real('confidence'),
  finbertScore: real('finbert_score'),
  impactScore: real('impact_score'),
  payloadJson: text('payload_json'),
  source: text('source'),
  createdAt: text('created_at').notNull(),
}, (table) => ({
  asOfIdx: index('idx_pit_decision_ledger_asof').on(table.asOfMs),
  publishedIdx: index('idx_pit_decision_ledger_published').on(table.publishedAtMs),
  symbolIdx: index('idx_pit_decision_ledger_symbol').on(table.symbol),
}));
