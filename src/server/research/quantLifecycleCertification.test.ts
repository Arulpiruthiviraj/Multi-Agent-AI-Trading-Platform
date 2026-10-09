import { afterAll, beforeAll, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { researchSafety } from '../config/researchSafety';

// Certification workflow fixture only, NON_ORGANIC; no claim of strategy edge or execution E2E.
const { detail } = vi.hoisted(() => ({ detail: vi.fn() }));
vi.mock('./strategyEvidence', () => ({ strategyEvidenceDetail: detail }));
const folder = mkdtempSync(join(tmpdir(), 'argus-certification-'));
let service: typeof import('./quantLifecycleCertification');
let eligibility: typeof import('../quant/strategies/StrategyEmissionEligibility');
let dbModule: typeof import('../db');
let schema: typeof import('../db/schema');
const id = researchSafety.coreStrategyIds[0];
const safe = () => ({ paperOnly: true, mode: 'PAPER', state: 'TRADING_PAUSED', autobot: false });

beforeAll(async () => {
  process.env.ARGUS_DB_PATH = join(folder, 'isolated.db');
  dbModule = await import('../db');
  schema = await import('../db/schema');
  eligibility = await import('../quant/strategies/StrategyEmissionEligibility');
  service = await import('./quantLifecycleCertification');
});
afterEach(() => {
  service.quantCertificationConfig.enabled = false;
  dbModule.db.delete(schema.trades).run();
  dbModule.db.delete(schema.fills).run();
  dbModule.db.delete(schema.learningVersions).run();
  detail.mockReset();
});
afterAll(() => { dbModule.sqliteDb.close(); delete process.env.ARGUS_DB_PATH; rmSync(folder, { recursive: true }); });

function researchPassed() {
  detail.mockReturnValue({ evaluated: true, lifecycleStatus: 'VALIDATED', evidence: { datasetId: 'CERTIFICATION_FIXTURE_ONLY' } });
}
async function seedLedger() {
  const n = Math.max(researchSafety.minPaperTrades, researchSafety.minPaperCalendarDays, researchSafety.minPaperSessions);
  for (let i = 0; i < n; i++) {
    dbModule.db.insert(schema.trades).values({
    id: `fixture-${i}`, symbol: 'SPY', side: 'SELL', quantity: 1, price: 100,
    status: 'FILLED', timestamp: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
    executionEnvironment: 'PAPER', quantStrategyId: id, profitLoss: i % 4 === 0 ? -1 : 3,
    }).run();
    dbModule.db.insert(schema.fills).values({ orderId: `fixture-${i}`, quantity: 1, cumulativeQuantity: 1,
      price: 100, filledAt: new Date(Date.UTC(2026, 0, i + 1)).toISOString(), realizedPnl: i % 4 === 0 ? -1 : 3 }).run();
  }
}
it('cannot write when disabled, even with a review hash', async () => {
  await expect(service.commitQuantCertification(id, 'anything', 'operator', 'reviewed', safe)).rejects.toThrow('DISABLED');
  expect(await eligibility.hasStrategyLifecycleRecord(id)).toBe(false);
});
it('does not substitute pooled or simulated paper trades for strategy-specific organic evidence', async () => {
  researchPassed();
  await seedLedger();
  dbModule.db.update(schema.trades).set({ executionEnvironment: 'SIMULATION' }).run();
  const review = await service.reviewQuantCertification(id);
  expect(review.eligibleForReview).toBe(false);
  expect(review.reasons).toContain('INSUFFICIENT_STRATEGY_ORGANIC_PAPER_TRADES');
  expect(await eligibility.hasStrategyLifecycleRecord(id)).toBe(false);
});
it('requires a paused PAPER environment, rejects stale evidence, and appends through the canonical writer', async () => {
  researchPassed(); await seedLedger(); service.quantCertificationConfig.enabled = true;
  const review = await service.reviewQuantCertification(id);
  expect(review.eligibleForReview).toBe(true);
  await expect(service.commitQuantCertification(id, review.reviewHash, 'operator', 'reviewed', () => ({ ...safe(), mode: 'LIVE' }))).rejects.toThrow('PAUSED_PAPER');
  await expect(service.commitQuantCertification(id, 'stale', 'operator', 'reviewed', safe)).rejects.toThrow('STALE');
  const transitionId = await service.commitQuantCertification(id, review.reviewHash, 'operator', 'reviewed fixture only', safe);
  expect(await eligibility.getStrategyLifecycleStatus(id)).toBe('VALIDATED');
  expect((await eligibility.getStrategyLifecycleHistory(id))[0].id).toBe(transitionId);
  await expect(service.commitQuantCertification(id, review.reviewHash, 'operator', 'repeat', safe)).rejects.toThrow('STALE');
});
it('never un-retires a strategy through certification, and detects concurrent lifecycle review changes', async () => {
  researchPassed(); await seedLedger();
  await eligibility.recordStrategyLifecycleTransition(id, 'RETIRED', 'negative evidence', null, 0);
  expect((await service.reviewQuantCertification(id)).reasons).toContain('QUARANTINED_REQUIRES_SEPARATE_RECERTIFICATION');
  await expect(eligibility.recordStrategyLifecycleTransition(id, 'VALIDATED', 'stale review', null, 0, new Date(), null)).rejects.toThrow('LIFECYCLE_REVIEW_STALE');
  expect(await eligibility.getStrategyLifecycleStatus(id)).toBe('RETIRED');
});
it('rejects nominal FILLED ledger rows with no supported closing fill economics', async () => {
  researchPassed(); await seedLedger();
  dbModule.db.delete(schema.fills).run();
  const review = await service.reviewQuantCertification(id);
  expect(review.reasons).toContain('ORGANIC_LEDGER_WITHOUT_CLOSING_FILL_ECONOMICS');
  expect(review.eligibleForReview).toBe(false);
});
