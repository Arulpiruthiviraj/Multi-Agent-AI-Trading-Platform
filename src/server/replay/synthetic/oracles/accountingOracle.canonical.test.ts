import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { compareOracleToLedger, runAccountingOracle } from './accountingOracle';
import { readOracleInputs } from './ledgerAdapter';

// Builds a tiny ledger DB shaped like the synthetic session's (trades/fills/portfolio) and proves adapter + oracle agree end to end.
describe('ledgerAdapter + accountingOracle', () => {
  it('canonical NVDA round trip reconciles; a corrupted ledger P&L is caught', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'oracle-'));
    const dbPath = path.join(dir, 'l.db');
    const db = new Database(dbPath);
    db.exec(`CREATE TABLE trades(id TEXT, symbol TEXT, side TEXT, status TEXT, profit_loss REAL);
             CREATE TABLE fills(id INTEGER, order_id TEXT, quantity REAL, price REAL, filled_at TEXT, realized_pnl REAL);
             CREATE TABLE portfolio(symbol TEXT, quantity REAL, average_price REAL);
             INSERT INTO trades VALUES('b','NVDA','BUY','FILLED',NULL),('s','NVDA','SELL','FILLED',-160.476228);
             INSERT INTO fills VALUES(1,'b',22,134.610718,'1',NULL),(2,'s',22,127.316344,'2',-160.476228);`);
    db.close();
    const broker = { cash: 99839.303772, realizedPnl: -160.586228, feesPaid: 0.22, positions: [] };
    const fee = (f: { quantity: number }) => f.quantity * 0.005;
    const { fills, ledger } = readOracleInputs(dbPath, broker, 100000, fee);
    expect(compareOracleToLedger(runAccountingOracle(fills), ledger)).toEqual([]);
    ledger.tradesPnlBySellOrder.s = -100;
    expect(compareOracleToLedger(runAccountingOracle(fills), ledger).map((m) => m.code)).toContain('LEDGER_PNL_MISMATCH');
    rmSync(dir, { recursive: true, force: true });
  });
});
