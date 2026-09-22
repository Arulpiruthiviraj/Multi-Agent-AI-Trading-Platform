/**
 * ARGUS Crypto V2 - synthetic market event injector (2026-09-21). Schedules and applies data-
 * quality / market-structure fault events onto an already-generated bar series. Deterministic
 * given a seed. This module only PRODUCES faulty/stressful data - it does not itself assert that
 * any downstream Argus component handles it safely; that verification belongs to whatever
 * consumer feeds these bars through the real pipeline (a real, separate, not-yet-built
 * integration this session did not complete - see the final report).
 */
import { SyntheticRandom } from '../../replay/synthetic/SyntheticRandom';
import type { SyntheticCryptoBar } from './SyntheticCryptoPriceProcess';

export type SyntheticMarketEventType =
  | 'FLASH_CRASH'
  | 'FLASH_PUMP'
  | 'GAP'
  | 'VOLATILITY_SPIKE'
  | 'VOLUME_SPIKE'
  | 'STALE_QUOTE'
  | 'MISSING_BARS'
  | 'DUPLICATE_BARS'
  | 'OUT_OF_ORDER_BARS'
  | 'PRICE_FREEZE';

export interface SyntheticMarketEvent {
  eventId: string;
  assetSymbol: string;
  startBarIndex: number;
  durationBars: number;
  type: SyntheticMarketEventType;
  /** 0..1 - scales the magnitude of the event's effect (a mild vs. severe flash crash, etc). */
  severity: number;
  seed: number;
}

let eventCounter = 0;

export function scheduleEvent(
  rng: SyntheticRandom,
  assetSymbol: string,
  type: SyntheticMarketEventType,
  totalBars: number,
  durationBars: number,
): SyntheticMarketEvent {
  const maxStart = Math.max(0, totalBars - durationBars - 1);
  return {
    eventId: `evt-${++eventCounter}-${type.toLowerCase()}`,
    assetSymbol,
    startBarIndex: rng.intRange(0, maxStart),
    durationBars,
    type,
    severity: rng.range(0.3, 1.0),
    seed: Math.floor(rng.next() * 2 ** 31),
  };
}

/**
 * Applies `event` to `bars` (a full, already-generated series for one asset) and returns a NEW
 * array - never mutates the input, so a caller can compare healthy-vs-faulted data side by side.
 * Bar objects outside the event's window are returned by reference (unchanged); bars inside the
 * window are replaced with corrupted/distorted copies appropriate to the event type.
 */
export function applyEventToBars(bars: readonly SyntheticCryptoBar[], event: SyntheticMarketEvent): SyntheticCryptoBar[] {
  const start = event.startBarIndex;
  const end = Math.min(start + event.durationBars, bars.length);
  if (start >= bars.length) return bars.slice();

  switch (event.type) {
    case 'FLASH_CRASH':
    case 'FLASH_PUMP': {
      const direction = event.type === 'FLASH_CRASH' ? -1 : 1;
      const magnitude = 0.15 + event.severity * 0.5; // 15%-65% move across the window
      const out = bars.slice();
      for (let i = start; i < end; i++) {
        const factor = 1 + direction * magnitude * ((i - start + 1) / (end - start));
        const b = out[i];
        out[i] = { ...b, open: b.open * factor, high: b.high * factor, low: b.low * factor, close: b.close * factor };
      }
      return out;
    }
    case 'GAP': {
      const magnitude = 0.05 + event.severity * 0.25;
      const direction = event.severity > 0.5 ? 1 : -1;
      const out = bars.slice();
      for (let i = start; i < bars.length; i++) {
        const factor = 1 + direction * magnitude;
        const b = out[i];
        out[i] = { ...b, open: b.open * factor, high: b.high * factor, low: b.low * factor, close: b.close * factor };
      }
      return out;
    }
    case 'VOLATILITY_SPIKE': {
      const out = bars.slice();
      const multiplier = 1 + event.severity * 8;
      for (let i = start; i < end; i++) {
        const b = out[i];
        const mid = (b.high + b.low) / 2;
        const halfRange = ((b.high - b.low) / 2) * multiplier;
        out[i] = { ...b, high: mid + halfRange, low: Math.max(mid - halfRange, 1e-9) };
      }
      return out;
    }
    case 'VOLUME_SPIKE': {
      const out = bars.slice();
      const multiplier = 1 + event.severity * 20;
      for (let i = start; i < end; i++) {
        out[i] = { ...out[i], volume: out[i].volume * multiplier };
      }
      return out;
    }
    case 'STALE_QUOTE':
    case 'PRICE_FREEZE': {
      const out = bars.slice();
      const frozen = bars[start];
      for (let i = start; i < end; i++) {
        out[i] = { ...frozen, barIndex: out[i].barIndex, timestampMs: out[i].timestampMs, volume: 0 };
      }
      return out;
    }
    case 'MISSING_BARS': {
      return bars.filter((b, i) => i < start || i >= end);
    }
    case 'DUPLICATE_BARS': {
      const out = bars.slice(0, start + 1);
      out.push(bars[start]); // literal duplicate of the same bar, same timestamp
      out.push(...bars.slice(start + 1));
      return out;
    }
    case 'OUT_OF_ORDER_BARS': {
      if (end - 1 <= start) return bars.slice();
      const out = bars.slice();
      const tmp = out[start];
      out[start] = out[end - 1];
      out[end - 1] = tmp;
      return out;
    }
    default:
      return bars.slice();
  }
}
