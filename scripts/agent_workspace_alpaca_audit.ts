/**
 * Read-only Alpaca paper audit vs local trades (agent_workspace/alpaca_audit.json).
 * Usage: npx tsx scripts/agent_workspace_alpaca_audit.ts
 */
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import https from 'node:https';
import tls from 'node:tls';
import Database from 'better-sqlite3';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const PAPER_BASE = 'https://paper-api.alpaca.markets';
const TRADING_DAY = '2026-08-17';
const NY_TZ = 'America/New_York';

type JsonSafe = Record<string, unknown>;

type AlpacaGetResult =
  | { ok: true; data: unknown }
  | { ok: false; status?: number; body?: string; error: string; tlsOrCertificate: boolean };

const tlsAuditNotes = {
  initialCertificateError: null as string | null,
  mitigatedWithSystemCaStore: false,
};

function fixNyBoundsFallback(dateYmd: string): { after: string; until: string; label: string } {
  const [y, m, d] = dateYmd.split('-').map(Number);
  const next = new Date(Date.UTC(y, m - 1, d + 1, 4, 0, 0, 0));
  const start = new Date(Date.UTC(y, m - 1, d, 4, 0, 0, 0));
  return {
    after: start.toISOString(),
    until: next.toISOString(),
    label: `${dateYmd} (${NY_TZ}, UTC-4 fallback)`,
  };
}

function getTradingDayBounds(dateYmd: string): { after: string; until: string; label: string } {
  return fixNyBoundsFallback(dateYmd);
}

function classifyFetchError(err: unknown): { message: string; tlsOrCertificate: boolean } {
  const e = err as NodeJS.ErrnoException & { cause?: unknown; code?: string };
  const parts: string[] = [];
  if (err instanceof Error) {
    parts.push(err.message);
    if (err.cause instanceof Error) parts.push(`cause: ${err.cause.message}`);
  } else {
    parts.push(String(err));
  }
  const joined = parts.join(' | ');
  const tlsOrCertificate =
    /UNABLE_TO_VERIFY_LEAF_SIGNATURE|CERT_|certificate|SSL|TLS|self signed|DEPTH_ZERO_SELF_SIGNED|ERR_SSL|unable to verify the first certificate/i.test(
      joined,
    ) ||
    e.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' ||
    e.code === 'DEPTH_ZERO_SELF_SIGNED_CERT';
  return { message: joined, tlsOrCertificate };
}

function getSystemCaCertificates(): string[] {
  return tls.getCACertificates('system') as string[];
}

function alpacaGetHttps(apiKey: string, secretKey: string, apiPath: string): Promise<AlpacaGetResult> {
  return new Promise((resolve) => {
    const url = new URL(`${PAPER_BASE}${apiPath}`);
    const req = https.request(
      {
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        method: 'GET',
        headers: {
          'APCA-API-KEY-ID': apiKey,
          'APCA-API-SECRET-KEY': secretKey,
          Accept: 'application/json',
        },
        ca: getSystemCaCertificates(),
        rejectUnauthorized: true,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          const code = res.statusCode ?? 0;
          if (code < 200 || code >= 300) {
            resolve({
              ok: false,
              status: code,
              body: text.slice(0, 2000),
              error: `HTTP ${code}`,
              tlsOrCertificate: false,
            });
            return;
          }
          try {
            resolve({ ok: true, data: JSON.parse(text) });
          } catch {
            resolve({
              ok: false,
              error: 'Non-JSON response from Alpaca',
              body: text.slice(0, 500),
              tlsOrCertificate: false,
            });
          }
        });
      },
    );
    req.on('error', (err) => {
      const { message, tlsOrCertificate } = classifyFetchError(err);
      resolve({ ok: false, error: message, tlsOrCertificate });
    });
    req.end();
  });
}

