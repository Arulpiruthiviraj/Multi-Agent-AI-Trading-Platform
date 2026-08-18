/**
 * Loads config/allowedOperations.json — the sole allowlist for RemoteOperationsService.
 * Operators cannot pass arbitrary shell commands; jobId must match a key here.
 */
import { loadRepoConfigJson } from './loadRepoConfigJson';

export interface AllowedOperationJob {
  command: string;
  args: string[];
  timeoutMs: number;
  description: string;
}

export interface AllowedOperationsConfig {
  jobs: Record<string, AllowedOperationJob>;
}

function validateJob(id: string, job: AllowedOperationJob): void {
  if (typeof job.command !== 'string' || !job.command.trim()) {
    throw new Error(`config/allowedOperations.json job ${id}: command must be a non-empty string`);
  }
  if (!Array.isArray(job.args) || job.args.some((a) => typeof a !== 'string')) {
    throw new Error(`config/allowedOperations.json job ${id}: args must be a string array`);
  }
  if (typeof job.timeoutMs !== 'number' || !Number.isFinite(job.timeoutMs) || job.timeoutMs <= 0) {
    throw new Error(`config/allowedOperations.json job ${id}: timeoutMs must be a positive number`);
  }
  if (typeof job.description !== 'string' || !job.description.trim()) {
    throw new Error(`config/allowedOperations.json job ${id}: description must be a non-empty string`);
  }
}

function loadAllowedOperations(): AllowedOperationsConfig {
  const raw = loadRepoConfigJson<AllowedOperationsConfig>('allowedOperations.json');
  if (!raw.jobs || typeof raw.jobs !== 'object') {
    throw new Error('config/allowedOperations.json missing jobs object');
  }
  for (const [id, job] of Object.entries(raw.jobs)) {
    validateJob(id, job);
  }
  return raw;
}

export const allowedOperations = loadAllowedOperations();

export function getAllowedJob(jobId: string): AllowedOperationJob | undefined {
  return allowedOperations.jobs[jobId];
}

export function listAllowedJobIds(): string[] {
  return Object.keys(allowedOperations.jobs);
}
