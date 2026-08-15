/**
 * ==========================================================
 * Module: config/noTradeReasons
 *
 * Purpose:
 * First-class NO_TRADE catalog (config/noTradeReasons.json). Codes are stable for journals/UI.
 * assembleTradeThesis uses reasons[0] as the default when side is HOLD or no evaluation exists.
 * Listing a reason here does not submit orders and does not bypass RiskEngine.
 * ==========================================================
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface NoTradeReason {
  code: string;
  label: string;
}

export interface NoTradeReasonsConfig {
  reasons: NoTradeReason[];
}

function loadNoTradeReasons(): NoTradeReasonsConfig {
  const raw = loadRepoConfigJson<NoTradeReasonsConfig>('noTradeReasons.json');
  if (!Array.isArray(raw.reasons) || raw.reasons.length === 0) {
    throw new Error('config/noTradeReasons.json missing reasons[]');
  }
  for (const r of raw.reasons) {
    if (typeof r.code !== 'string' || typeof r.label !== 'string') {
      throw new Error('config/noTradeReasons.json each reason needs code and label');
    }
  }
  return raw;
}

export const noTradeReasonsConfig: NoTradeReasonsConfig = loadNoTradeReasons();

export function noTradeReasonByCode(code: string): NoTradeReason | undefined {
  return noTradeReasonsConfig.reasons.find(r => r.code === code);
}
