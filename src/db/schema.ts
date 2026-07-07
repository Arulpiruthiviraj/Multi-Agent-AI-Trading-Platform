// src/db/schema.ts - Production Drizzle ORM Schema Extension
import { pgTable, text, serial, doublePrecision, timestamp, jsonb } from 'drizzle-orm/pg-core';

/**
 * Portfolios Table
 * Stores global trading metrics, budget settings, and active account balance.
 */
export const portfolios = pgTable('portfolios', {
  id: serial('id').primaryKey(),
  balance: doublePrecision('balance').notNull(),
  allocatedBudget: doublePrecision('allocated_budget').notNull(),
  createdAt: timestamp('created_at').defaultNow()
});

/**
 * Historical Executed Trades
 * Append-only ledger of executed trades triggered by the Multi-Agent Swarm.
 */
export const trades = pgTable('trades', {
  id: serial('id').primaryKey(),
  symbol: text('symbol').notNull(),
  type: text('type').notNull(), // 'BUY' | 'SELL'
  price: doublePrecision('price').notNull(),
  quantity: doublePrecision('quantity').notNull(),
  timestamp: timestamp('timestamp').defaultNow(),
  agentsConsensus: text('agents_consensus'),
  reasoning: text('reasoning'),
  slippagePercent: doublePrecision('slippage_percent'),
  atrValue: doublePrecision('atr_value')
});

/**
 * Memory Rules & Reflections
 * Evolutionary constraints generated from sudden drawdowns or losses.
 */
export const memoryRules = pgTable('memory_rules', {
  id: serial('id').primaryKey(),
  ruleText: text('rule_text').notNull(),
  weight: doublePrecision('weight').defaultNow(), // Dynamic rule decay multiplier (0.0 - 1.0)
  createdAt: timestamp('created_at').defaultNow()
});

/**
 * Portfolio Snapshots (Append-Only Event Stream)
 * Mitigates concurrency locks by writing high-speed state representations as an append-only sequence.
 * Couples seamlessly with our 10-30s asynchronous caching layer.
 */
export const portfolioSnapshots = pgTable('portfolio_snapshots', {
  id: serial('id').primaryKey(),
  timestamp: timestamp('timestamp').defaultNow().notNull(),
  totalEquity: doublePrecision('total_equity').notNull(),
  cashBalance: doublePrecision('cash_balance').notNull(),
  sectorExposure: jsonb('sector_exposure').notNull(), // Stores nested sector weight mapping (e.g. { "Tech": 0.4, "PreciousMetals": 0.1 })
  activeMemoryRuleIds: text('active_memory_rule_ids').array() // Traces which context constraints were active at the snapshot tick
});
