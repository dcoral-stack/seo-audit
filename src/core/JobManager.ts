import { randomUUID } from 'node:crypto';
import type { JobState } from './types.js';

export interface Job {
  id: string;
  type: string;
  state: JobState;
  startedAt: string;
  updatedAt: string;
  progress: Record<string, unknown>;
  error?: string;
  result?: unknown;
}

/**
 * A plain-language pointer for SQLite corruption errors, which otherwise surface as a bare
 * "database disk image is malformed" with no next step (#33, #34). Empty for anything else.
 */
export function corruptionHint(error: string | undefined | null): string {
  if (!error) return '';
  return /SQLITE_CORRUPT|disk image is malformed|missing from index|database corrupt/i.test(error)
    ? ' (The property database looks damaged. Run data_storage with check:true to find the damaged index, then prune with action:"repair" to back up the file and rebuild it.)'
    : '';
}

type JobFn = (update: (p: Record<string, unknown>) => void, signal: AbortSignal) => Promise<unknown>;

/**
 * Generic async-job registry — the return-jobId-then-poll pattern that keeps
 * long operations (GSC sync, crawl) off the synchronous MCP tool-call path so
 * they never hit the client timeout. Mirrors better-search-console's sync model.
 */
export class JobManager {
  private jobs = new Map<string, Job>();
  private controllers = new Map<string, AbortController>();
  private readonly maxRetained: number;

  constructor(maxRetained = 50) {
    this.maxRetained = maxRetained;
  }

  start(type: string, fn: JobFn): string {
    const id = randomUUID().slice(0, 8);
    const now = new Date().toISOString();
    const job: Job = { id, type, state: 'running', startedAt: now, updatedAt: now, progress: {} };
    const controller = new AbortController();
    this.jobs.set(id, job);
    this.controllers.set(id, controller);
    this.prune();

    const update = (p: Record<string, unknown>): void => {
      job.progress = { ...job.progress, ...p };
      job.updatedAt = new Date().toISOString();
    };

    // Run detached — do NOT await. The tool returns the id immediately.
    // Promise.resolve().then(...) so a synchronous throw in fn becomes a rejection
    // (caught below) rather than an uncaught exception that crashes the MCP process.
    Promise.resolve()
      .then(() => fn(update, controller.signal))
      .then(result => {
        job.result = result;
        job.state = controller.signal.aborted ? 'cancelled' : 'completed';
        job.updatedAt = new Date().toISOString();
      })
      .catch((err: unknown) => {
        job.state = 'failed';
        job.error = err instanceof Error ? err.message : String(err);
        job.updatedAt = new Date().toISOString();
        // stdout is the MCP stdio channel, so failures go to stderr (the client's server log).
        console.error(`[job ${id}] ${type} failed: ${job.error}${corruptionHint(job.error)}`);
      })
      .finally(() => this.controllers.delete(id));

    return id;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  list(): Job[] {
    return [...this.jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  cancel(id: string): boolean {
    const c = this.controllers.get(id);
    if (!c) return false;
    c.abort();
    return true;
  }

  private prune(): void {
    if (this.jobs.size <= this.maxRetained) return;
    const done = [...this.jobs.values()]
      .filter(j => j.state === 'completed' || j.state === 'failed' || j.state === 'cancelled')
      .sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1));
    while (this.jobs.size > this.maxRetained && done.length) {
      this.jobs.delete(done.shift()!.id);
    }
  }
}
