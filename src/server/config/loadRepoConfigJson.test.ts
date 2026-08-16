import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadRepoConfigJson } from './loadRepoConfigJson';
import { configJsonCandidates } from './repoPaths';

describe('loadRepoConfigJson', () => {
  it('loads tradingSafety from cwd/config without import.meta', () => {
    const src = readFileSync(join(process.cwd(), 'src/server/config/loadRepoConfigJson.ts'), 'utf8');
    expect(src).not.toMatch(/import\.meta/);
    const pathsSrc = readFileSync(join(process.cwd(), 'src/server/config/repoPaths.ts'), 'utf8');
    expect(pathsSrc).not.toMatch(/import\.meta\.url/);
    const cfg = loadRepoConfigJson<{ maxDailyBuyNotionalDollars: number }>('tradingSafety.json');
    expect(cfg.maxDailyBuyNotionalDollars).toBeGreaterThan(0);
    expect(configJsonCandidates('tradingSafety.json')[0]).toMatch(/tradingSafety\.json$/);
  });
});
