/**
 * In-memory store for async `POST /plan` jobs (planJob: true).
 * Checkpoints hold finalized solver-attempt rows (see `onSolverAttempt` in planner).
 */

import type { PlanTripResponse } from "./types";

export type PlanJobStatus = "pending" | "running" | "complete" | "error";

export type PlanJobCheckpoint = {
  t: number;
  legIndex: number;
  attempt: Record<string, unknown>;
};

export type PlanJobRecord = {
  requestId: string;
  responseVersion: string;
  status: PlanJobStatus;
  createdAt: number;
  updatedAt: number;
  checkpoints: PlanJobCheckpoint[];
  /** Latest cumulative partial route snapshot emitted by planner checkpoints. */
  latestPartialSnapshot?: {
    stops: unknown[];
    legs: unknown[];
    rangeLegs?: unknown[];
    legIndex: number;
    stopsCount: number;
    t: number;
  };
  /** Present when status is complete — same shape as synchronous `POST /plan` body. */
  result?: PlanTripResponse & { debug?: Record<string, unknown> };
  /** Present when status is error */
  error?: {
    message: string;
    httpStatus: number;
    debug?: Record<string, unknown>;
    lastPartialSnapshot?: {
      stops: unknown[];
      legs: unknown[];
      rangeLegs?: unknown[];
      legIndex: number;
      stopsCount: number;
      t: number;
    };
  };
};

const MAX_JOBS = 500;
const JOB_TTL_MS = 60 * 60 * 1000;

const jobs = new Map<string, PlanJobRecord>();

/** Incremental NDJSON stream subscribers — notified on checkpoint / terminal (same process, in-memory). */
const streamSubscribers = new Map<string, Set<() => void>>();

function notifyPlanJobStreamSubscribers(jobId: string): void {
  const set = streamSubscribers.get(jobId);
  if (!set) return;
  for (const cb of set) {
    try {
      cb();
    } catch {
      // ignore subscriber errors
    }
  }
}

function prune(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.updatedAt > JOB_TTL_MS) {
      jobs.delete(id);
    }
  }
  if (jobs.size <= MAX_JOBS) return;
  const sorted = [...jobs.entries()].sort((a, b) => a[1].createdAt - b[1].createdAt);
  while (sorted.length > MAX_JOBS) {
    const [id] = sorted.shift()!;
    jobs.delete(id);
  }
}

function cloneAttempt(attempt: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(attempt)) as Record<string, unknown>;
}

export function createPlanJob(params: {
  jobId: string;
  requestId: string;
  responseVersion: string;
}): void {
  prune();
  const now = Date.now();
  jobs.set(params.jobId, {
    requestId: params.requestId,
    responseVersion: params.responseVersion,
    status: "running",
    createdAt: now,
    updatedAt: now,
    checkpoints: []
  });
}

export function appendPlanJobCheckpoint(
  jobId: string,
  ev: { legIndex: number; attempt: Record<string, unknown> }
): void {
  const job = jobs.get(jobId);
  if (!job || job.status !== "running") return;
  const row = {
    t: Date.now(),
    legIndex: ev.legIndex,
    attempt: cloneAttempt(ev.attempt)
  };
  job.checkpoints.push(row);
  const kind = typeof ev.attempt?.kind === "string" ? ev.attempt.kind : "";
  if (kind === "partial_route") {
    const ps = (ev.attempt as { partialSnapshot?: unknown }).partialSnapshot;
    if (ps && typeof ps === "object") {
      const p = ps as { stops?: unknown[]; legs?: unknown[]; rangeLegs?: unknown[] };
      if (Array.isArray(p.stops) && Array.isArray(p.legs)) {
        const prior = job.latestPartialSnapshot;
        const nextStops = p.stops.length;
        const priorStops = prior?.stopsCount ?? -1;
        const priorLeg = prior?.legIndex ?? -1;
        // Monotonic update: never regress to earlier leg/shallower snapshot.
        // In particular, never overwrite a larger cumulative `stopsCount` with a smaller
        // leg-local quick preview.
        if (ev.legIndex >= priorLeg && nextStops >= priorStops) {
          job.latestPartialSnapshot = {
            stops: JSON.parse(JSON.stringify(p.stops)),
            legs: JSON.parse(JSON.stringify(p.legs)),
            ...(Array.isArray(p.rangeLegs)
              ? { rangeLegs: JSON.parse(JSON.stringify(p.rangeLegs)) }
              : {}),
            legIndex: ev.legIndex,
            stopsCount: nextStops,
            t: row.t
          };
        }
      }
    }
  }
  job.updatedAt = Date.now();
  notifyPlanJobStreamSubscribers(jobId);
}

