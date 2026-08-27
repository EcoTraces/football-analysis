import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { getOrCreateProfile } from "../routes/me.js";
import { FakeSupabase } from "./testSupabaseFake.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("getOrCreateProfile", () => {
  it("creates a user_profiles row on first call, writing only `id` — never a `role`", async () => {
    const fake = new FakeSupabase();

    const profile = await getOrCreateProfile(fakeClient(fake), "user-1");

    expect(profile.id).toBe("user-1");
    expect(fake.rows("user_profiles")).toHaveLength(1);
    // The upsert payload must never include `role` — a real Postgres column
    // default ('user') applies it on insert, but more importantly, this is
    // what guarantees the upsert can never clobber an existing user's role
    // back to 'user' on a later call (see the next test). The hand-rolled
    // fake doesn't simulate column defaults, so `role` is simply absent
    // here rather than "user" — that's expected, not a gap in this test.
    expect(fake.rows("user_profiles")[0]).toEqual({ id: "user-1" });
  });

  it("returns the existing row unchanged on a second call, including a non-default role", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [{ id: "admin-1", role: "admin", display_name: "The Admin", created_at: "2026-01-01T00:00:00Z" }]);

    const profile = await getOrCreateProfile(fakeClient(fake), "admin-1");

    expect(profile.role).toBe("admin");
    expect(profile.display_name).toBe("The Admin");
    expect(fake.rows("user_profiles")).toHaveLength(1); // no duplicate row created
  });
});
