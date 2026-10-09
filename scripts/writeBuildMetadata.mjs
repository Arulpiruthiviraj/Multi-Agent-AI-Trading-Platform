/** Production provenance only; never reads environment secrets or grants trading authority. */
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
let sourceSha = null;
let sourceTreeDirty = null;
try {
  sourceSha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  sourceTreeDirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim().length > 0;
} catch { /* unavailable is not an invented revision */ }
const serverSha256 = createHash('sha256').update(readFileSync(resolve('dist/server.cjs'))).digest('hex');
writeFileSync(resolve('dist/build-metadata.json'), JSON.stringify({ schemaVersion: 1, builtAt: new Date().toISOString(), sourceSha, sourceTreeDirty, serverSha256 }, null, 2));
