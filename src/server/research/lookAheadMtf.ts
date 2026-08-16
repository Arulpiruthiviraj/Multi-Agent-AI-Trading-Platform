/**
 * Higher-timeframe features may only be used after that candle has closed.
 */
export interface TimestampedFeature {
  name: string;
  calculationTimestamp: number;
  availabilityTimestamp: number;
}

export function featureUsableAt(feature: TimestampedFeature, decisionTimestamp: number): boolean {
  return feature.availabilityTimestamp <= decisionTimestamp;
}

/** Daily bar with session date D is available only after its close timestamp. */
export function dailyBarAvailability(dailyBarOpenMs: number, sessionCloseMs: number): TimestampedFeature {
  return {
    name: 'daily_ohlc',
    calculationTimestamp: dailyBarOpenMs,
    availabilityTimestamp: sessionCloseMs,
  };
}

export function rejectUnclosedDailyInIntraday(opts: {
  decisionTimestamp: number;
  dailyBarOpenMs: number;
  dailyBarCloseMs: number;
}): 'OK' | 'LOOKAHEAD_DETECTED' {
  const f = dailyBarAvailability(opts.dailyBarOpenMs, opts.dailyBarCloseMs);
  return featureUsableAt(f, opts.decisionTimestamp) ? 'OK' : 'LOOKAHEAD_DETECTED';
}
