-- user_profiles.role is a genuine privilege boundary (requireAdmin.ts
-- trusts it completely), but the 0001 policies only restricted which ROW a
-- signed-in user could touch (auth.uid() = id) — not which COLUMNS. As
-- written, "Users update own profile" let any authenticated user PATCH
-- their own row's `role` to 'admin' via a direct Supabase client call, and
-- "Users insert own profile" let a freshly-signed-up user insert their own
-- profile row with role already set to 'admin'. Nothing in this repo
-- exploits this today (the frontend has had no direct Supabase client at
-- all until now), but it's a live landmine for the moment one is added —
-- which is exactly what this migration's sibling frontend change does.
--
-- Fixed two ways, for defense in depth:
--   1. The INSERT policy's WITH CHECK now pins role = 'user' — a
--      client-initiated insert can never create an admin row.
--   2. A BEFORE UPDATE trigger blocks any change to `role` unless the
--      request is running as the service role (auth.role() =
--      'service_role' — what the backend always uses, and what a signed-in
--      end user's session, via the anon key, never is). RLS's `using`/
--      `with check` clauses don't apply to the service role at all (it
--      bypasses RLS outright), so this couldn't be expressed as a normal
--      policy; a trigger is the only way to keep `role` a backend-only
--      column while everything else on the row stays user-editable. This
--      is also why the admin role-management endpoints (backend
--      /admin/users/:id/role) and the initial-admin bootstrap in README.md
--      keep working unaffected — they always go through the service role.

drop policy if exists "Users insert own profile" on user_profiles;
create policy "Users insert own profile" on user_profiles
  for insert with check (auth.uid() = id and role = 'user');

create or replace function prevent_user_profiles_role_escalation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role and auth.role() <> 'service_role' then
    raise exception 'role can only be changed by the backend service role';
  end if;
  return new;
end;
$$;

drop trigger if exists enforce_user_profiles_role_immutable on user_profiles;
create trigger enforce_user_profiles_role_immutable
  before update on user_profiles
  for each row execute function prevent_user_profiles_role_escalation();
