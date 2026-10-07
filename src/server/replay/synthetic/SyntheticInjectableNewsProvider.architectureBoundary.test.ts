/**
 * Architecture-boundary proof for SyntheticInjectableNewsProvider.ts, same pattern as
 * SyntheticDailyBarProvider.architectureBoundary.test.ts: a static grep-based check that no file
 * outside src/server/replay/synthetic/ ever imports this module, plus a runtime proof that the
 * module itself refuses to run outside a synthetic simulation session even if that boundary were
 * ever violated.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function listTsFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === '.git') continue;
      out.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

describe('Architecture protection: SyntheticInjectableNewsProvider stays inside the synthetic harness', () => {
  it('no file outside src/server/replay/synthetic/ imports SyntheticInjectableNewsProvider', () => {
    const srcRoot = join(ROOT, 'src');
    const files = listTsFiles(srcRoot);
    const hits: string[] = [];
    for (const f of files) {
      const path = relative(ROOT, f).replace(/\\/g, '/');
      if (path.startsWith('src/server/replay/synthetic/')) continue; // the harness itself - allowed
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*SyntheticInjectableNewsProvider['"]/.test(text)) hits.push(path);
    }
    expect(hits).toEqual([]);
  });

  it('scripts/ (CLI launchers) never import SyntheticInjectableNewsProvider directly', () => {
    const scriptsRoot = join(ROOT, 'scripts');
    const files = listTsFiles(scriptsRoot);
    const hits: string[] = [];
    for (const f of files) {
      const text = readFileSync(f, 'utf8');
      if (/from ['"][^'"]*SyntheticInjectableNewsProvider['"]/.test(text)) hits.push(relative(ROOT, f));
    }
    expect(hits).toEqual([]);
  });

  it('NewsProviderManager.ts (the production constructor) never imports it', () => {
    const text = readFileSync(join(ROOT, 'src/server/news/NewsProviderManager.ts'), 'utf8');
    expect(/from ['"][^'"]*SyntheticInjectableNewsProvider['"]/.test(text)).toBe(false);
    expect(/new SyntheticInjectableNewsProvider/.test(text)).toBe(false);
  });
});

describe('Runtime proof: SyntheticInjectableNewsProvider fails closed outside SYNTHETIC_SIMULATION=true', () => {
  const original = process.env.SYNTHETIC_SIMULATION;

  afterEach(() => {
    if (original === undefined) delete process.env.SYNTHETIC_SIMULATION;
    else process.env.SYNTHETIC_SIMULATION = original;
  });

  it('constructor throws when SYNTHETIC_SIMULATION is not "true"', async () => {
    delete process.env.SYNTHETIC_SIMULATION;
    const { SyntheticInjectableNewsProvider } = await import('./SyntheticInjectableNewsProvider');
    expect(() => new SyntheticInjectableNewsProvider(() => Date.now())).toThrow(/SYNTHETIC_SIMULATION/);
  });

  it('inject() throws when SYNTHETIC_SIMULATION is not "true" even on an already-constructed instance', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { SyntheticInjectableNewsProvider } = await import('./SyntheticInjectableNewsProvider');
    const provider = new SyntheticInjectableNewsProvider(() => Date.now());
    delete process.env.SYNTHETIC_SIMULATION;
    expect(() => provider.inject({ title: 't', content: 'c', symbol: 'MSFT', publishedAtMs: Date.now() })).toThrow(/SYNTHETIC_SIMULATION/);
  });

  it('fetchLatest() throws when SYNTHETIC_SIMULATION is not "true"', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { SyntheticInjectableNewsProvider } = await import('./SyntheticInjectableNewsProvider');
    const provider = new SyntheticInjectableNewsProvider(() => Date.now());
    delete process.env.SYNTHETIC_SIMULATION;
    await expect(provider.fetchLatest()).rejects.toThrow(/SYNTHETIC_SIMULATION/);
  });

  it('withholds an article until simulated time reaches publishedAtMs, then delivers it exactly once', async () => {
    process.env.SYNTHETIC_SIMULATION = 'true';
    const { SyntheticInjectableNewsProvider } = await import('./SyntheticInjectableNewsProvider');
    let simNow = 1_000_000;
    const provider = new SyntheticInjectableNewsProvider(() => simNow);
    provider.inject({ title: 'Headline', content: 'Body', symbol: 'MSFT', publishedAtMs: 1_000_500 });

    // Before the article's own timestamp: withheld.
    expect(await provider.fetchLatest()).toEqual([]);
    expect(provider.pendingCount()).toBe(1);

    // Exactly at the article's timestamp: delivered.
    simNow = 1_000_500;
    const delivered = await provider.fetchLatest();
    expect(delivered).toHaveLength(1);
    expect(delivered[0].symbols).toEqual(['MSFT']);
    expect(delivered[0].publishedAt).toBe(new Date(1_000_500).toISOString());
    expect(provider.pendingCount()).toBe(0);

    // A later poll never re-delivers the same article.
    simNow = 2_000_000;
    expect(await provider.fetchLatest()).toEqual([]);
  });
});
