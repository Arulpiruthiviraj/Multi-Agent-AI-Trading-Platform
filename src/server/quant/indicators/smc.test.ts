import { describe, it, expect } from 'vitest';
import { Bar } from '../../engines/backtest/HistoricalDataGateway';
import {
  detectFairValueGap,
  detectDisplacement,
  detectLiquidity,
  detectLiquiditySweep,
  computeSmcFeatures,
} from './smc';
import { detectSwingPoints } from './trend';
import { smcConfluence } from '../../config/smcConfluence';

function bar(i: number, open: number, high: number, low: number, close: number, volume = 1000): Bar {
  return { timestamp: i * 86_400_000, open, high, low, close, volume };
}

describe('indicators/smc', () => {
  it('loads confluence weights that sum to 100', () => {
    const sum =
      smcConfluence.liquidityIdentified +
      smcConfluence.liquiditySwept +
      smcConfluence.chochConfirmed +
      smcConfluence.displacement +
      smcConfluence.orderBlock +
      smcConfluence.fvg +
      smcConfluence.volumeConfirmation +
      smcConfluence.regimeAlignment;
    expect(sum).toBe(100);
  });

  it('detects a 3-candle bullish FVG without treating it as a trade', () => {
    const bars = [
      bar(0, 100, 101, 99, 100),
      bar(1, 102, 130, 102, 128),
      bar(2, 120, 125, 111, 120),
    ];
    const fvg = detectFairValueGap(bars, 106);
    expect(fvg.side).toBe('BULLISH');
    expect(fvg.low).toBe(101);
    expect(fvg.high).toBe(111);
    expect(fvg.overlappingPrice).toBe(true);
    expect(fvg.filled).toBe(false);
  });

  it('detects displacement when the last bar range exceeds the configured multiple of prior average range', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 10; i++) bars.push(bar(i, 100, 101, 99, 100));
    bars.push(bar(10, 100, 110, 99, 109));
    const d = detectDisplacement(bars, 10);
    expect(d.present).toBe(true);
    expect(d.direction).toBe('UP');
    expect(d.rangeMultiple).toBeGreaterThanOrEqual(smcConfluence.displacementRangeMultiple);
  });

  it('classifies a buy-side liquidity sweep as a feature, never a trade signal', () => {
    const bars: Bar[] = [];
    for (let i = 0; i <= 5; i++) bars.push(bar(i, 100 - i, 101 - i, 99 - i, 100 - i));
    for (let i = 6; i <= 8; i++) bars.push(bar(i, 94 + (i - 5) * 4, 96 + (i - 5) * 4, 93 + (i - 5) * 4, 95 + (i - 5) * 4));
    // Unique swing high around index 8, then quiet bars, then a wick above that high that closes back below.
    bars.push(bar(9, 108, 109, 104, 105));
    bars.push(bar(10, 105, 106, 103, 104));
    bars.push(bar(11, 104, 105, 102, 103));
    const swings = detectSwingPoints(bars, 2);
    const highs = swings.filter(s => s.type === 'high');
    expect(highs.length).toBeGreaterThan(0);
    const liquidity = detectLiquidity(bars, swings);
    expect(liquidity.buySide).not.toBeNull();
    const peak = liquidity.buySide!.price;
    bars.push(bar(12, 103, peak + 3, 101, peak - 2));
    const sweep = detectLiquiditySweep(bars, detectLiquidity(bars));
    expect(sweep.kind).toBe('BUY_SIDE_SWEPT');
    expect(sweep.isTradeSignal).toBe(false);
    expect(sweep.closedBackInside).toBe(true);
  });

  it('does not label a close-and-hold breakout as a sweep', () => {
    const bars: Bar[] = [];
    for (let i = 0; i < 15; i++) bars.push(bar(i, 100 + i, 101 + i, 99 + i, 100 + i));
    const liquidity = detectLiquidity(bars);
    const sweep = detectLiquiditySweep(bars, liquidity);
    expect(sweep.kind).toBe('NONE');
  });

  it('marks trap patterns as not intentional manipulation', () => {
    const bars: Bar[] = Array.from({ length: 8 }, (_, i) => bar(i, 100, 101, 99, 100));
    const features = computeSmcFeatures(bars);
    expect(features.trap.isIntentionalManipulation).toBe(false);
    expect(features.sweep.isTradeSignal).toBe(false);
  });
});
