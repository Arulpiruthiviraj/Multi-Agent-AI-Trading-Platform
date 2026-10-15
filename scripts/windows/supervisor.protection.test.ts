import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (f: string) => fs.readFileSync(path.resolve(__dirname, f), 'utf8');
const stripBlockComments = (s: string) => s.replace(/<#[\s\S]*?#>/g, '');
const stripLineComments = (s: string) => s.replace(/^\s*#.*$/gm, '');

describe('Windows supervisor safety invariants (static)', () => {
  const sup = read('argus-supervisor.ps1');
  const inst = read('install-argus-supervisor.ps1');
  const code = stripLineComments(stripBlockComments(sup));

  it('only invokes start (no flags), watchdog-start and reconciliation-status via argus.ps1', () => {
    const re = /&\s*(?:\$argusCmd|\(Join-Path \$RepoRoot 'argus\.ps1'\))\s+([a-z-]+)([^\r\n|]*)/g;
    const matches = [...code.matchAll(re)];
    expect(matches.map((m) => m[1]).sort()).toEqual(['reconciliation-status', 'start', 'watchdog-start']);
    for (const m of matches) expect(m[2]).not.toMatch(/--|enable-trading|resume/i);
  });

  it('never resumes trading and contains no database, order or LIVE_ARM operations', () => {
    expect(code).not.toMatch(/LIVE_ARM|placeOrder|sqlite|argus\.db|Invoke-RestMethod|-Method\s+(Post|Put|Delete)/i);
  });

  it('refuses to run unless the repo .env says PAPER_TRADING_ONLY=true', () => {
    expect(code).toMatch(/PAPER_TRADING_ONLY/);
    expect(code).toMatch(/REFUSED/);
  });

  it('never restarts a healthy engine', () => {
    expect(code).toMatch(/engine already healthy - no action/);
  });

  it('installer is a dry run unless -Apply is passed', () => {
    expect(inst).toMatch(/\[switch\]\$Apply/);
    expect(inst).toMatch(/DRY RUN: nothing registered/);
    expect(inst).toMatch(/if \(-not \$Apply\)/);
  });
});
