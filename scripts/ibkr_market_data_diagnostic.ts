/**
 * Read-only IBKR market-data diagnostic.
 *
 * Purpose: answer one question before paying for a consolidated-SIP subscription - does the
 * fee-waived "US Real-Time Non-Consolidated Streaming Quotes" entitlement shown in TWS/Client
 * Portal account management actually stream through the IB Gateway *API* (reqMktData), or does
 * IBKR treat off-platform API consumption differently (as their own API training material warns)?
 *
 * This script:
 *   - Opens its OWN transient IBApi connection, on a clientId distinct from Argus's own
 *     production IBKR session (never `ibkrConnection.json`'s configured clientId) - it must
 *     never collide with, kick, or interfere with a currently-running Argus engine's IBKR
 *     session, and using a different clientId is also the correct way to test whether IBKR's
 *     10197 "competing session" condition is about market-data-line contention specifically
 *     (not merely "two sockets open").
 *   - Never calls reqMarketDataType() - the whole point is to observe IBKR's OWN default
 *     behavior for this account/session, not force live or delayed.
 *   - reqMktData() for AAPL, MSFT, NVDA, SPY, QQQ (streaming, not snapshot - snapshot=false,
 *     regulatorySnapshot=false - a snapshot request can itself carry a one-time fee/entitlement
 *     path different from streaming and would answer a different question).
 *   - Records, per symbol: the marketDataType callback (1=live, 2=frozen, 3=delayed,
 *     4=delayed-frozen - see IBKR tick_types docs), BID/ASK/LAST/BID_SIZE/ASK_SIZE/LAST_SIZE
 *     (both live-field and delayed-field tick types, since a silent live->delayed downgrade is
 *     itself part of what this is testing), a timestamp for each first-seen value, and every
 *     IBKR error/warning message (code, text, reqId) with its own timestamp.
 *   - Places NO order. Calls cancelMktData() for its own 5 reqIds before disconnecting - this
 *     un-does only the ephemeral streaming requests this process itself made, never touches any
 *     persisted Argus subscription state (this script never imports IbkrSocketSession/
 *     BrokerManager, so there is none to touch).
 *   - Connects to the PAPER Gateway/TWS port only (same as Argus's own default) - paper mode
 *     still carries real market data, only fills are simulated; this script has no reason to
 *     ever touch a live port.
 *
 * Usage: npx tsx scripts/ibkr_market_data_diagnostic.ts [SYMBOL ...]
 *   (defaults to AAPL MSFT NVDA SPY QQQ if no symbols given)
 *
 * Env overrides:
 *   IBKR_DIAGNOSTIC_CLIENT_ID     - clientId for this probe's own connection (default 999)
 *   IBKR_DIAGNOSTIC_WINDOW_MS     - how long to listen for ticks/errors before disconnecting (default 15000)
 *   IBKR_DIAGNOSTIC_MARKET_DATA_TYPE - optional: 1=live 2=frozen 3=delayed 4=delayed-frozen. When set,
 *     calls reqMarketDataType() once right after connecting, before any reqMktData() call - this is a
 *     DELIBERATE deviation from "observe the default" (used to explicitly test IBKR's own delayed-data
 *     fallback path after a 10089/"Delayed market data is available" response). Left unset, the default
 *     run makes no such call and observes IBKR's un-overridden default behavior, as originally specified.
 */
import { IBApi, EventName, SecType } from '@stoqey/ib';
import type { Contract } from '@stoqey/ib';
import { loadIbkrConnection, ibkrSocketPortCandidates } from '../src/server/config/ibkrConnection';
import { findFirstOpenTcpPort } from '../src/brokers/ibkrTcpProbe';

const DEFAULT_SYMBOLS = ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ'];

