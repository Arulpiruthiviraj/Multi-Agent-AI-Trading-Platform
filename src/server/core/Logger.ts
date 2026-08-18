/**
 * Legacy JSONL file logger. Fail-open: disk errors never throw to trading callers.
 */
import fs from 'fs';
import path from 'path';
import { observeSafe, structuredLogger } from '../observability/StructuredLogger';
import { redactSecretsDeep } from './SecretRedaction';
import { observabilityConfig } from '../config/observability';

const logsDir = path.resolve(process.cwd(), 'logs');

// Real gap found by the 2026-08-18 observability program (Phase 14/15 - "log rotation"): these
// legacy JSONL files (trades.json, ai-decisions.json, event-traces.json) had no size cap and grew
// forever - a genuinely long-running process could eventually fill disk. Classic logrotate scheme
// (file -> file.1 -> file.2 -> ... -> file.N, oldest dropped) checked before each append, never
// mid-write, so a single record is never split across two files.
function rotateIfNeeded(file: string): void {
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {
    return; // file does not exist yet - nothing to rotate
  }
  if (size < observabilityConfig.legacyJsonlMaxBytes) return;

  const maxBackups = observabilityConfig.legacyJsonlMaxBackups;
  const oldest = `${file}.${maxBackups}`;
  if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
  for (let n = maxBackups - 1; n >= 1; n--) {
    const src = `${file}.${n}`;
    if (fs.existsSync(src)) fs.renameSync(src, `${file}.${n + 1}`);
  }
  fs.renameSync(file, `${file}.1`);
}

function appendJsonl(fileName: string, record: unknown): void {
  try {
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const file = path.join(logsDir, fileName);
    rotateIfNeeded(file);
    const safe = redactSecretsDeep({ timestamp: new Date().toISOString(), ...(record as object) });
    fs.appendFileSync(file, JSON.stringify(safe) + '\n');
  } catch (e) {
    console.error(`[Logger] Failed to append ${fileName}`, e);
  }
}

export const logTrade = (trade: any) => {
  appendJsonl('trades.json', trade);
  observeSafe(() => structuredLogger.info('legacy_log_trade', {
    category: 'ORDER',
    component: 'Logger',
    symbol: trade?.symbol,
    traceId: trade?.traceId,
    orderId: trade?.id,
  }));
};

export const logAiDecision = (decision: any) => {
  appendJsonl('ai-decisions.json', decision);
  observeSafe(() => structuredLogger.info('legacy_log_ai_decision', { category: 'AI', component: 'Logger' }));
};

export const logEventTrace = (trace: any) => {
  appendJsonl('event-traces.json', trace);
  observeSafe(() => structuredLogger.debug('legacy_log_event_trace', { category: 'TRACE', component: 'Logger' }));
};
