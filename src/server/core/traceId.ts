import crypto from 'crypto';
import { tracingConfig } from '../config/tracing';

/** Format: trace_<SYMBOL>_<UNIX_SEC>_<HEX4> e.g. trace_AAPL_1723891200_a3f9 */
export function generateTraceId(symbol: string): string {
  const normalized = String(symbol || 'UNKNOWN')
    .toUpperCase()
    .replace(/[^A-Z0-9._-]/g, '')
    .slice(0, 16) || 'UNKNOWN';
  const unixSec = Math.floor(Date.now() / 1000);
  const hex4 = crypto.randomBytes(2).toString('hex');
  return `${tracingConfig.traceIdPrefix}_${normalized}_${unixSec}_${hex4}`;
}

export function isFormattedTraceId(traceId: string): boolean {
  return new RegExp(`^${tracingConfig.traceIdPrefix}_[A-Z0-9._-]+_\\d+_[0-9a-f]{4}$`, 'i').test(traceId);
}
