import { loadRepoConfigJson } from '../server/config/loadRepoConfigJson';

export type IbkrAccountKind = 'PAPER' | 'LIVE' | 'UNKNOWN';

interface IbkrAccountClassificationFile {
  paperAccountIdPrefixes: string[];
  liveAccountIdPrefixes: string[];
}

const catalog = loadRepoConfigJson<IbkrAccountClassificationFile>('ibkrAccountClassification.json');

function sortedPrefixes(raw: string[]): string[] {
  return [...raw].filter((p) => typeof p === 'string' && p.length > 0).sort((a, b) => b.length - a.length);
}

const PAPER_PREFIXES = sortedPrefixes(catalog.paperAccountIdPrefixes);
const LIVE_PREFIXES = sortedPrefixes(catalog.liveAccountIdPrefixes);

export function classifyIbkrAccountId(accountId: string | null | undefined): {
  kind: IbkrAccountKind;
  accountId: string | null;
  matchedPrefix: string | null;
} {
  const id = String(accountId || '').trim().toUpperCase();
  if (!id) return { kind: 'UNKNOWN', accountId: null, matchedPrefix: null };
  for (const prefix of PAPER_PREFIXES) {
    if (id.startsWith(prefix.toUpperCase())) return { kind: 'PAPER', accountId: id, matchedPrefix: prefix };
  }
  for (const prefix of LIVE_PREFIXES) {
    if (id.startsWith(prefix.toUpperCase())) return { kind: 'LIVE', accountId: id, matchedPrefix: prefix };
  }
  return { kind: 'UNKNOWN', accountId: id, matchedPrefix: null };
}

export function assertIbkrSessionAllowsOrder(opts: {
  requestedMode: 'PAPER' | 'LIVE' | null;
  accountId: string | null | undefined;
}): { ok: boolean; kind: IbkrAccountKind; reason: string } {
  if (opts.requestedMode !== 'PAPER' && opts.requestedMode !== 'LIVE') {
    return {
      ok: false,
      kind: 'UNKNOWN',
      reason: 'IBKR_SESSION_MODE_UNKNOWN: paperTrading()/liveTrading() was never applied. Fail closed.',
    };
  }
  const classified = classifyIbkrAccountId(opts.accountId);
  if (classified.kind === 'UNKNOWN') {
    return {
      ok: false,
      kind: 'UNKNOWN',
      reason: `IBKR_ACCOUNT_UNCLASSIFIED: Gateway account '${classified.accountId ?? ''}' is neither paper nor live per config/ibkrAccountClassification.json. Fail closed.`,
    };
  }
  if (opts.requestedMode === 'PAPER' && classified.kind !== 'PAPER') {
    return {
      ok: false,
      kind: classified.kind,
      reason: `IBKR_LIVE_SESSION_IN_PAPER: Argus requested PAPER but Gateway account ${classified.accountId} is ${classified.kind}. No order.`,
    };
  }
  if (opts.requestedMode === 'LIVE' && classified.kind !== 'LIVE') {
    return {
      ok: false,
      kind: classified.kind,
      reason: `IBKR_PAPER_SESSION_IN_LIVE: Argus requested LIVE but Gateway account ${classified.accountId} is ${classified.kind}. No order.`,
    };
  }
  return { ok: true, kind: classified.kind, reason: `ibkr=${classified.kind} account=${classified.accountId}` };
}
