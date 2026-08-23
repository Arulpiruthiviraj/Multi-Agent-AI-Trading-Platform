/**
 * Module: NewsPredictionLedger (Phase F5)
 *
 * Persists a News prediction at the moment it is made, so it can later be checked against real
 * subsequent price movement (Phase F6 - prediction evaluation, not yet built). Only ever writes
 * when newsAgentObservesPredictions() is true (ACTIVE_OBSERVE and above); the default
 * CATALYST_ONLY mode never calls this, so this table stays empty unless an operator opts in.
 *
 * Never fabricates a reference price - if MarketDataWorker has no live tick for the symbol yet,
 * referencePrice is recorded as null, not a guessed number.
 */
import { v4 as uuidv4 } from 'uuid';
import { db } from '../db';
import * as schema from '../db/schema';
import { desc, eq } from 'drizzle-orm';
import { deskIntelligence } from '../config/deskIntelligence';
import type { Materiality, ExpectedHorizon, CatalystType } from './NewsIntelligence';

export interface NewsPredictionInput {
  clusterId: string;
  traceId: string;
  symbol: string;
  direction: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  confidence: number;
  expectedHorizon: ExpectedHorizon;
  referencePrice: number | null;
  reasoning: string;
  materiality: Materiality;
  catalystType: CatalystType;
  riskLevel: Materiality;
  riskVeto: boolean;
  sourceCount: number;
  modelSource: string;
  stagingStatus?: 'ACTIVE' | 'STAGED_FOR_OPEN' | 'EXPIRED' | 'CONSUMED';
  expiresAt?: string | null;
}

export async function recordNewsPrediction(input: NewsPredictionInput): Promise<string | null> {
  try {
    const id = uuidv4();
    await db.insert(schema.newsPredictions).values({
      id,
      clusterId: input.clusterId,
      traceId: input.traceId,
      symbol: input.symbol.toUpperCase(),
      createdAt: new Date().toISOString(),
      direction: input.direction,
      confidence: input.confidence,
      expectedHorizon: input.expectedHorizon,
      referencePrice: input.referencePrice,
      reasoning: input.reasoning,
      materiality: input.materiality,
      catalystType: input.catalystType,
      riskLevel: input.riskLevel,
      riskVeto: input.riskVeto,
      sourceCount: input.sourceCount,
      newsAgentMode: deskIntelligence.newsAgentMode,
      modelSource: input.modelSource,
      stagingStatus: input.stagingStatus ?? 'ACTIVE',
      expiresAt: input.expiresAt ?? null,
    });
    return id;
  } catch (e) {
    console.error('[NewsPredictionLedger] Failed to record prediction:', e);
    return null;
  }
}

export async function listRecentNewsPredictions(symbol: string, limit = 20) {
  return db.select().from(schema.newsPredictions)
    .where(eq(schema.newsPredictions.symbol, symbol.toUpperCase()))
    .orderBy(desc(schema.newsPredictions.createdAt))
    .limit(limit);
}