export function completePlanJob(
  jobId: string,
  result: PlanTripResponse & { debug?: Record<string, unknown> }
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "complete";
  job.result = result;
  job.updatedAt = Date.now();
  notifyPlanJobStreamSubscribers(jobId);
}

export function failPlanJob(
  jobId: string,
  err: {
    message: string;
    httpStatus: number;
    debug?: Record<string, unknown>;
    lastPartialSnapshot?: {
      stops: unknown[];
      legs: unknown[];
      rangeLegs?: unknown[];
      legIndex: number;
      stopsCount: number;
      t: number;
    };
  }
): void {
  const job = jobs.get(jobId);
  if (!job) return;
  job.status = "error";
  job.error = {
    ...err,
    ...(err.lastPartialSnapshot
      ? { lastPartialSnapshot: err.lastPartialSnapshot }
      : job.latestPartialSnapshot
        ? { lastPartialSnapshot: job.latestPartialSnapshot }
        : {})
  };
  job.updatedAt = Date.now();
  notifyPlanJobStreamSubscribers(jobId);
}

/**
 * NDJSON stream: replay existing checkpoints, then receive updates until `complete` or `error`.
 * `writeLine` is called synchronously; `onEnd` when the stream body should close (terminal or job gone).
 * Returns unsubscribe (removes listener; if the response is still open, caller should `res.end()`).
 */
export function subscribePlanJobStream(
  jobId: string,
  writeLine: (obj: Record<string, unknown>) => void,
  onEnd: () => void
): () => void {
  const job = jobs.get(jobId);
  if (!job) {
    onEnd();
    return () => {};
  }

  let len = 0;
  let ended = false;

  const flush = () => {
    if (ended) return;
    const j = jobs.get(jobId);
    if (!j) {
      cleanupTerminal();
      return;
    }
    while (len < j.checkpoints.length) {
      writeLine({
        type: "checkpoint",
        jobId,
        requestId: j.requestId,
        responseVersion: j.responseVersion,
        checkpoint: j.checkpoints[len]
      });
      len++;
    }
    if (j.status === "complete" && j.result) {
      writeLine({
        type: "complete",
        jobId,
        requestId: j.requestId,
        responseVersion: j.responseVersion,
        result: j.result
      });
      cleanupTerminal();
    } else if (j.status === "error" && j.error) {
      const err = j.error;
      writeLine({
        type: "error",
        jobId,
        requestId: j.requestId,
        message: err.message,
        httpStatus: err.httpStatus,
        debug: err.debug,
        lastPartialSnapshot: err.lastPartialSnapshot
      });
      cleanupTerminal();
    }
  };

  const cb = () => {
    flush();
  };

  const removeFromSubscribers = () => {
    const set = streamSubscribers.get(jobId);
    if (set) {
      set.delete(cb);
      if (set.size === 0) streamSubscribers.delete(jobId);
    }
  };

  const cleanupTerminal = () => {
    if (ended) return;
    ended = true;
    removeFromSubscribers();
    onEnd();
  };

  let set = streamSubscribers.get(jobId);
  if (!set) {
    set = new Set();
    streamSubscribers.set(jobId, set);
  }
  set.add(cb);
  flush();

  if (ended) {
    return () => {};
  }

  return () => {
    removeFromSubscribers();
    if (!ended) {
      ended = true;
      onEnd();
    }
  };
}

export function getPlanJob(jobId: string): PlanJobRecord | undefined {
  const job = jobs.get(jobId);
  if (!job) return undefined;
  if (Date.now() - job.updatedAt > JOB_TTL_MS) {
    jobs.delete(jobId);
    return undefined;
  }
  return job;
}
