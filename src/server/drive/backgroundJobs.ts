import { randomUUID } from 'node:crypto';

export type BackgroundJobKind = 'account_evacuate' | 'oauth_cold_sync';
export type BackgroundJobStatus = 'running' | 'completed' | 'failed';

export interface TrackedBackgroundJob<T = unknown> {
  id: string;
  kind: BackgroundJobKind;
  targetId: string;
  status: BackgroundJobStatus;
  startedAt: number;
  finishedAt: number | null;
  result?: T;
  error?: string;
}

const MAX_FINISHED_JOBS = 50;

const backgroundJobs = new Map<string, TrackedBackgroundJob>();

function pruneFinishedBackgroundJobs(): void {
  const finished = Array.from(backgroundJobs.values())
    .filter((job) => job.status !== 'running')
    .sort((a, b) => (a.finishedAt ?? 0) - (b.finishedAt ?? 0));

  const excess = finished.length - MAX_FINISHED_JOBS;
  for (let i = 0; i < excess; i++) {
    backgroundJobs.delete(finished[i].id);
  }
}

export function startBackgroundJob<T>(
  kind: BackgroundJobKind,
  targetId: string,
  fn: () => Promise<T>
): TrackedBackgroundJob<T> {
  const job: TrackedBackgroundJob<T> = {
    id: randomUUID(),
    kind,
    targetId,
    status: 'running',
    startedAt: Date.now(),
    finishedAt: null,
  };

  backgroundJobs.set(job.id, job);

  void fn()
    .then((result) => {
      job.status = 'completed';
      job.result = result;
      job.finishedAt = Date.now();
      pruneFinishedBackgroundJobs();
    })
    .catch((err) => {
      console.error(`Background job ${job.id} (${kind} for ${targetId}) failed:`, err);
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
      job.finishedAt = Date.now();
      pruneFinishedBackgroundJobs();
    });

  return job;
}

export function listBackgroundJobs(): TrackedBackgroundJob[] {
  return Array.from(backgroundJobs.values()).sort((a, b) => b.startedAt - a.startedAt);
}