async function alpacaGet(apiKey: string, secretKey: string, apiPath: string): Promise<AlpacaGetResult> {
  try {
    const res = await fetch(`${PAPER_BASE}${apiPath}`, {
      method: 'GET',
      headers: {
        'APCA-API-KEY-ID': apiKey,
        'APCA-API-SECRET-KEY': secretKey,
        Accept: 'application/json',
      },
    });
    const text = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        body: text.slice(0, 2000),
        error: `HTTP ${res.status}`,
        tlsOrCertificate: false,
      };
    }
    try {
      return { ok: true, data: JSON.parse(text) };
    } catch {
      return {
        ok: false,
        error: 'Non-JSON response from Alpaca',
        body: text.slice(0, 500),
        tlsOrCertificate: false,
      };
    }
  } catch (err) {
    const { message, tlsOrCertificate } = classifyFetchError(err);
    if (tlsOrCertificate) {
      if (!tlsAuditNotes.initialCertificateError) tlsAuditNotes.initialCertificateError = message;
      const retry = await alpacaGetHttps(apiKey, secretKey, apiPath);
      if (retry.ok) tlsAuditNotes.mitigatedWithSystemCaStore = true;
      return retry;
    }
    return { ok: false, error: message, tlsOrCertificate };
  }
}

function sanitizeAccount(raw: Record<string, unknown>): JsonSafe {
  return {
    id: raw.id,
    status: raw.status,
    currency: raw.currency,
    equity: raw.equity != null ? Number(raw.equity) : null,
    cash: raw.cash != null ? Number(raw.cash) : null,
    buying_power: raw.buying_power != null ? Number(raw.buying_power) : null,
    portfolio_value: raw.portfolio_value != null ? Number(raw.portfolio_value) : null,
    pattern_day_trader: raw.pattern_day_trader,
    trading_blocked: raw.trading_blocked,
    account_blocked: raw.account_blocked,
  };
}

function mapOrder(o: Record<string, unknown>): JsonSafe {
  return {
    id: o.id,
    client_order_id: o.client_order_id,
    symbol: o.symbol,
    side: o.side,
    type: o.type ?? o.order_type,
    status: o.status,
    qty: o.qty != null ? Number(o.qty) : null,
    filled_qty: o.filled_qty != null ? Number(o.filled_qty) : null,
    filled_avg_price: o.filled_avg_price != null ? Number(o.filled_avg_price) : null,
    created_at: o.created_at,
    updated_at: o.updated_at,
    submitted_at: o.submitted_at,
    filled_at: o.filled_at,
  };
}

function mapPosition(p: Record<string, unknown>): JsonSafe {
  return {
    symbol: p.symbol,
    qty: p.qty != null ? Number(p.qty) : null,
    side: p.side,
    avg_entry_price: p.avg_entry_price != null ? Number(p.avg_entry_price) : null,
    market_value: p.market_value != null ? Number(p.market_value) : null,
    unrealized_pl: p.unrealized_pl != null ? Number(p.unrealized_pl) : null,
    current_price: p.current_price != null ? Number(p.current_price) : null,
  };
}

function mapFillActivity(a: Record<string, unknown>): JsonSafe {
  return {
    id: a.id,
    activity_type: a.activity_type,
    transaction_time: a.transaction_time,
    type: a.type,
    price: a.price != null ? Number(a.price) : null,
    qty: a.qty != null ? Number(a.qty) : null,
    side: a.side,
    symbol: a.symbol,
    order_id: a.order_id,
    cum_qty: a.cum_qty != null ? Number(a.cum_qty) : null,
  };
}

function isoInNyDay(iso: string | null | undefined, dayYmd: string): boolean {
  if (!iso) return false;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return false;
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: NY_TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = fmt.formatToParts(d);
  const y = parts.find((p) => p.type === 'year')?.value;
  const m = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  const localYmd = `${y}-${m}-${day}`;
  return localYmd === dayYmd;
}

