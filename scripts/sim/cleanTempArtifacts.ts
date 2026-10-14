/** CLI: remove stale unit-test temp leftovers (never protected evidence). Usage: tsx scripts/sim/cleanTempArtifacts.ts [--dry-run] */
import { cleanTestArtifacts, defaultTmpDir, freeDiskGb, loadArtifactPolicy } from './artifactLifecycle';

const policy = loadArtifactPolicy();
const dry = process.argv.includes('--dry-run');
const r = cleanTestArtifacts(defaultTmpDir(), policy, { dryRun: dry });
console.log(JSON.stringify({ dryRun: dry, removed: r.removed.length, skippedProtected: r.skippedProtected.length, skippedRecent: r.skippedRecent.length, freeGb: +freeDiskGb(defaultTmpDir()).toFixed(1) }));
