import Database from 'better-sqlite3';

const db = new Database('data/argus.db', { readonly: true });
const since = Date.now() - 6 * 60 * 60 * 1000;

console.log('agent_predictions cols', db.prepare('PRAGMA table_info(agent_predictions)').all().map((c: any) => c.name));
console.log('agent_reasoning_logs cols', db.prepare('PRAGMA table_info(agent_reasoning_logs)').all().map((c: any) => c.name));

const out = {
  hotSwapPayloads: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE payload LIKE '%SNAPSHOT_HOT_SWAP%' OR payload LIKE '%MOMENTUM_HOT_SWAP%'`,
  ).get(),
  seedLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE payload LIKE '%SEED_UNIVERSE_EXPANSION%' AND timestamp > ?`,
  ).get(since),
  campaignBoostLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE payload LIKE '%CAMPAIGN_WATCHLIST_BOOST%' AND timestamp > ?`,
  ).get(since),
  oppScanLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE event_type='OPPORTUNITY_SCAN_COMPLETED' AND timestamp > ?`,
  ).get(since),
  ideasFromDiscovery: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE event_type='TRADE_IDEA_GENERATED' AND payload LIKE '%OpportunityDiscovery%' AND timestamp > ?`,
  ).get(since),
  screenerIdeasLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE event_type='TRADE_IDEA_GENERATED' AND payload LIKE '%OpportunityScreener%' AND timestamp > ?`,
  ).get(since),
  symbolLimitEventsLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE timestamp > ? AND (payload LIKE '%symbol_limit%' OR payload LIKE '%symbol limit exceeded%')`,
  ).get(since),
  marketDataDiscLast6h: db.prepare(
    `SELECT COUNT(*) as n FROM event_traces WHERE event_type='MARKET_DATA_DISCONNECTED' AND timestamp > ?`,
  ).get(since),
  recentOpp: db.prepare(
    `SELECT timestamp,
            json_extract(payload,'$.scanned') as scanned,
            json_extract(payload,'$.subscribeRequested') as subscribeRequested,
            json_extract(payload,'$.ideasEmitted') as ideasEmitted,
            json_extract(payload,'$.momentumHotSwap') as momentumHotSwap,
            json_extract(payload,'$.rth') as rth,
            json_extract(payload,'$.at') as at
     FROM event_traces WHERE event_type='OPPORTUNITY_SCAN_COMPLETED'
     ORDER BY timestamp DESC LIMIT 8`,
  ).all(),
  watchSubsLast6h: db.prepare(
    `SELECT json_extract(payload,'$.symbol') as symbol,
            json_extract(payload,'$.reason') as reason,
            json_extract(payload,'$.source') as source,
            timestamp
     FROM event_traces
     WHERE event_type='WATCHLIST_SUBSCRIBE_REQUESTED' AND timestamp > ?
     ORDER BY timestamp DESC LIMIT 30`,
  ).all(since),
};

console.log(JSON.stringify(out, null, 2));
db.close();
