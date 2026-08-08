import { db } from '../db';
import * as schema from '../db/schema';
import { sql } from 'drizzle-orm';

export class NewsTimelineEngine {
  public async getTimeline() {
    try {
      const clusters = await db.select().from(schema.newsClusters).orderBy(sql`${schema.newsClusters.createdAt} DESC`).limit(20);
      return clusters;
    } catch (e) {
      console.error('[NewsTimelineEngine] Error:', e);
      return [];
    }
  }
}
