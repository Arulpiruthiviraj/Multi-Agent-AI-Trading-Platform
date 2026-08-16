/**
 * Reconstruct PIT LLM debate only from stored prompts + completions that existed at asOfMs.
 * Never invents tokens. debateReplayed is true only when both prompt and rawResponse exist.
 */
export interface PitAiCallRow {
  prompt: string | null;
  rawResponse: string | null;
  status: string;
  createdAt: string;
  agent: string;
}

export interface PitNewsClusterRow {
  createdAt: string;
  symbols: string | null;
  title: string | null;
}

export interface PitDebateReconstruction {
  debateReplayed: boolean;
  reason: string;
  prompt: string | null;
  rawResponse: string | null;
  newsHeadline: string | null;
}

function createdAtMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Number.POSITIVE_INFINITY;
}

export function reconstructPitDebate(opts: {
  asOfMs: number;
  symbol: string;
  aiCalls: PitAiCallRow[];
  newsClusters: PitNewsClusterRow[];
}): PitDebateReconstruction {
  const symbol = opts.symbol.toUpperCase();
  const news = opts.newsClusters
    .filter((n) => createdAtMs(n.createdAt) <= opts.asOfMs)
    .filter((n) => {
      const raw = n.symbols || '';
      if (!raw) return false;
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.map((s) => String(s).toUpperCase()).includes(symbol);
      } catch { /* csv */ }
      return raw.toUpperCase().split(/[,;]/).map((s) => s.trim()).includes(symbol);
    })
    .sort((a, b) => createdAtMs(b.createdAt) - createdAtMs(a.createdAt))[0];

  const call = opts.aiCalls
    .filter((c) => c.status === 'success')
    .filter((c) => createdAtMs(c.createdAt) <= opts.asOfMs)
    .filter((c) => typeof c.prompt === 'string' && c.prompt.length > 0)
    .filter((c) => typeof c.rawResponse === 'string' && c.rawResponse.length > 0)
    .sort((a, b) => createdAtMs(b.createdAt) - createdAtMs(a.createdAt))[0];

  if (!call) {
    return {
      debateReplayed: false,
      reason: 'NO_TRADE: no PIT ai_calls row with prompt+rawResponse at or before asOfMs — debate not invented.',
      prompt: null,
      rawResponse: null,
      newsHeadline: news?.title ?? null,
    };
  }
  if (!news) {
    return {
      debateReplayed: false,
      reason: 'NO_TRADE: LLM row exists but no PIT news_clusters row for this symbol at or before asOfMs.',
      prompt: call.prompt,
      rawResponse: call.rawResponse,
      newsHeadline: null,
    };
  }
  return {
    debateReplayed: true,
    reason: `PIT debate reconstructed from stored ${call.agent} prompt/response + news cluster.`,
    prompt: call.prompt,
    rawResponse: call.rawResponse,
    newsHeadline: news.title,
  };
}
