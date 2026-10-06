/**
 * Reflection screen import discipline (2026-10-06, workstream J).
 *
 * Extends the architecture.protection.test.ts pattern for one screen: the
 * Daily Reflection page is presentation-only — it may import React/Ink and
 * the TUI's own presentation modules (api.js, components.js, theme.js) and
 * nothing else. No DB, no engine, no trading modules, no mutating requests.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = readFileSync(join(process.cwd(), 'scripts', 'tui', 'screens', 'Reflection.tsx'), 'utf8');

const ALLOWED_IMPORTS = ['react', 'ink', '../api.js', '../components.js', '../theme.js'];

describe('Reflection screen import discipline', () => {
  it('imports only presentation-layer modules', () => {
    const imports = [...SRC.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const imp of imports) {
      expect(ALLOWED_IMPORTS, `import of "${imp}" is not presentation-layer`).toContain(imp);
    }
  });

  it('touches no DB/engine/trading modules', () => {
    for (const token of ['better-sqlite3', 'server/db', 'BrokerManager', 'RiskEngine', 'TradingEngine', 'placeOrder', 'submitOrder']) {
      expect(SRC).not.toContain(token);
    }
  });

  it('issues no mutating HTTP requests', () => {
    for (const method of ["method: 'POST'", 'method: "POST"', "method: 'PUT'", 'method: "PUT"', "method: 'DELETE'"]) {
      expect(SRC).not.toContain(method);
    }
  });

  it('reads only the daily-reflection GET endpoint', () => {
    expect(SRC).toContain('dailyReflection');
    expect(SRC).not.toMatch(/fetch\(/);
  });
});
