import { describe, it, expect, vi, beforeEach } from 'vitest';

// Real test coverage for the Phase 6 hardening fix: chat() previously hardcoded
// 'gemini-2.5-flash' and silently ignored options.model - AIRouter's own per-agent model
// override never actually reached the real API call.
const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));
vi.mock('@google/genai', () => ({
  GoogleGenAI: class {
    models = { generateContent };
  },
}));

import { GeminiProvider } from './GeminiProvider';

describe('GeminiProvider - model override (Phase 6 hardening)', () => {
  let provider: GeminiProvider;

  beforeEach(async () => {
    generateContent.mockReset();
    generateContent.mockResolvedValue({ text: 'response', usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, totalTokenCount: 15 } });
    provider = new GeminiProvider();
    await provider.initialize('test-key');
  });

  it('uses the real default model when no override is requested (existing behavior preserved)', async () => {
    await provider.chat('hello');
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-flash' }));
  });

  it('the exact bug this closes: a valid per-agent model override actually reaches the real API call', async () => {
    await provider.chat('hello', { model: 'gemini-2.5-pro' });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-pro' }));
  });

  it('rejects an unsupported model name rather than silently executing against it - falls back to the real default', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await provider.chat('hello', { model: 'gemini-99-nonexistent' });
    expect(generateContent).toHaveBeenCalledWith(expect.objectContaining({ model: 'gemini-2.5-flash' }));
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
