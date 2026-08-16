import { createHash } from 'node:crypto';
import { replaySafety } from './replaySafety';
import type { ReplayConfig } from './ReplayContext';

export function hashReplayConfiguration(config: ReplayConfig): string {
  const payload = JSON.stringify({
    ...config,
    replayEngineVersion: replaySafety.replayEngineVersion,
  });
  return `sha256:${createHash('sha256').update(payload).digest('hex')}`;
}

export function hashReplayIdentity(opts: {
  datasetHash: string;
  configurationHash: string;
  strategyVersions: string[];
  argusVersion: string;
}): string {
  return `sha256:${createHash('sha256').update(JSON.stringify({
    ...opts,
    replayEngineVersion: replaySafety.replayEngineVersion,
  })).digest('hex')}`;
}
