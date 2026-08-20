import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '../../..');

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), 'utf8');
}

describe('Argus Engine daemon architecture', () => {
  it('dedicated engine entry does not import React, Vite, or trading internals', () => {
    const src = read('scripts/argus-engine.ts');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/from ['"]react['"]/);
    expect(code).not.toMatch(/from ['"]vite['"]/);
    expect(code).not.toMatch(/from ['"][^'"]*RiskEngine/);
    expect(code).not.toMatch(/from ['"][^'"]*OrderManagement/);
    expect(code).not.toMatch(/from ['"][^'"]*BrokerManager/);
    expect(code).not.toContain('placeOrder(');
    expect(src).toContain('ARGUS_ENGINE');
    expect(src).toContain('ARGUS_HEADLESS');
  });

  it('ArgusEngineRuntime does not import a second OMS/RiskEngine/BrokerManager', () => {
    const src = read('src/server/engine/ArgusEngineRuntime.ts');
    const code = src.split('\n').filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//')).join('\n');
    expect(code).not.toMatch(/from ['"][^'"]*RiskEngine/);
    expect(code).not.toMatch(/from ['"][^'"]*OrderManagement/);
    expect(code).not.toMatch(/from ['"][^'"]*BrokerManager/);
    expect(code).not.toContain('placeOrder(');
    expect(src).toContain('argusRuntime');
  });

  it('ArgusCoreBoot does not import Vite or React', () => {
    const src = read('src/server/core/ArgusCoreBoot.ts');
    expect(src).not.toMatch(/from ['"]vite['"]/);
    expect(src).not.toMatch(/from ['"]react['"]/);
    expect(src).not.toContain("import('vite')");
  });

  it('Vite is dynamically imported and gated by isWebUiEnabled', () => {
    const src = read('server.ts');
    expect(src).not.toMatch(/^import .* from ["']vite["']/m);
    expect(src).toContain("await import('vite')");
    expect(src).toContain('isWebUiEnabled()');
  });

  it('WebSocket disconnect does not stop the engine', () => {
    const src = read('server.ts');
    const closeIdx = src.indexOf("ws.on('close'");
    expect(closeIdx).toBeGreaterThan(0);
    const closeBody = src.slice(closeIdx, closeIdx + 400);
    expect(closeBody).not.toContain('drainTradingProcess');
    expect(closeBody).not.toContain('system.stop');
    expect(closeBody).not.toContain('runtimeStop');
    expect(closeBody).toContain("eventBus.off");
  });

  it('headless scripts delegate to the engine entry', () => {
    expect(read('scripts/start-headless.ts')).toContain("argus-engine.ts");
    expect(read('scripts/start-headless-prod.mjs')).toContain('argus-engine-prod');
  });

  it('CLI start spawns argus-engine, not trading modules', () => {
    const src = read('scripts/argus-cli.ts');
    expect(src).toContain('argus-engine.ts');
    expect(src).not.toMatch(/from ['"].*RiskEngine/);
    expect(src).not.toMatch(/from ['"].*OrderManagement/);
  });
});
