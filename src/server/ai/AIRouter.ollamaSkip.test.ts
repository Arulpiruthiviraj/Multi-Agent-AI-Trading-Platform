import { describe, it, expect, afterEach } from 'vitest';
import { AIRouter } from './AIRouter';

describe('AIRouter skips local Ollama when ARGUS_SKIP_OLLAMA=true (2026-10-12: 3,099 dispatches while "disabled")', () => {
  const original = process.env.ARGUS_SKIP_OLLAMA;
  afterEach(() => { if (original === undefined) delete process.env.ARGUS_SKIP_OLLAMA; else process.env.ARGUS_SKIP_OLLAMA = original; });
  const entries: any[] = [['ollama-id', {}], ['nvidia-id', {}]];
  const stats: any[] = [
    { id: 'ollama-id', providerName: 'Ollama (Local)', enabled: true },
    { id: 'nvidia-id', providerName: 'NVIDIA', enabled: true },
  ];
  it('excludes the Ollama provider when local inference is skipped, keeps the others', () => {
    process.env.ARGUS_SKIP_OLLAMA = 'true';
    const out = (AIRouter.getInstance() as any).filterRoutableProviders(entries, stats);
    expect(out.map((e: any) => e[0])).toEqual(['nvidia-id']);
  });
  it('keeps Ollama routable when local inference is not skipped', () => {
    process.env.ARGUS_SKIP_OLLAMA = 'false';
    const out = (AIRouter.getInstance() as any).filterRoutableProviders(entries, stats);
    expect(out.map((e: any) => e[0])).toEqual(['ollama-id', 'nvidia-id']);
  });
});
