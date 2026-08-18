import { db } from '../db';
import * as schema from '../db/schema';
import { eq, sql } from 'drizzle-orm';

export class NewsMemoryEngine {
  public async getRecentEventsForSymbol(symbol: string, limit = 5) {
    try {
      // Find recent clusters mentioning this symbol
      // In SQLite, we can just use LIKE or better, a JSON query if symbols was JSON.
      // We'll just fetch recent clusters. In a real app we'd have a junction table.
      const needle = String(symbol || '').replace(/[%_]/g, '');
      const clusters = await db.select().from(schema.newsClusters).where(sql`${schema.newsClusters.symbols} LIKE ${'%' + needle + '%'}`).orderBy(sql`${schema.newsClusters.createdAt} DESC`).limit(limit);
      return clusters;
    } catch (e) {
      console.error('[NewsMemoryEngine] Error:', e);
      return [];
    }
  }
}
