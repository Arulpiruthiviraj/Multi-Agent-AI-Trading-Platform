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

import { sqliteTable, text, integer, real, index } from 'drizzle-orm/sqlite-core';

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
  createdAt: integer('created_at').default(Date.now())
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
  newsReasoning: text('news_reasoning')
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
  errorInfo: text('error_info')
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
  timestamp: text('timestamp').notNull()
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
