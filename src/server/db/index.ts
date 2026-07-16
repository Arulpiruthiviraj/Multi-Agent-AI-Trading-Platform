import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import path from 'path';

const sqlite = new Database('argus.db');
export const db = drizzle(sqlite, { schema });

// Simple migrate function for local dev (in prod use drizzle-kit migrations)
sqlite.exec(`
  CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL,
    quantity REAL NOT NULL,
    price REAL NOT NULL,
    status TEXT NOT NULL,
    timestamp TEXT NOT NULL,
    reasoning TEXT
  );
  
  CREATE TABLE IF NOT EXISTS portfolio (
    symbol TEXT PRIMARY KEY,
    quantity REAL NOT NULL,
    average_price REAL NOT NULL,
    current_price REAL,
    last_updated TEXT NOT NULL
  );
  
  CREATE TABLE IF NOT EXISTS learned_rules (
    id TEXT PRIMARY KEY,
    agent TEXT NOT NULL,
    cause TEXT NOT NULL,
    rule TEXT NOT NULL,
    confidence REAL NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_predictions (
    id TEXT PRIMARY KEY,
    agent_name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    prediction TEXT NOT NULL,
    confidence REAL NOT NULL,
    reasoning TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agent_performance_stats (
    agent_name TEXT PRIMARY KEY,
    total_predictions INTEGER NOT NULL DEFAULT 0,
    correct_predictions INTEGER NOT NULL DEFAULT 0,
    win_rate REAL NOT NULL DEFAULT 0,
    average_return REAL NOT NULL DEFAULT 0,
    profit_factor REAL NOT NULL DEFAULT 0,
    sharpe_ratio REAL NOT NULL DEFAULT 0,
    current_weight REAL NOT NULL DEFAULT 1.0,
    last_evaluated TEXT NOT NULL
  );
`);

console.log("Database initialized.");
