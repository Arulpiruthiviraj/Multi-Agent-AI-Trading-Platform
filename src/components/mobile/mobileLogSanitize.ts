/** Strip ANSI escape sequences from server console lines for mobile terminal display. */
export function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, '').replace(/\u001b\[[0-9;]*m/g, '');
}

/** Dev/HMR noise that clutters the mobile ops terminal without operational value. */
export function isDevNoiseLogLine(text: string): boolean {
  const plain = stripAnsi(text);
  if (/\[vite\]/i.test(plain)) return true;
  if (/\[BABEL\]/i.test(plain)) return true;
  if (/hmr update/i.test(plain)) return true;
  if (/page reload/i.test(plain) && /vite|hmr/i.test(plain)) return true;
  return false;
}

/** Collapse verbose stack traces to a single operational line in the mobile log feed. */
export function compactLogLine(text: string): string {
  let plain = stripAnsi(text).trim();
  if (!plain.includes('\n')) return plain;
  const first = plain.split('\n').map((l) => l.trim()).find(Boolean) ?? plain;
  if (/^\s*at\s/.test(plain.split('\n')[1]?.trim() ?? '')) {
    return `${first} (stack truncated)`;
  }
  return first;
}

export type MobileLogFilter = 'ALL' | 'TRADES' | 'AI_DECISIONS' | 'RISK_REJECTS' | 'SYSTEM_ERRORS' | 'SCRIPT_OUTPUT';

export function matchesMobileLogFilter(text: string, level: string, category: string, filter: MobileLogFilter): boolean {
  const plain = stripAnsi(text);
  switch (filter) {
    case 'TRADES':
      return /\b(TRADE|ORDER|FILL|POSITION|OMS|EXECUTED|AUTOBOT)\b|ORDER_EXECUTED/i.test(plain);
    case 'AI_DECISIONS':
      return /\b(AIRouter|NewsAgent|Chief|Consensus|Gemini|QuantSignal|MarketRegime|LLM)\b/i.test(plain);
    case 'RISK_REJECTS':
      return /\b(RISK|RiskEngine|CIRCUIT|veto|emergency|TRADING_PAUSED|EMERGENCY_STOP|GlobalErrorHandlers)\b/i.test(plain);
    case 'SYSTEM_ERRORS':
      return level === 'error' || category === 'ERROR' || /\b(Error:|TypeError|unhandledRejection|Failed to fetch)\b/i.test(plain);
    case 'SCRIPT_OUTPUT':
      return category === 'SCRIPT';
    default:
      return !isDevNoiseLogLine(plain);
  }
}
