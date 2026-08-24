import { describe, it, expect } from 'vitest';
import { NvidiaProvider } from './NvidiaProvider';

/**
 * Real bug fix coverage: NVIDIA's NIM catalog does not serve 'gpt-3.5-turbo'
 * (OpenAICompatibleProvider's generic default), so every call with no operator-configured model
 * was guaranteed to fail with a real 404 (VERIFIED FROM DATABASE: 91 occurrences in one live
 * session). NvidiaProvider must fail closed (report not-authenticated) instead of silently
 * inheriting that always-wrong default and making a doomed network call.
 */
describe('NvidiaProvider - fails closed without a configured model (zero-trade audit fix)', () => {
  it('reports not authenticated when no defaultModel was ever configured', async () => {
    const provider = new NvidiaProvider();
    await provider.initialize('real-looking-nvidia-key');

    expect(await provider.authenticate()).toBe(false);
  });

  it('never silently substitutes an OpenAI-style default model name', async () => {
    const provider = new NvidiaProvider();
    await provider.initialize('real-looking-nvidia-key');

    expect((provider as any).defaultModel).toBe('');
    expect((provider as any).defaultModel).not.toBe('gpt-3.5-turbo');
  });

  it('authenticates normally once an operator sets a real NIM model id', async () => {
    const provider = new NvidiaProvider();
    await provider.initialize('real-looking-nvidia-key', 'meta/llama-3.1-70b-instruct');

    expect(await provider.authenticate()).toBe(true);
    expect((provider as any).defaultModel).toBe('meta/llama-3.1-70b-instruct');
  });

  it('still fails closed with a configured model but no API key (unrelated pre-existing check)', async () => {
    const provider = new NvidiaProvider();
    await provider.initialize('', 'meta/llama-3.1-70b-instruct');

    expect(await provider.authenticate()).toBe(false);
  });
});
