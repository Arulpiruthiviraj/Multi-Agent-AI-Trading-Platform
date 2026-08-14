import dotenv from 'dotenv';
dotenv.config();
import { db } from '../src/server/db';
import * as schema from '../src/server/db/schema';

async function main() {
  const rows = await db.select().from(schema.settings).limit(1);
  console.log(JSON.stringify(rows[0], null, 2));
}

main().then(() => process.exit(0)).catch((e) => { console.error('ERROR:', e.message); process.exit(1); });