// IB tick type ids (see https://interactivebrokers.github.io/tws-api/tick_types.html). Kept as
// local numeric constants (same convention IbkrSocketSession.ts already uses) rather than
// importing the library's TickType enum, since this script deliberately stays standalone.
const TICK = {
  BID_SIZE: 0, BID: 1, ASK: 2, ASK_SIZE: 3, LAST: 4, LAST_SIZE: 5,
  DELAYED_BID: 66, DELAYED_ASK: 67, DELAYED_LAST: 68,
  DELAYED_BID_SIZE: 69, DELAYED_ASK_SIZE: 70, DELAYED_LAST_SIZE: 71,
} as const;

const MARKET_DATA_TYPE_LABEL: Record<number, string> = {
  1: 'REALTIME', 2: 'FROZEN', 3: 'DELAYED', 4: 'DELAYED_FROZEN',
};

interface SymbolResult {
  symbol: string;
  tickerId: number;
  marketDataType: number | null;
  marketDataTypeLabel: string | null;
  marketDataTypeAt: string | null;
  bid: number | null; bidAt: string | null;
  ask: number | null; askAt: string | null;
  last: number | null; lastAt: string | null;
  bidSize: number | null;
  askSize: number | null;
  lastSize: number | null;
  delayedBid: number | null; delayedBidAt: string | null;
  delayedAsk: number | null; delayedAskAt: string | null;
  delayedLast: number | null; delayedLastAt: string | null;
  delayedBidSize: number | null;
  delayedAskSize: number | null;
  delayedLastSize: number | null;
  errors: Array<{ code: number; message: string; at: string }>;
}

interface ErrorLogEntry {
  reqId: number;
  symbol: string | null;
  code: number;
  message: string;
  at: string;
}

function stockContract(symbol: string): Contract {
  return { symbol: symbol.toUpperCase(), secType: SecType.STK, exchange: 'SMART', currency: 'USD' };
}

