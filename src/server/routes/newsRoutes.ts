/**
 * Read-only news reporting routes (timeline, per-symbol memory, provider
 * list, raw article feed). Extracted from server.ts structurally only.
 *
 * Step 3 cleanup applied (no behavior change): the original handlers used
 * `await import(...)` per request for modules that are always available and
 * never conditionally loaded (NewsTimelineEngine, NewsMemoryEngine, newsEngine,
 * db, schema, drizzle-orm's `desc`) — replaced with normal static imports.
 * Node caches modules either way, so the only difference is removing the
 * repeated per-request import-resolution overhead; the data returned is identical.
 */
import { Router, Request, Response } from "express";
import { desc } from "drizzle-orm";
import { db } from "../db/index";
import * as schema from "../db/schema";
import { NewsTimelineEngine } from "../news/NewsTimelineEngine";
import { NewsMemoryEngine } from "../news/NewsMemoryEngine";
import { newsEngine } from "../news/NewsEngine";

export const newsRouter = Router();

newsRouter.get("/timeline", async (req: Request, res: Response) => {
  try {
    const engine = new NewsTimelineEngine();
    const timeline = await engine.getTimeline();
    res.json(timeline);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

newsRouter.get("/memory", async (req: Request, res: Response) => {
  try {
    const symbol = req.query.symbol as string;
    const engine = new NewsMemoryEngine();
    const events = await engine.getRecentEventsForSymbol(symbol || "");
    res.json(events);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

newsRouter.get("/providers", async (req: Request, res: Response) => {
  try {
    const providers = newsEngine.providerManager.getProviders().map((p: any) => ({
      id: p.id,
      name: p.name,
      type: p.type,
      enabled: true,
      health: "Healthy",
      errorCount: 0,
      credibilityWeight: p.credibilityWeight,
      lastFetch: new Date().toISOString(),
    }));
    res.json(providers);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});

newsRouter.get("/articles", async (req: Request, res: Response) => {
  try {
    const limit = parseInt((req.query.limit as string) || "50");
    const articles = await db.select().from(schema.newsArticles).orderBy(desc(schema.newsArticles.publishedAt)).limit(limit);
    res.json(articles);
  } catch (e: any) {
    res.status(500).json({ error: e.message });
  }
});
