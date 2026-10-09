import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

export function verifyBuildMetadata(raw: unknown, bundleDigest: string) {
  const m = raw as Record<string, unknown> | null;
  if (!m || m.schemaVersion !== 1 || !/^[a-f0-9]{64}$/.test(bundleDigest) || m.serverSha256 !== bundleDigest
    || typeof m.builtAt !== 'string' || !Number.isFinite(Date.parse(m.builtAt))
    || (m.sourceSha !== null && (typeof m.sourceSha !== 'string' || !/^[a-f0-9]{40}$/.test(m.sourceSha)))
    || (m.sourceTreeDirty !== null && typeof m.sourceTreeDirty !== 'boolean')) return { status: 'UNKNOWN' as const };
  return { status: 'MATCHED_ON_DISK_BUNDLE_AT_MODULE_LOAD' as const, schemaVersion: m.schemaVersion,
    builtAt: m.builtAt, sourceSha: m.sourceSha, sourceTreeDirty: m.sourceTreeDirty, serverSha256: m.serverSha256,
    limitation: 'Local build provenance, not independent attestation of executed bytes. Dirty trees are not identified by commit alone.' };
}
const startupBuildEvidence = (() => {
  if (process.env.NODE_ENV !== 'production') return { status: 'UNKNOWN' as const, reason: 'NOT_PRODUCTION_BUNDLE' };
  const entry = resolve(process.argv[1] ?? '');
  if (![resolve('scripts/argus-engine-prod.mjs'), resolve('dist/server.cjs')].includes(entry)) return { status: 'UNKNOWN' as const, reason: 'UNVERIFIED_ENTRY_POINT' };
  try {
    const bundleDigest = createHash('sha256').update(readFileSync(resolve('dist/server.cjs'))).digest('hex');
    return verifyBuildMetadata(JSON.parse(readFileSync(resolve('dist/build-metadata.json'), 'utf8')), bundleDigest);
  } catch { return { status: 'UNKNOWN' as const, reason: 'BUILD_METADATA_UNAVAILABLE' }; }
})();
export function getRuntimeBuildEvidence() { return startupBuildEvidence; }
