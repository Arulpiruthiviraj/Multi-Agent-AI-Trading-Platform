import dotenv from 'dotenv';
dotenv.config();
import { db } from '../src/server/db/index';
import { ohlcvBars } from '../src/server/db/schema';
import { eq, and } from 'drizzle-orm';

async function main() {
  for (const sym of ['BTC', 'ETH']) {
    for (const tf of ['1Day', '1Min']) {
      const rows = db.select().from(ohlcvBars).where(and(eq(ohlcvBars.symbol, sym), eq(ohlcvBars.timeframe, tf))).all();
      if (!rows.length) continue;
      const sorted = rows.slice().sort((a,b)=>a.timestamp-b.timestamp);
      console.log(sym, tf, 'count', rows.length, 'first', new Date(sorted[0].timestamp).toISOString(), 'last', new Date(sorted[sorted.length-1].timestamp).toISOString());
      console.log('  last 8:', sorted.slice(-8).map(r=>new Date(r.timestamp).toISOString()));
      console.log('  source set:', [...new Set(rows.map(r=>r.source))]);
    }
  }
  process.exit(0);
}
main();