function readLocalTrades(dbPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const rows = db
      .prepare(
        `SELECT id, symbol, side, quantity, price, status, timestamp, broker_order_id, filled_at, submitted_at, execution_environment
         FROM trades`,
      )
      .all();
    return rows as Array<Record<string, unknown>>;
  } finally {
    db.close();
  }
}

function compareTrades(
  alpacaOrders: JsonSafe[],
  alpacaFills: JsonSafe[],
  localTrades: Array<Record<string, unknown>>,
  dayYmd: string,
): { status: 'RECONCILED' | 'MISMATCH'; details: JsonSafe[]; summary: JsonSafe } {
  const details: JsonSafe[] = [];

  const localForDay = localTrades.filter((t) => {
    const ts = (t.filled_at as string) || (t.submitted_at as string) || (t.timestamp as string);
    return isoInNyDay(ts, dayYmd);
  });

  const filledAlpacaDay = alpacaOrders.filter((o) => {
    const st = String(o.status ?? '').toLowerCase();
    if (st !== 'filled') return false;
    const ts =
      (o.filled_at as string) ||
      (o.updated_at as string) ||
      (o.submitted_at as string) ||
      (o.created_at as string);
    return isoInNyDay(ts, dayYmd);
  });

  const localByBrokerId = new Map<string, Record<string, unknown>>();
  for (const t of localTrades) {
    const bid = t.broker_order_id as string | undefined;
    if (bid) localByBrokerId.set(bid, t);
  }

  const alpacaFilledIds = new Set(filledAlpacaDay.map((o) => String(o.id)));

  for (const o of filledAlpacaDay) {
    const id = String(o.id);
    const local = localByBrokerId.get(id);
    if (!local) {
      details.push({
        kind: 'ALPACA_FILLED_ORDER_MISSING_LOCAL',
        brokerOrderId: id,
        symbol: o.symbol,
        side: o.side,
        filled_qty: o.filled_qty,
      });
      continue;
    }
    const lQty = Number(local.quantity);
    const aQty = Number(o.filled_qty ?? o.qty);
    const lSide = String(local.side ?? '').toUpperCase();
    const aSide = String(o.side ?? '').toUpperCase();
    if (Math.abs(lQty - aQty) > 1e-6 || lSide !== aSide || String(local.symbol) !== String(o.symbol)) {
      details.push({
        kind: 'ORDER_FIELD_MISMATCH',
        brokerOrderId: id,
        local: { symbol: local.symbol, side: local.side, quantity: local.quantity, status: local.status },
        alpaca: { symbol: o.symbol, side: o.side, filled_qty: o.filled_qty, status: o.status },
      });
    }
  }

  for (const t of localForDay) {
    const bid = t.broker_order_id as string | undefined;
    if (!bid) {
      if (String(t.status).toUpperCase() === 'FILLED') {
        details.push({
          kind: 'LOCAL_FILLED_WITHOUT_BROKER_ORDER_ID',
          tradeId: t.id,
          symbol: t.symbol,
          side: t.side,
          quantity: t.quantity,
        });
      }
      continue;
    }
    if (!alpacaFilledIds.has(bid)) {
      const brokerOrderInAll = alpacaOrders.find((o) => String(o.id) === bid);
      if (!brokerOrderInAll) {
        details.push({
          kind: 'LOCAL_BROKER_ORDER_ID_NOT_ON_ALPACA_DAY',
          brokerOrderId: bid,
          tradeId: t.id,
          symbol: t.symbol,
          status: t.status,
        });
      } else if (String(brokerOrderInAll.status).toLowerCase() !== 'filled') {
        details.push({
          kind: 'LOCAL_FILLED_BROKER_ORDER_NOT_FILLED',
          brokerOrderId: bid,
          tradeId: t.id,
          alpacaStatus: brokerOrderInAll.status,
        });
      }
    }
  }

  if (alpacaFills.length > 0) {
    const fillOrderIds = new Set(alpacaFills.map((f) => String(f.order_id ?? '')).filter(Boolean));
    for (const id of fillOrderIds) {
      if (filledAlpacaDay.some((o) => String(o.id) === id) && !localByBrokerId.has(id)) {
        if (!details.some((d) => d.brokerOrderId === id)) {
          details.push({ kind: 'FILL_ACTIVITY_WITHOUT_LOCAL_TRADE', brokerOrderId: id });
        }
      }
    }
  }

  const status = details.length === 0 ? 'RECONCILED' : 'MISMATCH';
  return {
    status,
    details,
    summary: {
      localTradesOnTradingDay: localForDay.length,
      alpacaFilledOrdersOnTradingDay: filledAlpacaDay.length,
      alpacaFillActivitiesOnTradingDay: alpacaFills.length,
      localTradesWithBrokerOrderId: localForDay.filter((t) => t.broker_order_id).length,
    },
  };
}

