import { randomUUID } from "node:crypto";

export type JobKind = "message" | "relay";
export type JobStatus = "working" | "completed" | "failed";

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  reply?: string;
  error?: string;
  progress?: string;
  createdAt: number;
  updatedAt: number;
}

/** Terminal jobs are kept this long so a slow orchestrator (or the user) can still fetch them. */
const JOB_TTL_MS = 30 * 60 * 1000;
/** A "working" job older than this is presumed dead (instance restart, hung run) and swept. */
const JOB_MAX_AGE_MS = 20 * 60 * 1000;
/** Cap concurrent background jobs to protect the (free-tier) instance. */
export const MAX_ACTIVE_JOBS = 8;

/**
 * In-process registry of background teammate jobs. A job is started by a `message_teammate` /
 * `relay_teammates` tool call (which returns its `id` immediately) and driven to completion by a
 * detached async task; `get_teammate_reply` reads the result back by id. In-memory only — jobs do
 * not survive a redeploy (acceptable: same lifetime as the in-memory OAuth token store).
 */
export class JobStore {
  private readonly jobs = new Map<string, Job>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  create(kind: JobKind): Job {
    this.ensureSweeper();
    const t = this.now();
    const job: Job = { id: randomUUID(), kind, status: "working", createdAt: t, updatedAt: t };
    this.jobs.set(job.id, job);
    return job;
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  update(id: string, patch: Partial<Omit<Job, "id" | "kind" | "createdAt">>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.set(id, { ...job, ...patch, updatedAt: this.now() });
  }

  activeCount(): number {
    let n = 0;
    for (const job of this.jobs.values()) if (job.status === "working") n += 1;
    return n;
  }

  atCapacity(): boolean {
    return this.activeCount() >= MAX_ACTIVE_JOBS;
  }

  /** Drop terminal jobs past their TTL and working jobs past the max age (presumed dead). */
  sweep(): void {
    const t = this.now();
    for (const [id, job] of this.jobs) {
      const age = t - job.updatedAt;
      if (job.status === "working") {
        if (t - job.createdAt > JOB_MAX_AGE_MS) this.jobs.delete(id);
      } else if (age > JOB_TTL_MS) {
        this.jobs.delete(id);
      }
    }
  }

  private ensureSweeper(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweep(), 5 * 60 * 1000);
    this.sweepTimer.unref?.();
  }
}

/** Process-wide singleton used by the conversation tools. */
export const jobStore = new JobStore();
