import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

describe('MissedOpportunityAnalysis architecture', () => {
  it('post-run analysis cannot emit trade ideas or place orders', () => {
    const src = readFileSync(join(ROOT, 'src/server/replay/MissedOpportunityAnalysis.ts'), 'utf8');
    expect(src).not.toMatch(/emitTradeIdea|placeOrder|CHIEF_APPROVED_IDEA|eventBus\.emit/);
    expect(src).toContain('AFTER-THE-FACT ANALYSIS');
    const engine = readFileSync(join(ROOT, 'src/server/replay/FullArgusReplayEngine.ts'), 'utf8');
    const moIdx = engine.indexOf('analyzeMissedOpportunities(');
    const processIdx = engine.indexOf('async function processTimestamp');
    expect(moIdx).toBeGreaterThan(0);
    expect(processIdx).toBeGreaterThan(0);
    // analyzeMissedOpportunities is only invoked after the replay loop completes, not inside processTimestamp
    const processBody = engine.slice(processIdx, processIdx + 12000);
    expect(processBody).not.toContain('analyzeMissedOpportunities(');
  });
});
