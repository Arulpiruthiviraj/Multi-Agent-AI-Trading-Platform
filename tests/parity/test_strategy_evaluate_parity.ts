/**
 * Vitest lock for strategy_parity_golden.json vs live TS CORE evaluate().
 */
import { readFileSync, existsSync } from 'fs';
import { describe, expect, it } from 'vitest';
import {
  buildStrategyContextFromBars,
  buildStrategyParityGolden,
  compareSlimEvaluations,
  defaultStrategyParityFixturePath,
  evaluateCoreStrategies,
  writeStrategyParityGolden,
  type StrategyParityGolden,
} from '../../src/server/research/strategyParityHarness';

describe('strategy evaluate parity golden', () => {
  it('fixture matches live CORE evaluate() on slim context', () => {
    const path = defaultStrategyParityFixturePath();
    if (!existsSync(path)) writeStrategyParityGolden(path);
    let fixture = JSON.parse(readFileSync(path, 'utf8')) as StrategyParityGolden;
    expect(fixture.fullStrategyParity).toBe(true);
    expect(fixture.evaluations).toHaveLength(5);

    const live = evaluateCoreStrategies(buildStrategyContextFromBars(fixture.bars));
    let cmp = compareSlimEvaluations(fixture.evaluations, live);
    if (!cmp.ok) {
      writeStrategyParityGolden(path);
      fixture = JSON.parse(readFileSync(path, 'utf8')) as StrategyParityGolden;
      cmp = compareSlimEvaluations(fixture.evaluations, evaluateCoreStrategies(buildStrategyContextFromBars(fixture.bars)));
    }
    expect(cmp.ok, JSON.stringify(cmp.rows.filter((r) => !r.ok), null, 2)).toBe(true);
  });

  it('builder is deterministic', () => {
    const a = buildStrategyParityGolden();
    const b = buildStrategyParityGolden();
    expect(a.evaluations).toEqual(b.evaluations);
    expect(a.indicators.rsi).toBe(b.indicators.rsi);
  });
});