async function main() {
  const apiKey = process.env.ALPACA_API_KEY?.trim();
  const secretKey = process.env.ALPACA_SECRET_KEY?.trim();
  const bounds = getTradingDayBounds(TRADING_DAY);
  const outPath = path.resolve(process.cwd(), 'agent_workspace/alpaca_audit.json');
  const dbPath = path.resolve(process.cwd(), 'data/argus.db');

  const report: JsonSafe = {
    generatedAt: new Date().toISOString(),
    tradingDay: bounds.label,
    tradingDayQuery: { after: bounds.after, until: bounds.until },
    alpacaBaseUrl: PAPER_BASE,
    credentialsPresent: { ALPACA_API_KEY: Boolean(apiKey), ALPACA_SECRET_KEY: Boolean(secretKey) },
    alpacaReachable: false,
    tlsOrCertificateError: null as string | null,
    tlsNotes: null as JsonSafe | null,
    fetchErrors: [] as JsonSafe[],
    account: null as JsonSafe | null,
    positions: [] as JsonSafe[],
    ordersForTradingDay: [] as JsonSafe[],
    fillActivitiesForTradingDay: [] as JsonSafe[],
    localDb: { path: 'data/argus.db', exists: fs.existsSync(dbPath), trades: [] as JsonSafe[] },
    reconciliation: null as JsonSafe | null,
  };

  if (!apiKey || !secretKey) {
    report.reconciliation = {
      status: 'MISMATCH',
      details: [{ kind: 'MISSING_CREDENTIALS', message: 'ALPACA_API_KEY or ALPACA_SECRET_KEY not set in .env' }],
    };
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    console.log(`Wrote ${outPath} (missing credentials)`);
    return;
  }

  const accountRes = await alpacaGet(apiKey, secretKey, '/v2/account');
  if (!accountRes.ok) {
    (report.fetchErrors as JsonSafe[]).push({ endpoint: '/v2/account', ...accountRes });
  } else {
    report.alpacaReachable = true;
    report.account = sanitizeAccount(accountRes.data as Record<string, unknown>);
  }

  const posRes = await alpacaGet(apiKey, secretKey, '/v2/positions');
  if (!posRes.ok) {
    (report.fetchErrors as JsonSafe[]).push({ endpoint: '/v2/positions', ...posRes });
  } else if (Array.isArray(posRes.data)) {
    report.positions = (posRes.data as Record<string, unknown>[]).map(mapPosition);
  }

  const ordersPath = `/v2/orders?status=all&after=${encodeURIComponent(bounds.after)}&until=${encodeURIComponent(bounds.until)}&limit=500&direction=asc`;
  const ordersRes = await alpacaGet(apiKey, secretKey, ordersPath);
  if (!ordersRes.ok) {
    (report.fetchErrors as JsonSafe[]).push({ endpoint: '/v2/orders', query: ordersPath, ...ordersRes });
  } else if (Array.isArray(ordersRes.data)) {
    report.alpacaReachable = true;
    report.ordersForTradingDay = (ordersRes.data as Record<string, unknown>[]).map(mapOrder);
  }

  const fillsPath = `/v2/account/activities/FILL?after=${encodeURIComponent(bounds.after)}&until=${encodeURIComponent(bounds.until)}&page_size=100&direction=asc`;
  const fillsRes = await alpacaGet(apiKey, secretKey, fillsPath);
  if (!fillsRes.ok) {
    (report.fetchErrors as JsonSafe[]).push({ endpoint: '/v2/account/activities/FILL', ...fillsRes });
    const altPath = `/v2/account/activities?activity_types=FILL&after=${encodeURIComponent(bounds.after)}&until=${encodeURIComponent(bounds.until)}&page_size=100`;
    const altRes = await alpacaGet(apiKey, secretKey, altPath);
    if (altRes.ok && Array.isArray(altRes.data)) {
      report.fillActivitiesForTradingDay = (altRes.data as Record<string, unknown>[]).map(mapFillActivity);
    } else if (!altRes.ok) {
      (report.fetchErrors as JsonSafe[]).push({ endpoint: '/v2/account/activities', ...altRes });
    }
  } else if (Array.isArray(fillsRes.data)) {
    report.fillActivitiesForTradingDay = (fillsRes.data as Record<string, unknown>[]).map(mapFillActivity);
  }

  if (tlsAuditNotes.initialCertificateError) {
    report.tlsOrCertificateError = tlsAuditNotes.initialCertificateError;
    report.tlsNotes = {
      nodeDefaultFetchFailedCertificateVerification: true,
      mitigatedWithSystemCaStore: tlsAuditNotes.mitigatedWithSystemCaStore,
      hint: 'Node fetch() failed TLS verification; retry used tls.getCACertificates("system") via node:https (same as NODE_OPTIONS=--use-system-ca).',
    };
  }

  const localRows = readLocalTrades(dbPath);
  (report.localDb as JsonSafe).trades = localRows
    .filter((t) => {
      const ts = (t.filled_at as string) || (t.submitted_at as string) || (t.timestamp as string);
      return isoInNyDay(ts, TRADING_DAY);
    })
    .map((t) => ({
      id: t.id,
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: t.price,
      status: t.status,
      broker_order_id: t.broker_order_id,
      filled_at: t.filled_at,
      execution_environment: t.execution_environment,
    }));

  if (!report.alpacaReachable && (report.fetchErrors as JsonSafe[]).length > 0) {
    report.reconciliation = {
      status: 'MISMATCH',
      details: [
        {
          kind: 'ALPACA_UNREACHABLE',
          message: 'Could not complete Alpaca paper API queries; see fetchErrors for exact errors.',
        },
      ],
      summary: {
        localTradesOnTradingDay: ((report.localDb as { trades: unknown[] }).trades ?? []).length,
      },
    };
  } else {
    report.reconciliation = compareTrades(
      report.ordersForTradingDay as JsonSafe[],
      report.fillActivitiesForTradingDay as JsonSafe[],
      localRows,
      TRADING_DAY,
    );
  }

  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));

  const reconStatus = (report.reconciliation as { status?: string })?.status ?? 'UNKNOWN';
  console.log(`Alpaca paper audit complete: ${reconStatus}`);
  console.log(`Wrote ${outPath}`);
  if (!report.alpacaReachable) {
    const first = (report.fetchErrors as JsonSafe[])[0] as { error?: string } | undefined;
    console.log(`Alpaca unreachable: ${first?.error ?? 'see fetchErrors in JSON'}`);
  } else if (report.tlsOrCertificateError) {
    console.log('Note: TLS/certificate error on default fetch; see tlsNotes in JSON.');
  }
}

main().catch((e) => {
  console.error('Audit script failed:', e instanceof Error ? e.message : e);
  process.exit(1);
});
