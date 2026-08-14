import { describe, it, expect } from 'vitest';
import { scanLines, isCommentLine } from './scan_unallowlisted_writes';

describe('scanLines - Phase 4C raw-write scanner', () => {
  it('detects a direct, unfiltered .values(req.body) - the exact real pattern from Section 16', () => {
    const findings = scanLines([
      "app.post('/settings', (req, res) => {",
      '  db.insert(schema.settings).values(req.body);',
      '});',
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].line).toBe(2);
  });

  it('detects a spread of req.body inside .values({...}) - the exact real pattern from Section 22.3', () => {
    const findings = scanLines([
      'db.insert(schema.brokerConnections).values({',
      '  brokerName,',
      '  ...req.body,',
      '});',
    ]);
    expect(findings.length).toBeGreaterThanOrEqual(1);
  });

  it('detects Object.assign(state, req.body) - the exact real pattern from the P0 autobot/toggle bug', () => {
    const findings = scanLines(['Object.assign(tradingEngine.state, req.body);']);
    expect(findings).toHaveLength(1);
  });

  it('detects a raw .set(req.body) update', () => {
    const findings = scanLines(['await db.update(schema.settings).set(req.body).run();']);
    expect(findings).toHaveLength(1);
  });

  it('does NOT flag a properly allowlisted write - only specific, named fields reach .values()/.set()', () => {
    const findings = scanLines([
      'const patch = {};',
      'for (const field of SETTINGS_ALLOWED_FIELDS) {',
      '  if (Object.prototype.hasOwnProperty.call(req.body, field)) patch[field] = req.body[field];',
      '}',
      'await db.update(schema.settings).set(patch).run();',
    ]);
    expect(findings).toHaveLength(0);
  });

  it('does NOT flag a destructured-and-filtered spread (the real fix pattern from Section 22.3/23.4)', () => {
    const findings = scanLines([
      'const { brokerName, apiKeyEncrypted, apiSecretEncrypted, paperMode, ...rest } = req.body;',
      'await db.insert(schema.brokerConnections).values({',
      '  brokerName, apiKeyEncrypted, ...rest, paperMode: true,',
      '});',
    ]);
    expect(findings).toHaveLength(0);
  });

  it('never flags a code comment that merely documents a real past bug for posterity - the exact false positive found and fixed this pass', () => {
    const findings = scanLines([
      '// Real bug found and fixed this pass:',
      '// POST /settings used to do `db.delete(schema.settings); db.insert(schema.settings).values(req.body)`',
      '// - a full delete-and-recreate using the RAW client body.',
      'await db.update(schema.settings).set(patch).run(); // the real fix',
    ]);
    expect(findings).toHaveLength(0);
  });

  it('reports the correct file path when scanning', () => {
    const findings = scanLines(['db.insert(x).values(req.body);'], 'src/server/routes/fake.ts');
    expect(findings[0].file).toBe('src/server/routes/fake.ts');
  });
});

describe('isCommentLine', () => {
  it('recognizes // line comments', () => {
    expect(isCommentLine('  // a comment')).toBe(true);
  });

  it('recognizes block-comment continuation lines', () => {
    expect(isCommentLine('   * still inside a block comment')).toBe(true);
  });

  it('does not flag real code as a comment', () => {
    expect(isCommentLine('  const x = req.body;')).toBe(false);
  });
});
