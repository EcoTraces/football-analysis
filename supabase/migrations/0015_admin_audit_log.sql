-- Admin action audit log — closes the "no admin-action audit log" gap
-- named in Road_map.md/Task.md's security section. One row per mutating
-- (POST/PUT/PATCH/DELETE) request that reached an /api/admin/* route,
-- written by backend/src/middleware/auditAdminActions.ts, applied once via
-- router.use() the same way requireAdmin.ts already is (routes/admin.ts) —
-- a future admin route can't ship unaudited by omission any more than it
-- can ship unauthenticated.
--
-- actor_id/actor_email are a deliberate denormalized snapshot, not a
-- foreign key to user_profiles: an audit log's whole purpose is to survive
-- the actor being demoted or deleted later, so this must never reference
-- something an `on delete cascade` could take the audit trail down with.
create table if not exists admin_audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  actor_email text,
  method text not null,
  path text not null,
  status_code integer not null,
  request_body jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_admin_audit_log_actor_created on admin_audit_log (actor_id, created_at desc);
create index if not exists idx_admin_audit_log_created on admin_audit_log (created_at desc);
