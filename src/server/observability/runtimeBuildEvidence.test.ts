import { expect, it } from 'vitest';
import { verifyBuildMetadata } from './runtimeBuildEvidence';

it('refuses stale or malformed build manifests and preserves dirty-tree uncertainty', () => {
  const m = { schemaVersion: 1, builtAt: '2026-10-09T20:00:00Z', sourceSha: 'a'.repeat(40), sourceTreeDirty: true, serverSha256: 'b'.repeat(64) };
  expect(verifyBuildMetadata(m, 'c'.repeat(64)).status).toBe('UNKNOWN');
  expect(verifyBuildMetadata({ ...m, sourceTreeDirty: 'false' }, m.serverSha256).status).toBe('UNKNOWN');
  expect(verifyBuildMetadata(m, m.serverSha256)).toMatchObject({ status: 'MATCHED_ON_DISK_BUNDLE_AT_MODULE_LOAD', sourceTreeDirty: true });
});
