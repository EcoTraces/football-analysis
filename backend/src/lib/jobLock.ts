import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";

// One random id per process, not per job — identifies which backend
// instance currently holds a given job's lock (job_locks.locked_by),
// mostly useful for reading job_locks directly during an incident (which
// instance is stuck holding this?). Generated once at module load, not per
// call, so every acquire attempt from this process reports the same holder.
export const PROCESS_INSTANCE_ID: string = randomUUID();

// Generous relative to how long any of this app's scheduled jobs actually
// take (the slowest, syncTeamStatistics, is a bounded loop over already-
// deduplicated combinations with its own per-item timeouts) — the cost of
// too-generous a TTL is a late double-run only if an instance crashes
// mid-job; the cost of too-short a TTL is a false "still locked" on a job
// that's simply taking a while.
export const DEFAULT_JOB_LOCK_TTL_SECONDS = 30 * 60;

// Tries to claim `jobName` for this process via try_acquire_job_lock
// (0016_job_locks.sql) — an atomic, race-free claim-or-steal-if-expired
// done inside Postgres itself, not a separate select-then-upsert from here
// (see that migration's own comment for why that distinction matters).
// Returns false (never throws) on an RPC failure too — this app's
// single-instance deployment today (render.yaml) means "couldn't confirm
// the lock, so skip this run" is always safe: the next scheduled tick
// tries again, same as any other skipped run.
export async function acquireJobLock(
  supabase: SupabaseClient,
  jobName: string,
  logger: Logger,
  ttlSeconds: number = DEFAULT_JOB_LOCK_TTL_SECONDS
): Promise<boolean> {
  const { data, error } = await supabase.rpc("try_acquire_job_lock", {
    p_job_name: jobName,
    p_holder: PROCESS_INSTANCE_ID,
    p_ttl_seconds: ttlSeconds
  });
  if (error) {
    logger.error({ err: error, job: jobName }, "Failed to acquire job lock — skipping this run");
    return false;
  }
  return data === true;
}