async function main(): Promise<void> {
  const symbols = (process.argv.slice(2).length > 0 ? process.argv.slice(2) : DEFAULT_SYMBOLS)
    .map((s) => s.toUpperCase());
  const windowMs = Number(process.env.IBKR_DIAGNOSTIC_WINDOW_MS) > 0
    ? Number(process.env.IBKR_DIAGNOSTIC_WINDOW_MS) : 15000;
  const clientId = Number.isInteger(Number(process.env.IBKR_DIAGNOSTIC_CLIENT_ID))
    ? Number(process.env.IBKR_DIAGNOSTIC_CLIENT_ID) : 999;

  const cfg = loadIbkrConnection();
  const ports = ibkrSocketPortCandidates(cfg, false); // paper only, never live
  console.log(`[diag] Probing ${cfg.host}:${ports.join('/')} for an open IB Gateway/TWS paper port...`);
  const openPort = await findFirstOpenTcpPort(cfg.host, ports, 1500);
  if (openPort == null) {
    console.error(
      `[diag] No IB Gateway/TWS detected on ${cfg.host}:${ports.join('/')}. ` +
      'Launch IB Gateway Desktop in Paper mode (API socket enabled) and retry.',
    );
    process.exit(1);
  }
  console.log(`[diag] Found open port ${openPort}. Connecting with clientId=${clientId} (distinct from Argus's own configured clientId=${cfg.clientId})...`);

  const results = new Map<number, SymbolResult>();
  const tickerIdToSymbol = new Map<number, string>();
  const errorLog: ErrorLogEntry[] = [];
  let nextTickerId = 5001; // arbitrary, well clear of Argus's own live-session reqId ranges

  for (const symbol of symbols) {
    const tickerId = nextTickerId++;
    tickerIdToSymbol.set(tickerId, symbol);
    results.set(tickerId, {
      symbol, tickerId,
      marketDataType: null, marketDataTypeLabel: null, marketDataTypeAt: null,
      bid: null, bidAt: null, ask: null, askAt: null, last: null, lastAt: null,
      bidSize: null, askSize: null, lastSize: null,
      delayedBid: null, delayedBidAt: null, delayedAsk: null, delayedAskAt: null,
      delayedLast: null, delayedLastAt: null,
      delayedBidSize: null, delayedAskSize: null, delayedLastSize: null,
      errors: [],
    });
  }

  const ib = new IBApi({ host: cfg.host, port: openPort, clientId });
  let connected = false;

  const connectedPromise = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), cfg.connectTimeoutMs);
    ib.once(EventName.connected, () => {
      clearTimeout(timer);
      connected = true;
      resolve(true);
    });
    ib.once(EventName.error, (err, code) => {
      // A CONNECT_FAIL-class error before 'connected' fires means the handshake itself failed
      // (e.g. clientId already in use, API not enabled) - surface it and stop waiting.
      if (!connected) {
        console.error(`[diag] Connection error before handshake completed: code=${code} ${err?.message || err}`);
      }
    });
  });

  ib.on(EventName.error, (err, code, reqId) => {
    const numCode = Number(code);
    const message = String(err?.message ?? err ?? '');
    const at = new Date().toISOString();
    const symbol = tickerIdToSymbol.get(Number(reqId)) ?? null;
    errorLog.push({ reqId: Number(reqId), symbol, code: numCode, message, at });
    const target = results.get(Number(reqId));
    if (target) target.errors.push({ code: numCode, message, at });
    console.log(`[diag] IBKR error/warning: code=${numCode} reqId=${reqId} symbol=${symbol ?? 'n/a'} msg="${message}"`);
  });

  ib.on(EventName.tickPrice, (tickerId: number, field: number, price: number) => {
    const r = results.get(tickerId);
    if (!r || !(price > 0)) return;
    const at = new Date().toISOString();
    switch (field) {
      case TICK.BID: if (r.bid === null) r.bidAt = at; r.bid = price; break;
      case TICK.ASK: if (r.ask === null) r.askAt = at; r.ask = price; break;
      case TICK.LAST: if (r.last === null) r.lastAt = at; r.last = price; break;
      case TICK.DELAYED_BID: if (r.delayedBid === null) r.delayedBidAt = at; r.delayedBid = price; break;
      case TICK.DELAYED_ASK: if (r.delayedAsk === null) r.delayedAskAt = at; r.delayedAsk = price; break;
      case TICK.DELAYED_LAST: if (r.delayedLast === null) r.delayedLastAt = at; r.delayedLast = price; break;
      default: break;
    }
  });

  ib.on(EventName.tickSize, (tickerId: number, field: number, size: number) => {
    const r = results.get(tickerId);
    if (!r) return;
    switch (field) {
      case TICK.BID_SIZE: r.bidSize = size; break;
      case TICK.ASK_SIZE: r.askSize = size; break;
      case TICK.LAST_SIZE: r.lastSize = size; break;
      case TICK.DELAYED_BID_SIZE: r.delayedBidSize = size; break;
      case TICK.DELAYED_ASK_SIZE: r.delayedAskSize = size; break;
      case TICK.DELAYED_LAST_SIZE: r.delayedLastSize = size; break;
      default: break;
    }
  });

  ib.on(EventName.marketDataType, (tickerId: number, marketDataType: number) => {
    const r = results.get(tickerId);
    if (!r) return;
    r.marketDataType = marketDataType;
    r.marketDataTypeLabel = MARKET_DATA_TYPE_LABEL[marketDataType] ?? `UNKNOWN(${marketDataType})`;
    r.marketDataTypeAt = new Date().toISOString();
    console.log(`[diag] marketDataType for ${r.symbol}: ${r.marketDataTypeLabel} (${marketDataType})`);
  });

  try {
    ib.connect();
  } catch (e: any) {
    console.error(`[diag] connect() threw: ${e?.message || e}`);
    process.exit(1);
  }

  const ok = await connectedPromise;
  if (!ok) {
    console.error('[diag] Failed to establish IBKR API connection within the timeout. No market data was requested.');
    try { ib.disconnect(); } catch { /* ignore */ }
    process.exit(1);
  }
  const mdTypeOverride = Number(process.env.IBKR_DIAGNOSTIC_MARKET_DATA_TYPE);
  if ([1, 2, 3, 4].includes(mdTypeOverride)) {
    console.log(`[diag] IBKR_DIAGNOSTIC_MARKET_DATA_TYPE=${mdTypeOverride} set - calling reqMarketDataType(${mdTypeOverride}) before subscribing (deliberate override, not default-behavior observation).`);
    try { ib.reqMarketDataType(mdTypeOverride as 1 | 2 | 3 | 4); } catch (e: any) {
      console.error(`[diag] reqMarketDataType failed: ${e?.message || e}`);
    }
  }

  console.log('[diag] Connected. Issuing reqMktData() for: ' + symbols.join(', ') + (Number.isFinite(mdTypeOverride) && [1,2,3,4].includes(mdTypeOverride) ? ` (marketDataType override=${mdTypeOverride}).` : ' (no reqMarketDataType override - observing IBKR default behavior).'));

  for (const [tickerId, symbol] of tickerIdToSymbol) {
    try {
      ib.reqMktData(tickerId, stockContract(symbol), '', false, false);
    } catch (e: any) {
      console.error(`[diag] reqMktData failed for ${symbol}: ${e?.message || e}`);
    }
  }

  console.log(`[diag] Listening for ${windowMs}ms...`);
  await new Promise((resolve) => setTimeout(resolve, windowMs));

  console.log('[diag] Window elapsed. Cancelling this probe\'s own market data requests and disconnecting (no persisted state to clean up - this script never touches Argus\'s own subscription tables).');
  for (const tickerId of tickerIdToSymbol.keys()) {
    try { ib.cancelMktData(tickerId); } catch { /* best-effort */ }
  }
  try { ib.disconnect(); } catch { /* ignore */ }

  const summary = symbols.map((s) => {
    const r = [...results.values()].find((x) => x.symbol === s)!;
    return r;
  });

  console.log('\n===== RESULTS =====');
  console.log(JSON.stringify({ host: cfg.host, port: openPort, clientId, windowMs, symbols: summary, allErrors: errorLog }, null, 2));

  console.log('\n===== VERDICT (facts only - not a certification) =====');
  for (const r of summary) {
    const gotLive = r.bid !== null || r.ask !== null || r.last !== null;
    const gotDelayed = r.delayedBid !== null || r.delayedAsk !== null || r.delayedLast !== null;
    const codes354or10089 = r.errors.filter((e) => e.code === 354 || e.code === 10089);
    const code10197 = r.errors.filter((e) => e.code === 10197);
    let verdict: string;
    if (gotLive) {
      verdict = `Received live-field BID/ASK/LAST (marketDataType=${r.marketDataTypeLabel ?? 'not received'}).`;
    } else if (gotDelayed) {
      verdict = `Received only DELAYED-field ticks (marketDataType=${r.marketDataTypeLabel ?? 'not received'}) - no live entitlement observed through the API for this symbol in this window.`;
    } else if (code10197.length > 0) {
      verdict = 'Got IBKR error 10197 (competing live session) - consistent with another active market-data session, not simply "no subscription".';
    } else if (codes354or10089.length > 0) {
      verdict = `Got IBKR error ${codes354or10089[0].code} ("${codes354or10089[0].message}") - fee-waived entitlement is likely not being honored through this API session.`;
    } else {
      verdict = 'No tick data and no entitlement-class error observed in this window (could be closed market, illiquid reqId collision, or a slow/no acknowledgement - re-run during RTH with a longer window before concluding anything).';
    }
    console.log(`  ${r.symbol}: ${verdict}`);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error('[diag] Unhandled error:', e);
  process.exit(1);
});
