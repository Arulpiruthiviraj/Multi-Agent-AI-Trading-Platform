import { describe, it, expect, vi } from 'vitest';

vi.mock('../core/EventBus', () => ({
  eventBus: { publish: vi.fn(), on: vi.fn(), emit: vi.fn() },
}));

import { NewsProviderManager } from './NewsProviderManager';
import { EVENTS } from '../core/eventNames';
import { eventBus } from '../core/EventBus';

/**
 * Real defect (2026-10-08 defect hunt, news D4): providers swallowed transport/HTTP
 * failures and returned [], so the manager recorded every failed fetch as a success and
 * the /providers route showed a dead feed as "Healthy" with 0 articles, indefinitely.
 * Providers now throw on transport/HTTP errors; the manager records errorCount/lastError.
 */
describe('NewsProviderManager failure accounting (D4)', () => {
  const deadProvider: any = {
    id: 'dead',
    name: 'Dead Feed',
    fetchLatest: async () => { throw new Error('HTTP 500 Internal Server Error'); },
  };
  const emptyProvider: any = {
    id: 'quiet',
    name: 'Quiet Feed',
    fetchLatest: async () => [],
  };
  const healthyProvider: any = {
    id: 'ok',
    name: 'OK Feed',
    fetchLatest: async () => [{ id: 'a1' }],
  };

  it('records errorCount/lastError for a throwing provider instead of a fake success', async () => {
    const mgr = new NewsProviderManager();
    mgr.replaceProviders([deadProvider]);
    await mgr.fetchAllLatest();
    const stats = mgr.getStats('dead');
    expect(stats.errorCount).toBe(1);
    expect(stats.lastError).toContain('HTTP 500');
    expect(stats.lastSuccessAt).toBeNull();
    expect(eventBus.publish).toHaveBeenCalledWith(
      EVENTS.NEWS_PROVIDER_FAILED,
      expect.objectContaining({ providerId: 'dead' }),
    );
  });

  it('still records a legitimate empty fetch as a success (0 articles is not a failure)', async () => {
    const mgr = new NewsProviderManager();
    mgr.replaceProviders([emptyProvider, healthyProvider]);
    await mgr.fetchAllLatest();
    const quiet = mgr.getStats('quiet');
    expect(quiet.errorCount).toBe(0);
    expect(quiet.lastSuccessAt).not.toBeNull();
    expect(quiet.lastArticleCount).toBe(0);
    const ok = mgr.getStats('ok');
    expect(ok.errorCount).toBe(0);
    expect(ok.lastArticleCount).toBe(1);
  });

  it('accumulates errorCount across cycles for a persistently dead feed', async () => {
    const mgr = new NewsProviderManager();
    mgr.replaceProviders([deadProvider]);
    await mgr.fetchAllLatest();
    await mgr.fetchAllLatest();
    expect(mgr.getStats('dead').errorCount).toBe(2);
  });
});
