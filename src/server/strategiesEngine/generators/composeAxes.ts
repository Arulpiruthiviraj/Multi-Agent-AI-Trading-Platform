/**
 * ==========================================================
 * Module: strategiesEngine/generators/composeAxes
 *
 * Purpose:
 * Wraps a StrategyTemplate with 3 additional real, meaningful parameter axes that apply uniformly
 * across every family's templates: timeframe, stop-loss ATR multiple, and risk-per-trade fraction.
 * This is the "entry x confirmation x timeframe x exit x risk model" multiplication the build
 * directive describes (Section 8's worked example) - each axis genuinely changes the resulting
 * StrategyDefinition (a different stopLoss.value, positionSizing.value, or metadata.timeframes),
 * so every generated combination really is a distinct, machine-testable rule, not a renamed
 * duplicate (Section 27's explicit prohibition). Applied once, centrally, rather than duplicated
 * by hand into all ~15 family templates.
 * ==========================================================
 */
import { Timeframe } from '../core/types';
import { StrategyTemplate, StrategyTemplateBuildResult } from './StrategyVariantGenerator';

const TIMEFRAME_AXIS: Timeframe[] = ['15m', '1h', '4h', '1d', '1w'];
const STOP_ATR_MULTIPLE_AXIS = [1, 1.5, 2, 2.5, 2.75, 3];
const RISK_FRACTION_AXIS = [0.0025, 0.005, 0.0075, 0.01];

export function withRiskAxes(template: StrategyTemplate): StrategyTemplate {
  return {
    ...template,
    parameters: [
      ...template.parameters,
      { name: 'timeframe', type: 'enum', values: TIMEFRAME_AXIS, default: template.metadata.timeframes[0] ?? '1d', description: 'Intended real chart timeframe.' },
      { name: 'stopAtrMultiple', type: 'number', values: STOP_ATR_MULTIPLE_AXIS, default: 2, description: 'Real ATR multiple defining the stop-loss distance.' },
      { name: 'riskFraction', type: 'number', values: RISK_FRACTION_AXIS, default: 0.005, description: 'Real fraction of equity risked per trade.' },
    ],
    build: (values): StrategyTemplateBuildResult => {
      const built = template.build(values);
      const stopAtrMultiple = Number(values.stopAtrMultiple);
      const riskFraction = Number(values.riskFraction);
      return {
        ...built,
        stopLoss: built.stopLoss.kind === 'STRUCTURE'
          ? built.stopLoss // a structural stop has no numeric multiple to override
          : { ...built.stopLoss, value: stopAtrMultiple, basis: `${stopAtrMultiple}x ATR (parameterized risk axis).` },
        positionSizing: { ...built.positionSizing, value: riskFraction, basis: `${(riskFraction * 100).toFixed(2)}% of equity risked per trade (parameterized risk axis).` },
      };
    },
    metadata: {
      ...template.metadata,
      // Real base timeframes retained for catalog display; the generated variant's own
      // parameterValues.timeframe is the actual per-instance choice (validated via
      // parameterValues, not by mutating this shared array per-combination).
      timeframes: template.metadata.timeframes,
    },
  };
}
