/**
 * ==========================================================
 * Module: LocalSentiment
 *
 * Purpose:
 * HTTP client for the real FinBERT sentiment endpoint on the persistent local
 * inference service (scripts/local_ai_service.py, `npm run ai:serve`). That
 * service loads ProsusAI/finbert once and keeps it resident; this is just the
 * client - there is no in-process Python/transformers here.
 *
 * Returns null (never throws) on any failure so callers can fall back to a
 * deterministic heuristic rather than crashing the news pipeline over an
 * optional, best-effort enhancement.
 * ==========================================================
 */

const SERVICE_URL = process.env.LOCAL_AI_SERVICE_URL || 'http://localhost:8008';

export interface FinBertSentiment {
  model: string;
  label: 'positive' | 'negative' | 'neutral';
  score: number; // 0-1 confidence in `label`
  signedScore: number; // -1 (negative) .. +1 (positive), 0 for neutral
}

export async function getFinBertSentiment(text: string): Promise<FinBertSentiment | null> {
  try {
    const res = await fetch(`${SERVICE_URL}/sentiment`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}
