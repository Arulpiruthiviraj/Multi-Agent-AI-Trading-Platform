/**
 * Historical AI consensus replay is UNTESTABLE in this codebase: there is no point-in-time
 * news/fundamental/LLM corpus. Calling today's models on 2022 bars would be look-ahead / leakage.
 */
export interface AiReplayAvailability {
  available: false;
  status: 'UNAVAILABLE';
  what: string;
  why: string;
  impact: string;
  tradingImpact: string;
  fix: string;
  severity: 'WARNING';
  lookaheadRisk: string;
  alternative: string;
}

export function aiHistoricalReplayAvailability(): AiReplayAvailability {
  return {
    available: false,
    status: 'UNAVAILABLE',
    what: 'Historical AI consensus replay (News, Fundamental, Macro, Chronos, Kronos, Ollama, ChiefTrader debate)',
    why: 'This database has no point-in-time news articles, fundamental snapshots, or LLM outputs for past years. Live agent_predictions only exist from the current process lifetime.',
    impact: 'Argus cannot reconstruct which models voted BUY/SELL/HOLD at simulated time T without fabricating or leaking future knowledge.',
    tradingImpact: 'Does not block live/paper trading. Research replay of AI consensus is disabled rather than faked.',
    fix: 'Keep recording agent_predictions and prediction_outcomes on the live/paper path. A licensed point-in-time news/fundamentals feed would be required before any historical AI backtest.',
    severity: 'WARNING',
    lookaheadRisk: 'Invoking current cloud/local LLMs inside a 2022 ReplayClock loop would use 2026 weights and possibly information that did not exist at T.',
    alternative: 'Use QUANT_STRATEGY mode: BacktestEngine.runStrategyBacktest() with ReplayClock on real OHLCV only.',
  };
}
