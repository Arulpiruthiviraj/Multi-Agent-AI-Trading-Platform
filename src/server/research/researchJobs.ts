export type ResearchJobStatus = 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';

export interface ResearchJob {
  jobId: string;
  strategyId: string;
  datasetId: string;
  parameters: Record<string, unknown>;
  engine: string;
  engineUsed: string;
  startedAt: string | null;
  completedAt: string | null;
  status: ResearchJobStatus;
  resultLocation: string | null;
  error: string | null;
  result: unknown;
}

const jobs = new Map<string, ResearchJob>();

export function createJob(partial: Omit<ResearchJob, 'jobId' | 'startedAt' | 'completedAt' | 'status' | 'resultLocation' | 'error' | 'result' | 'engineUsed'> & { engineUsed?: string }): ResearchJob {
  const jobId = `rj_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const row: ResearchJob = {
    ...partial,
    jobId,
    engineUsed: partial.engineUsed ?? 'unspecified',
    startedAt: null,
    completedAt: null,
    status: 'QUEUED',
    resultLocation: null,
    error: null,
    result: null,
  };
  jobs.set(jobId, row);
  return row;
}

export function getJob(id: string): ResearchJob | undefined {
  return jobs.get(id);
}

export function updateJob(id: string, patch: Partial<ResearchJob>): ResearchJob | undefined {
  const cur = jobs.get(id);
  if (!cur) return undefined;
  const next = { ...cur, ...patch };
  jobs.set(id, next);
  return next;
}
