import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RssNewsProvider, rssHttpStatusFromError } from './RssNewsProvider';
import { runtimeIntervals } from '../../config/runtimeIntervals';

function mockParser(parseURL: ReturnType<typeof vi.fn>) {
  return { parseURL } as any;
}

describe('RssNewsProvider backoff', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-17T12:00:00.000Z'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
    vi.useRealTimers();
  });

  it('rssHttpStatusFromError reads rss-parser "Status code 503" phrasing', () => {
    expect(rssHttpStatusFromError(new Error('Status code 503'))).toBe(503);
    expect(rssHttpStatusFromError(new Error('Status code 200'))).toBe(200);
  });

  it('backs off after HTTP 503, logs once without a stack, and skips parseURL until cooldown', async () => {
    const parseURL = vi.fn().mockRejectedValue(new Error('Status code 503'));
    const provider = new RssNewsProvider(
      'cnbc_top',
      'CNBC Top News',
      'https://example.test/rss',
      0.85,
      mockParser(parseURL),
    );

    expect(await provider.fetchLatest()).toEqual([]);
    expect(parseURL).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(String(warnSpy.mock.calls[0][0])).toMatch(/HTTP 503/);
    expect(String(warnSpy.mock.calls[0][0])).toContain(String(runtimeIntervals.rssFeedErrorBackoffMs / 1000));
    expect(errorSpy).not.toHaveBeenCalled();

    expect(await provider.fetchLatest()).toEqual([]);
    expect(await provider.healthCheck()).toBe(false);
    expect(parseURL).toHaveBeenCalledTimes(1);
    expect(warnSpy).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date(Date.now() + runtimeIntervals.rssFeedErrorBackoffMs));
    parseURL.mockResolvedValueOnce({ items: [{ title: 'ok', link: 'https://example.test/a', guid: 'g1' }] });
    const articles = await provider.fetchLatest();
    expect(parseURL).toHaveBeenCalledTimes(2);
    expect(articles).toHaveLength(1);
    expect(articles[0].title).toBe('ok');
  });
});
