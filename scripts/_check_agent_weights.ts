import dotenv from 'dotenv';
dotenv.config();
import { db } from '../src/server/db';
import * as schema from '../src/server/db/schema';

async function main() {
  const rows = await db.select().from(schema.agentPerformanceStats);
  console.log('agent_performance_stats rows:');
  for (const r of rows) console.log(' ', JSON.stringify(r));

  const settings = await db.select().from(schema.settings).limit(1);
  console.log('\nadversarialDebateMode:', settings[0]?.adversarialDebateMode);

  // Quick reachability checks for the optional local services (non-fatal if down)
  for (const [name, url] of [['FinBERT', 'http://localhost:8008/health'], ['Chronos/Kronos ai:serve', 'http://localhost:8001/health']] as const) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      console.log(`${name} (${url}): reachable, status ${res.status}`);
    } catch (e: any) {
      console.log(`${name} (${url}): NOT reachable (${e.message})`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
