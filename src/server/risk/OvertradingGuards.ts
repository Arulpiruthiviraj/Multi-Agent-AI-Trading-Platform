/**
 * Pure overtrading / cooldown checks used by RiskEngine.
 * Not a second kill switch. SELL/exits are never blocked here.
 */
import { tradingSafety } from '../config/tradingSafety';
import { getTradingDateStr } from '../core/TradingCalendar';

export interface OvertradeRow {
  symbol: string;
  side: string;
  status: string | null;
  timestamp?: string | null;
  filledAt?: string | null;
  profitLoss?: number | null;
}

export interface OvertradeGate {
  gate: string;
  passed: boolean;
  detail: Record<string, unknown>;
  reason: string;
}

function eventMs(row: OvertradeRow): number {
  const raw = row.filledAt || row.timestamp;
  if (!raw) return 0;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : 0;
}

function filled(row: OvertradeRow): boolean {
  return String(row.status || '').toUpperCase() === 'FILLED';
}

export function evaluateSameSymbolCooldown(input: {
  side: string;
  symbol: string;
  nowMs: number;
  trades: OvertradeRow[];
  cooldownMs?: number;
}): OvertradeGate {
  const cooldownMs = input.cooldownMs ?? tradingSafety.sameSymbolCooldownMs;
  if (input.side !== 'BUY' || cooldownMs <= 0) {
    return { gate: 'same_symbol_cooldown', passed: true, detail: { skipped: true, cooldownMs }, reason: 'n/a' };
  }
  const last = input.trades
    .filter((t) => t.symbol === input.symbol && filled(t) && eventMs(t) > 0)
    .sort((a, b) => eventMs(b) - eventMs(a))[0];
  if (!last) {
    return { gate: 'same_symbol_cooldown', passed: true, detail: { cooldownMs, lastFillMs: null }, reason: 'n/a' };
  }
  const age = input.nowMs - eventMs(last);
  const passed = age >= cooldownMs;
  return {
    gate: 'same_symbol_cooldown',
    passed,
    detail: { cooldownMs, lastFillMs: eventMs(last), ageMs: age },
    reason: passed
      ? 'n/a'
      : `COOLDOWN: last fill in ${input.symbol} was ${Math.round(age / 1000)}s ago (min ${Math.round(cooldownMs / 1000)}s).`,
  };
}

export function evaluatePostLossCooldown(input: {
  side: string;
  nowMs: number;
  trades: OvertradeRow[];
  cooldownMs?: number;
}): OvertradeGate {
  const cooldownMs = input.cooldownMs ?? tradingSafety.postLossCooldownMs;
  if (input.side !== 'BUY' || cooldownMs <= 0) {
    return { gate: 'post_loss_cooldown', passed: true, detail: { skipped: true, cooldownMs }, reason: 'n/a' };
  }
  const lastLoss = input.trades
    .filter((t) => t.side === 'SELL' && filled(t) && typeof t.profitLoss === 'number' && (t.profitLoss as number) < 0)
    .sort((a, b) => eventMs(b) - eventMs(a))[0];
  if (!lastLoss) {
    return { gate: 'post_loss_cooldown', passed: true, detail: { cooldownMs, lastLossMs: null }, reason: 'n/a' };
  }
  const age = input.nowMs - eventMs(lastLoss);
  const passed = age >= cooldownMs;
  return {
    gate: 'post_loss_cooldown',
    passed,
    detail: { cooldownMs, lastLossMs: eventMs(lastLoss), ageMs: age },
    reason: passed
      ? 'n/a'
      : `COOLDOWN: last closed loss was ${Math.round(age / 1000)}s ago (min ${Math.round(cooldownMs / 1000)}s).`,
  };
}

export function evaluateDailyTradeLimit(input: {
  side: string;
  nowMs: number;
  trades: OvertradeRow[];
  maxDailyTrades?: number;
}): OvertradeGate {
  const maxDailyTrades = input.maxDailyTrades ?? tradingSafety.maxDailyTrades;
  if (input.side !== 'BUY' || maxDailyTrades <= 0) {
    return { gate: 'daily_trade_limit', passed: true, detail: { skipped: true, maxDailyTrades }, reason: 'n/a' };
  }
  const today = getTradingDateStr(new Date(input.nowMs));
  const count = input.trades.filter((t) => {
    if (!filled(t)) return false;
    const ms = eventMs(t);
    if (!ms) return false;
    return getTradingDateStr(new Date(ms)) === today;
  }).length;
  const passed = count < maxDailyTrades;
  return {
    gate: 'daily_trade_limit',
    passed,
    detail: { maxDailyTrades, count, today },
    reason: passed
      ? 'n/a'
      : `Daily trade limit reached: ${count} FILLED trades on ${today} (cap ${maxDailyTrades}).`,
  };
}

export function evaluateDuplicateSignal(input: {
  side: string;
  symbol: string;
  nowMs: number;
  assessments: Array<{ symbol: string; side?: string; createdAt?: string; approved?: boolean | null }>;
  windowMs?: number;
}): OvertradeGate {
  const windowMs = input.windowMs ?? tradingSafety.duplicateSignalWindowMs;
  if (input.side !== 'BUY' || windowMs <= 0) {
    return { gate: 'duplicate_signal', passed: true, detail: { skipped: true, windowMs }, reason: 'n/a' };
  }
  const cutoff = input.nowMs - windowMs;
  const dup = input.assessments.filter((a) => {
    if (a.approved !== true) return false;
    if (a.symbol !== input.symbol) return false;
    if (a.side && a.side !== 'BUY') return false;
    const t = a.createdAt ? Date.parse(a.createdAt) : 0;
    return Number.isFinite(t) && t >= cutoff;
  }).length;
  const passed = dup === 0;
  return {
    gate: 'duplicate_signal',
    passed,
    detail: { windowMs, recentSameSymbolBuys: dup },
    reason: passed
      ? 'n/a'
      : `Duplicate BUY signal for ${input.symbol} within ${Math.round(windowMs / 1000)}s.`,
  };
}
