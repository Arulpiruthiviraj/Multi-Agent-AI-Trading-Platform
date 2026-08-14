import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { eq } from 'drizzle-orm';

/**
 * Real integration test (isolated temp SQLite DB, real EventBus singleton, no per-module mocks)
 * for the P1 fix to a real, self-introduced bug: `transactions.status` never reached a terminal
 * state after mint time. Drives the tracker purely through real EventBus emissions (not direct
 * function calls), the same way the real pipeline actually reaches it.
 */
describe('TransactionLifecycleTracker (P1 - transactions.status terminal-state fix)', () => {
  let tmpDbPath: string;
  let db: any;
  let sqliteDb: any;
  let schema: any;
  let eventBus: any;
  let recordConsensusTransaction: any;

  beforeAll(async () => {
    tmpDbPath = path.join(os.tmpdir(), `argus_txlifecycle_${Date.now()}_${process.pid}.db`);
    process.env.ARGUS_DB_PATH = tmpDbPath;

    ({ db, sqliteDb } = await import('../db'));
    schema = await import('../db/schema');
    ({ eventBus } = await import('../core/EventBus'));
    ({ recordConsensusTransaction } = await import('../core/TransactionRegistry'));
    await import('./TransactionLifecycleTracker'); // registers the real listeners under test
  });

  afterAll(() => {
    try { sqliteDb.close(); } catch { /* already closed */ }
    for (const suffix of ['', '-shm', '-wal']) {
      try { fs.unlinkSync(tmpDbPath + suffix); } catch { /* best-effort cleanup */ }
    }
    delete process.env.ARGUS_DB_PATH;
  });

  async function getTxn(id: string) {
    const [row] = await db.select().from(schema.transactions).where(eq(schema.transactions.id, id));
    return row;
  }

  it('moves OPEN -> RISK_REJECTED (closed, outcome N_A) on a real RISK_ASSESSMENT_COMPLETED rejection', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'AAPL', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    expect((await getTxn(id)).status).toBe('OPEN');

    eventBus.emit('RISK_ASSESSMENT_COMPLETED', { transactionId: id, approved: false, reasoning: 'daily loss limit' });
    await new Promise(r => setTimeout(r, 20)); // listener runs an async DB write

    const txn = await getTxn(id);
    expect(txn.status).toBe('RISK_REJECTED');
    expect(txn.outcome).toBe('N_A');
    expect(txn.closedAt).not.toBeNull();
  });

  it('does not touch the transaction on a risk APPROVAL - only the order stages close it', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'MSFT', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });

    eventBus.emit('RISK_ASSESSMENT_COMPLETED', { transactionId: id, approved: true, maxQuantity: 10 });
    await new Promise(r => setTimeout(r, 20));

    expect((await getTxn(id)).status).toBe('OPEN'); // unchanged - real bug fix, not a fabricated transition
  });

  it('moves OPEN -> EXECUTED on ORDER_SUBMITTED, then -> FILLED (closed, outcome WIN) on a real profitable ORDER_EXECUTED', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'NVDA', side: 'SELL', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });

    eventBus.emit('ORDER_SUBMITTED', { transactionId: id, id: 'ord-1', symbol: 'NVDA' });
    await new Promise(r => setTimeout(r, 20));
    expect((await getTxn(id)).status).toBe('EXECUTED');

    eventBus.emit('ORDER_EXECUTED', { transactionId: id, id: 'ord-1', symbol: 'NVDA', status: 'FILLED', profitLoss: 42.5 });
    await new Promise(r => setTimeout(r, 20));

    const txn = await getTxn(id);
    expect(txn.status).toBe('FILLED');
    expect(txn.outcome).toBe('WIN');
    expect(txn.closedAt).not.toBeNull();
  });

  it('records a losing FILLED SELL as outcome LOSS', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'TSLA', side: 'SELL', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    eventBus.emit('ORDER_EXECUTED', { transactionId: id, status: 'FILLED', profitLoss: -12 });
    await new Promise(r => setTimeout(r, 20));
    expect((await getTxn(id)).outcome).toBe('LOSS');
  });

  it('records a filled BUY (no realized P&L yet) as outcome PENDING, not a fabricated WIN/LOSS', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'AMD', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    eventBus.emit('ORDER_EXECUTED', { transactionId: id, status: 'FILLED' }); // no profitLoss field - matches a real BUY fill
    await new Promise(r => setTimeout(r, 20));
    const txn = await getTxn(id);
    expect(txn.status).toBe('FILLED');
    expect(txn.outcome).toBe('PENDING');
  });

  it('moves to ORDER_REJECTED (closed, outcome N_A) when the broker rejects the order after risk approval', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'AMZN', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    eventBus.emit('ORDER_EXECUTED', { transactionId: id, status: 'REJECTED' });
    await new Promise(r => setTimeout(r, 20));
    const txn = await getTxn(id);
    expect(txn.status).toBe('ORDER_REJECTED');
    expect(txn.outcome).toBe('N_A');
    expect(txn.closedAt).not.toBeNull();
  });

  it('does not fabricate a terminal state for an order still PENDING after the poll timeout', async () => {
    const id = await recordConsensusTransaction({
      symbol: 'GOOGL', side: 'BUY', weightedConfidence: 0.8, threshold: 0.75, approved: true, evidence: [],
    });
    eventBus.emit('ORDER_SUBMITTED', { transactionId: id });
    eventBus.emit('ORDER_EXECUTED', { transactionId: id, status: 'PENDING' });
    await new Promise(r => setTimeout(r, 20));
    const txn = await getTxn(id);
    expect(txn.status).toBe('EXECUTED'); // real, honest "still in flight" - not a fabricated resolution
    expect(txn.closedAt).toBeNull();
  });

  it('ignores lifecycle events with no transactionId (e.g. legacy/simulation paths) without crashing', async () => {
    expect(() => {
      eventBus.emit('RISK_ASSESSMENT_COMPLETED', { approved: false });
      eventBus.emit('ORDER_SUBMITTED', { id: 'no-txn' });
      eventBus.emit('ORDER_EXECUTED', { id: 'no-txn', status: 'FILLED' });
    }).not.toThrow();
  });
});
