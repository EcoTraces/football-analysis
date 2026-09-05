-- Cross-process lock for the scheduler (Road_map.md's own next-step #7 —
-- "before running more than one backend replica in production, address
-- the scheduler's single-instance assumption"). node-cron
-- (backend/src/scheduler/scheduler.ts) has no coordination between
-- processes on its own, so more than one backend instance would sync
-- everything N times over. This Blueprint (render.yaml) still deploys a
-- single `plan: free` instance, so this is defense-in-depth for the day
-- that changes, not a fix for a bug hit today.
--
-- A plain table lock checked-then-set from JS would race: two instances
-- could both read "unlocked" before either writes. try_acquire_job_lock
-- avoids that by doing the check-and-claim as one atomic statement inside
-- Postgres itself (INSERT ... ON CONFLICT DO UPDATE ... WHERE) rather than
-- a separate select-then-upsert round trip — the first caller to reach
-- Postgres wins the row, full stop, regardless of how many instances call
-- it in the same instant.
create table if not exists job_locks (
  job_name text primary key,
  locked_by text not null,
  locked_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- Returns true if the caller now holds the lock (either no lock existed,
-- or the existing one had already expired), false if another holder's
-- lock is still live. A TTL, not an explicit release, because a crashed
-- instance must not hold a job's lock forever — scheduler.ts's guarded()
-- wrapper means a job that throws still lets its lock expire naturally on
-- the next scheduled tick rather than needing its own unlock path.
create or replace function try_acquire_job_lock(p_job_name text, p_holder text, p_ttl_seconds integer)
returns boolean
language plpgsql
as $$
declare
  acquired boolean;
begin
  insert into job_locks (job_name, locked_by, locked_at, expires_at)
  values (p_job_name, p_holder, now(), now() + make_interval(secs => p_ttl_seconds))
  on conflict (job_name) do update
    set locked_by = excluded.locked_by,
        locked_at = excluded.locked_at,
        expires_at = excluded.expires_at
    where job_locks.expires_at < now()
  returning true into acquired;

  return coalesce(acquired, false);
end;
$$;
