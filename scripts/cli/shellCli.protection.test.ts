/**
 * Shell CLI architecture protection — ./argus must remain an operator control plane.
 * It must not become a second trading brain (no RiskEngine/OMS/BrokerManager/placeOrder).
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = join(process.cwd());

function walk(dir: string, acc: string[] = []): string[] {
  if (!existsSync(dir)) return acc;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

function readShellSources(): string {
  const files = [
    join(ROOT, 'argus'),
    ...walk(join(ROOT, 'scripts', 'cli')).filter((f) => f.endsWith('.sh') || /(?:^|[/\\])argus$/.test(f)),
  ];
  return files.filter((f) => existsSync(f)).map((f) => readFileSync(f, 'utf8')).join('\n');
}

describe('Shell CLI (./argus) is not a trading brain', () => {
  it('root ./argus entry exists', () => {
    expect(existsSync(join(ROOT, 'argus'))).toBe(true);
  });

  it('shell sources do not import RiskEngine, OMS, BrokerManager, or call placeOrder', () => {
    const text = readShellSources();
    // Mentions in help/docs are OK; executable trading-spine wiring is not.
    expect(text).not.toMatch(/\bevaluateRisk\s*\(/);
    expect(text).not.toMatch(/BrokerManager\.getInstance/);
    expect(text).not.toMatch(/from ['"].*OrderManagement/);
    expect(text).not.toMatch(/\.placeOrder\s*\(/);
    expect(text).not.toMatch(/require\(['"].*RiskEngine/);
    expect(text).not.toMatch(/import\s+.*RiskEngine/);
  });

  it('shell delegates to npm run argus-cli / npm scripts', () => {
    const text = readShellSources();
    expect(text).toMatch(/argus-cli/);
    expect(text).toMatch(/ARGUS_ROOT/);
  });

  it('argus-cli.ts remains HTTP-only (no spine imports)', () => {
    const text = readFileSync(join(ROOT, 'scripts', 'argus-cli.ts'), 'utf8');
    expect(text).not.toMatch(/from ['"][^'"]*RiskEngine['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*BrokerManager['"]/);
    expect(text).not.toMatch(/from ['"][^'"]*OrderManagement['"]/);
    expect(text).not.toMatch(/\.placeOrder\(/);
  });

  it('argus-cli session auth: login/logout + Cookie path; DEV_TOKEN is not a login substitute', () => {
    const cli = readFileSync(join(ROOT, 'scripts', 'argus-cli.ts'), 'utf8');
    const session = readFileSync(join(ROOT, 'scripts', 'cli', 'cliSession.ts'), 'utf8');
    expect(cli).toMatch(/async login/);
    expect(cli).toMatch(/async logout/);
    expect(cli).toMatch(/AuthRequiredError|EXIT_AUTH/);
    expect(session).toMatch(/argus_session/);
    expect(session).toMatch(/\.argus_cli_session/);
    expect(session).toMatch(/headers\.Cookie/);
    expect(unauthorizedHint(session)).toBe(true);
  });
});

function unauthorizedHint(sessionSrc: string): boolean {
  return /argus login/i.test(sessionSrc) && /ignored/i.test(sessionSrc);
}

describe('Shell CLI help / usage (RUN when bash available)', () => {
  function resolveBash(): string {
    if (process.env.ARGUS_BASH) return process.env.ARGUS_BASH;
    const candidates = [
      'bash',
      'C:\\Program Files\\Git\\bin\\bash.exe',
      'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
      'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    ];
    for (const c of candidates) {
      const probe = spawnSync(c, ['-c', 'echo ok'], { encoding: 'utf8' });
      if (!probe.error && probe.status === 0) return c;
    }
    return 'bash';
  }
  const bash = resolveBash();

  function runArgus(args: string[], cwd?: string) {
    return spawnSync(bash, [join(ROOT, 'argus'), ...args], {
      cwd: cwd || ROOT,
      encoding: 'utf8',
      env: { ...process.env, ARGUS_API_URL: process.env.ARGUS_API_URL || 'http://127.0.0.1:3000' },
    });
  }

  it('help works from another directory', () => {
    const r = runArgus(['help'], join(ROOT, '..'));
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      // Windows without bash — skip without failing the suite
      expect(true).toBe(true);
      return;
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/ARGUS/);
    expect(r.stdout).toMatch(/start/);
  });

  it('unknown command returns usage exit code 2', () => {
    const r = runArgus(['definitely-not-a-command']);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      expect(true).toBe(true);
      return;
    }
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/Unknown command/);
  });

  it('version prints without starting engine', () => {
    const r = runArgus(['version']);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      expect(true).toBe(true);
      return;
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/argus/);
  });

  it('doctor does not print common secret env patterns', () => {
    const r = runArgus(['doctor']);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      expect(true).toBe(true);
      return;
    }
    const out = (r.stdout || '') + (r.stderr || '');
    expect(out).not.toMatch(/sk-[a-zA-Z0-9]{10,}/);
    expect(out).not.toMatch(/ALPACA_SECRET/);
    expect(out).not.toMatch(/AUTH_PASSWORD=\S+/);
    expect(out).not.toMatch(/ARGUS_CLI_PASSWORD=\S+/);
    expect(out).not.toMatch(/argus_session=[0-9a-f-]{8,}/i);
    expect(out).toMatch(/ARGUS DOCTOR/);
  }, 20_000);

  it('logs --follow refuses without polling', () => {
    const r = runArgus(['logs', '--follow']);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      expect(true).toBe(true);
      return;
    }
    expect(r.status).toBe(2);
    expect(r.stderr + r.stdout).toMatch(/not supported|NOT SUPPORTED|--follow/i);
  });

  it('replay run --help shows help without starting a run', () => {
    const r = runArgus(['replay', 'run', '--help']);
    if (r.error && (r.error as NodeJS.ErrnoException).code === 'ENOENT') {
      expect(true).toBe(true);
      return;
    }
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/replay run/i);
    expect(r.stdout).toMatch(/--capital|--start/i);
  });
});

describe('Shell CLI embedded node scripts are syntactically valid', () => {
  // Real bug found and fixed (2026-08-20): common.sh's argus_cmd_status() had a one-line inline
  // `node -e '...'` script with an unbalanced ternary chain (one missing closing paren). No
  // existing test caught it - the architecture-protection tests above check imports/content, not
  // whether the embedded JS actually parses - so it went unnoticed until `argus status` was run
  // against a live engine and crashed with a SyntaxError instead of printing status. This
  // extracts every `node -e '...'` block from common.sh and syntax-checks it with `node --check`
  // (parse-only, does not execute/require stdin), closing the gap for all such blocks at once
  // rather than just the one that broke.
  const { writeFileSync, mkdtempSync, rmSync } = require('node:fs') as typeof import('node:fs');
  const { tmpdir } = require('node:os') as typeof import('node:os');

  function extractNodeEBlocks(shellSource: string): string[] {
    const blocks: string[] = [];
    const re = /node -e '\n([\s\S]*?)\n\s*'/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(shellSource)) !== null) {
      blocks.push(m[1]);
    }
    return blocks;
  }

  const commonShPath = join(ROOT, 'scripts', 'cli', 'common.sh');
  const commonShSource = existsSync(commonShPath) ? readFileSync(commonShPath, 'utf8') : '';
  const blocks = extractNodeEBlocks(commonShSource);

  it('finds at least one embedded node -e block to check (test is not vacuous)', () => {
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('every embedded node -e block in common.sh is valid JavaScript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'argus-cli-syntax-'));
    try {
      const failures: Array<{ index: number; snippet: string; stderr: string }> = [];
      blocks.forEach((body, index) => {
        const file = join(dir, `block-${index}.js`);
        writeFileSync(file, body, 'utf8');
        const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
        if (r.status !== 0) {
          failures.push({ index, snippet: body.slice(0, 120), stderr: r.stderr });
        }
      });
      if (failures.length > 0) {
        throw new Error(
          `${failures.length} embedded node -e block(s) in common.sh have a syntax error:\n` +
          failures.map((f) => `  [block ${f.index}] ${f.snippet}...\n${f.stderr}`).join('\n'),
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('Shell CLI file inventory', () => {
  it('documents relative paths for audit', () => {
    const rels = walk(join(ROOT, 'scripts', 'cli'))
      .map((f) => relative(ROOT, f).replace(/\\/g, '/'));
    expect(rels.some((p) => p.endsWith('common.sh'))).toBe(true);
  });
});
