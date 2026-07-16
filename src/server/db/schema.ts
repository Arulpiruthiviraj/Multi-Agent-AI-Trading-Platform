import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const trades = sqliteTable('trades', {
  id: text('id').primaryKey(),
  symbol: text('symbol').notNull(),
  side: text('side').notNull(), // BUY, SELL
  quantity: real('quantity').notNull(),
  price: real('price').notNull(),
  status: text('status').notNull(), // PENDING, FILLED, REJECTED, CANCELED
  timestamp: text('timestamp').notNull(),
  reasoning: text('reasoning'),
});

export const portfolio = sqliteTable('portfolio', {
  symbol: text('symbol').primaryKey(),
  quantity: real('quantity').notNull(),
  averagePrice: real('average_price').notNull(),
  currentPrice: real('current_price'),
  lastUpdated: text('last_updated').notNull(),
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
