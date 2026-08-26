/**
 * Safe Research & Quant Intelligence Expansion (2026-08-25) — barrel export.
 * Every module here is read-only with respect to trading. See types.ts's own header comment and
 * researchIntelligenceBoundary.test.ts for the enforced contract.
 */
export * from './types';
export * from './researchEventLog';
export * from './RegimeDetectionResearch';
export * from './RiskRewardResearch';
export * from './CorrelationResearch';
export * from './DrawdownResearch';
export * from './BacktestResearch';
export * from './WalkForwardResearch';
export * from './MultiFactorResearch';
export * from './StrategyOptimizationResearch';
export * from './MonteCarloResearch';
export * from './MacroStrategyResearch';
export * from './AlphaEdgeResearch';
export * from './StrategyGenerationResearch';
export * from './TradeSetupResearch';
