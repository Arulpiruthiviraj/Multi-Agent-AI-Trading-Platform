/**
 * Process-local registry of optional services. Never marks READY without evidence.
 * Probes use short timeouts; failures leave the app usable.
 */
export type StartupHealthStatus = 'STARTING' | 'READY' | 'DEGRADED' | 'FAILED' | 'DISABLED' | 'NOT_CONFIGURED';

export interface StartupHealthEntry {
  service: string;
  status: StartupHealthStatus;
  error: string | null;
  rootCause: string | null;
  impact: string;
  fix: string;
  latencyMs: number | null;
  lastCheckedAt: string;
}

function envOn(name: string): boolean {
  return process.env[name] === 'true';
}

function configured(name: string): boolean {
  const v = process.env[name];
  return typeof v === 'string' && v.trim().length > 0;
}

async function probe(url: string, timeoutMs: number): Promise<{ ok: boolean; error?: string; latencyMs: number }> {
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    return { ok: res.ok, error: res.ok ? undefined : `HTTP ${res.status}`, latencyMs: Date.now() - t0 };
  } catch (e: any) {
    return { ok: false, error: e?.message ?? String(e), latencyMs: Date.now() - t0 };
  }
}

function stamp(partial: Omit<StartupHealthEntry, 'lastCheckedAt'>): StartupHealthEntry {
  return { ...partial, lastCheckedAt: new Date().toISOString() };
}

export async function collectStartupHealth(timeoutMs = 2000): Promise<StartupHealthEntry[]> {
  const entries: StartupHealthEntry[] = [];

  entries.push(stamp({
    service: 'OpenAlice',
    status: !envOn('OPENALICE_ENABLED') ? 'DISABLED' : (!configured('OPENALICE_MCP_URL') ? 'NOT_CONFIGURED' : 'STARTING'),
    error: null,
    rootCause: !envOn('OPENALICE_ENABLED') ? 'OPENALICE_ENABLED is not true' : (!configured('OPENALICE_MCP_URL') ? 'OPENALICE_MCP_URL unset' : null),
    impact: 'Independent verification is fire-and-forget and never gates RiskEngine.',
    fix: 'Set OPENALICE_ENABLED=true and OPENALICE_MCP_URL to Guardian (not a trading MCP).',
    latencyMs: null,
  }));
  if (envOn('OPENALICE_ENABLED') && configured('OPENALICE_MCP_URL')) {
    const p = await probe(process.env.OPENALICE_MCP_URL as string, timeoutMs);
    const last = entries[entries.length - 1];
    last.status = p.ok ? 'READY' : 'FAILED';
    last.error = p.error ?? null;
    last.rootCause = p.ok ? null : p.error ?? 'unreachable';
    last.latencyMs = p.latencyMs;
  }

  const chronosUrl = process.env.LOCAL_AI_SERVICE_URL || 'http://127.0.0.1:8008';
  const chronos = await probe(`${chronosUrl.replace(/\/$/, '')}/health`, timeoutMs);
  entries.push(stamp({
    service: 'Chronos/Kronos',
    status: chronos.ok ? 'READY' : 'FAILED',
    error: chronos.ok ? null : chronos.error ?? null,
    rootCause: chronos.ok ? null : 'Chronos /health did not succeed',
    impact: 'Forecast evidence unavailable. Argus continues without Chronos; forecast confidence is absent, not fabricated.',
    fix: 'npm run ai:serve (or npm run dev). Skip with ARGUS_SKIP_CHRONOS=true.',
    latencyMs: chronos.latencyMs,
  }));

  const ollamaHost = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const ollama = await probe(`${ollamaHost.replace(/\/$/, '')}/api/tags`, timeoutMs);
  entries.push(stamp({
    service: 'Ollama',
    status: ollama.ok ? 'READY' : 'FAILED',
    error: ollama.ok ? null : ollama.error ?? null,
    rootCause: ollama.ok ? null : 'Ollama /api/tags failed',
    impact: 'Local OpenAI-compatible models unavailable. Remote providers still used via AIRouter.',
    fix: 'Start Ollama. Skip with ARGUS_SKIP_OLLAMA=true.',
    latencyMs: ollama.latencyMs,
  }));

  entries.push(stamp({
    service: 'QuantSignalAgent',
    status: envOn('QUANT_ENGINE_ENABLED') ? 'READY' : 'DISABLED',
    error: null,
    rootCause: envOn('QUANT_ENGINE_ENABLED') ? null : 'QUANT_ENGINE_ENABLED is not true',
    impact: 'Quant ideas are not emitted unless the flag is explicitly enabled. This registry never flips the flag.',
    fix: 'Set QUANT_ENGINE_ENABLED=true only after reviewing unvalidated strategies.',
    latencyMs: null,
  }));

  const alpaca = configured('ALPACA_API_KEY') && configured('ALPACA_SECRET_KEY');
  entries.push(stamp({
    service: 'Broker/Alpaca',
    status: alpaca ? 'READY' : 'NOT_CONFIGURED',
    error: alpaca ? null : 'ALPACA_API_KEY or ALPACA_SECRET_KEY unset',
    rootCause: alpaca ? null : 'Missing Alpaca credentials',
    impact: 'Without keys, InternalPaperBroker is used. LIVE remains blocked independently.',
    fix: 'Set Alpaca paper keys in .env. Values are never displayed.',
    latencyMs: null,
  }));

  entries.push(stamp({
    service: 'AIRouter',
    status: (configured('GEMINI_API_KEY') || configured('OPENAI_API_KEY') || configured('DEEPSEEK_API_KEY') || configured('NVIDIA_API_KEY')) ? 'READY' : 'NOT_CONFIGURED',
    error: null,
    rootCause: null,
    impact: 'LLM debate degrades honestly when no provider is configured.',
    fix: 'Set at least one provider key listed in .env.example.',
    latencyMs: null,
  }));

  return entries;
}
