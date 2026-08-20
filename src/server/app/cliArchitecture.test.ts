import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

describe('CLI architecture', () => {
  it('argus-cli does not import trading brain modules', () => {
    const src = readFileSync(join(ROOT, 'scripts/argus-cli.ts'), 'utf8');
    const codeLines = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'));
    const code = codeLines.join('\n');
    const forbidden = [
      'from \'../src/server/engines',
      'from "../src/server/engines',
      'from \'../src/server/services/OrderManagement',
      'placeOrder(',
      'evaluateRisk(',
    ];
    for (const token of forbidden) {
      expect(code).not.toContain(token);
    }
    expect(src).toContain('fetch(');
    expect(src).toContain('/api/v2/runtime');
  });

  it('v2Runtime routes delegate to ArgusRuntime/ArgusApplication', () => {
    const src = readFileSync(join(ROOT, 'src/server/routes/v2Runtime.ts'), 'utf8');
    expect(src).not.toContain('placeOrder(');
    expect(src).not.toContain('evaluateRisk(');
    expect(src).toContain('argusRuntime');
    expect(src).toContain('argusApplication');
  });
});
