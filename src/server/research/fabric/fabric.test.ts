import { describe, expect, it } from 'vitest';
import { validatePointInTime, filterPacketToPointInTime } from './PITGuardrail';
import { normalizeFinceptPacket } from './FinceptResearchAdapter';
import { normalizeAutoHedgeSignal } from './AutoHedgeSignalAdapter';
import type { ResearchPacket } from './types';

describe('research fabric PIT + adapters', () => {
  it('rejects metrics with publicReleaseDate after the bar', () => {
    const packet: ResearchPacket = {
      provider: 'FINCEPT',
      category: 'MACRO',
      symbol: 'SPY',
      title: 't',
      trust: 'UNTRUSTED_READONLY',
      canPlaceOrders: false,
      ingestedAt: 200,
      metrics: [
        { key: 'ok', value: 1, publicReleaseDate: 100 },
        { key: 'leak', value: 2, publicReleaseDate: 300 },
      ],
    };
    const v = validatePointInTime(packet, 200);
    expect(v.ok).toBe(false);
    expect(v.rejectedMetrics.map((r) => r.key)).toEqual(['leak']);
    expect(filterPacketToPointInTime(packet, 200).metrics.map((m) => m.key)).toEqual(['ok']);
  });

  it('Fincept normalize requires publicReleaseDate', () => {
    expect(() => normalizeFinceptPacket({ metrics: [{ key: 'x', value: 1, publicReleaseDate: undefined as any }] })).toThrow(/publicReleaseDate/);
    const p = normalizeFinceptPacket({
      symbol: 'AAPL',
      category: 'FUNDAMENTAL',
      metrics: [{ key: 'pe', value: 20, publicReleaseDate: '2020-01-15T00:00:00Z' }],
    });
    expect(p.canPlaceOrders).toBe(false);
    expect(p.trust).toBe('UNTRUSTED_READONLY');
    expect(p.metrics[0].publicReleaseDate).toBeGreaterThan(0);
  });

  it('AutoHedge strips wallet fields and stays EXTERNAL_THESIS', () => {
    const p = normalizeAutoHedgeSignal({
      symbol: 'NVDA',
      thesis: 'hedge idea',
      sideHint: 'BUY',
      confidence: 0.6,
      publicReleaseDate: 1_700_000_000_000,
      walletKey: 'SHOULD_NOT_APPEAR',
      privateKey: 'SHOULD_NOT_APPEAR',
    });
    expect(p.category).toBe('EXTERNAL_THESIS');
    expect(p.canPlaceOrders).toBe(false);
    expect(JSON.stringify(p)).not.toContain('SHOULD_NOT_APPEAR');
  });
});
