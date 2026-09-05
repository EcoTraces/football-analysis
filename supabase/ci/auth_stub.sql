-- CI-ONLY stub of the parts of Supabase's own `auth` schema this project's
-- migrations reference: `auth.users` (a foreign-key target for
-- user_profiles.id), and the `auth.uid()`/`auth.role()` functions used
-- inside RLS policy expressions (0001_init.sql, 0004_user_profiles_role_guard.sql).
--
-- A real Supabase project already provides genuine versions of all three —
-- this file exists ONLY so `supabase/migrations/*.sql` can be applied
-- against a bare Postgres container in CI (.github/workflows/ci.yml's
-- db-migrations job) to verify the migration set is valid, idempotent SQL
-- against real Postgres, the same class of check that would have caught
-- 0005-0013's missing "if not exists" clauses before they broke a real
-- deployment (see Changelog.md's "Make migrations 0005-0013 safely
-- re-runnable"). It intentionally does NOT reproduce RLS enforcement,
-- PostgREST's on_conflict-against-expression-index behavior, or real
-- auth.users/service-role semantics — those still need a real Supabase
-- project (see Road_map.md/Database.md's "Known gaps"). NEVER run this
-- against a real Supabase project: its own `auth` schema already exists
-- and must not be touched.
create schema if not exists auth;

-- No default expression (e.g. gen_random_uuid()) — this file runs before
-- 0001_init.sql creates the pgcrypto extension that function needs, and no
-- migration ever inserts a row into this stub table anyway (schema
-- validation only, never real data).
create table if not exists auth.users (
  id uuid primary key
);

-- Real values are irrelevant here: applying supabase/migrations/*.sql only
-- creates policies/triggers referencing these functions, it never actually
-- runs an INSERT/UPDATE that would evaluate them.
create or replace function auth.uid() returns uuid
language sql stable
as $$ select null::uuid $$;

create or replace function auth.role() returns text
language sql stable
as $$ select 'service_role'::text $$;
