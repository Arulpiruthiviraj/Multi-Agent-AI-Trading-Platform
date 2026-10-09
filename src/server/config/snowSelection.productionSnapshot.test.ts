import { expect, it } from 'vitest';
import snapshot from './snowSelection.productionSnapshot.fixture.json';
import { selectEvaluationsForAdaptiveRegime, strategyFocusConfig } from './strategyFocus';
import { bestStrategyIdea } from '../quant/strategies/StrategyEngine';
import type { StrategyEvaluation } from '../quant/strategies/types';
import type { RegimeLabel, VolatilityLabel } from '../quant/RegimeEngine';

// Replays selection of recorded outputs only. NOT an indicator/formula/PIT input replay.
it('SNOW recorded crossover trigger does not enter the configured adaptive CORE pool', () => {
  const evaluations = snapshot.evaluations as StrategyEvaluation[];
  expect(evaluations.find(e => e.strategy === 'MA_CROSSOVER')).toMatchObject({ confidence: 1, triggerMet: true });
  const selected = selectEvaluationsForAdaptiveRegime(evaluations, strategyFocusConfig.defaultFocus,
    snapshot.regime as RegimeLabel, snapshot.volatility as VolatilityLabel);
  expect(selected.map(e => e.strategy)).not.toContain('MA_CROSSOVER');
  expect(selected.every(e => !e.triggerMet)).toBe(true);
  expect(bestStrategyIdea(selected)).toBeNull();
});
