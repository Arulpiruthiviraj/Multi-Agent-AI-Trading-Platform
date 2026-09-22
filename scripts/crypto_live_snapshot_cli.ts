/**
 * ARGUS Crypto V2 - real live crypto snapshot CLI (2026-09-21). Standalone script, run via
 * `npx tsx scripts/crypto_live_snapshot_cli.ts [SYMBOL...]`. Fetches real Alpaca crypto bars and
 * runs them through the real Java crypto_feature/crypto_regime/BTC-strategy engines. Read-only
 * (real GET/POST HTTP calls to Alpaca's data API and the local Java QuantCore bridge - never
 * places an order, never touches data/argus.db). Defaults to BTC/USD and ETH/USD.
 */
import 'dotenv/config';
import { buildCryptoLiveSnapshot } from '../src/server/crypto/live/AlpacaCryptoResearchBridge';
import { getCryptoAccountStatus } from '../src/server/crypto/live/AlpacaCryptoMarketData';

async function main(): Promise<void> {
  const symbols = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['BTC/USD', 'ETH/USD'];

  const accountStatus = await getCryptoAccountStatus();
  console.log(JSON.stringify({ accountStatus }, null, 2));

  for (const symbol of symbols) {
    console.log(`\n=== ${symbol} ===`);
    try {
      const snapshot = await buildCryptoLiveSnapshot(symbol);
      console.log(JSON.stringify(snapshot, null, 2));
    } catch (e: any) {
      console.log(JSON.stringify({ symbol, error: e?.message ?? String(e) }, null, 2));
    }
  }
}

main();
