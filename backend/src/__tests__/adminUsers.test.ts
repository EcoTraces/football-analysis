import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { listUsersWithRoles, updateUserRole } from "../routes/admin.js";
import { FakeSupabase } from "./testSupabaseFake.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

describe("listUsersWithRoles", () => {
  it("joins real auth.users accounts with their user_profiles role/display_name", async () => {
    const fake = new FakeSupabase();
    fake.seedAuthUsers([
      { id: "user-1", email: "alice@example.com" },
      { id: "user-2", email: "bob@example.com" }
    ]);
    fake.seed("user_profiles", [{ id: "user-1", role: "admin", display_name: "Alice" }]);

    const users = await listUsersWithRoles(fakeClient(fake));

    expect(users).toHaveLength(2);
    expect(users.find((u) => u.id === "user-1")).toMatchObject({ email: "alice@example.com", role: "admin", displayName: "Alice" });
    // user-2 has no user_profiles row yet — defaults to 'user', not a crash or an omission.
    expect(users.find((u) => u.id === "user-2")).toMatchObject({ email: "bob@example.com", role: "user", displayName: null });
  });

  it("returns an empty list when there are no accounts", async () => {
    const fake = new FakeSupabase();
    expect(await listUsersWithRoles(fakeClient(fake))).toEqual([]);
  });

  it("pages through every account rather than truncating at the first page's 200", async () => {
    const fake = new FakeSupabase();
    const seeded = Array.from({ length: 250 }, (_, i) => ({ id: `user-${i}`, email: `user${i}@example.com` }));
    fake.seedAuthUsers(seeded);

    const users = await listUsersWithRoles(fakeClient(fake));

    expect(users).toHaveLength(250);
    expect(users.find((u) => u.id === "user-249")).toBeDefined(); // on the second page
  });
});

describe("updateUserRole", () => {
  it("promotes a user to admin", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [{ id: "user-1", role: "user" }]);

    const result = await updateUserRole(fakeClient(fake), "user-1", "admin");

    expect(result).toEqual({ id: "user-1", role: "admin" });
    expect(fake.rows("user_profiles").find((r) => r.id === "user-1")?.role).toBe("admin");
  });

  it("demotes an admin when at least one other admin remains", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [
      { id: "admin-1", role: "admin" },
      { id: "admin-2", role: "admin" }
    ]);

    const result = await updateUserRole(fakeClient(fake), "admin-1", "user");

    expect(result).toEqual({ id: "admin-1", role: "user" });
  });

  it("refuses to demote the only remaining admin", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [{ id: "admin-1", role: "admin" }]);

    await expect(updateUserRole(fakeClient(fake), "admin-1", "user")).rejects.toMatchObject({
      statusCode: 409,
      code: "last_admin"
    });
    // The row must be unchanged after the refusal.
    expect(fake.rows("user_profiles").find((r) => r.id === "admin-1")?.role).toBe("admin");
  });

  it("404s when the target user has no user_profiles row", async () => {
    const fake = new FakeSupabase();

    await expect(updateUserRole(fakeClient(fake), "ghost", "admin")).rejects.toMatchObject({
      statusCode: 404,
      code: "user_not_found"
    });
  });

  it("allows promoting a second admin without hitting the last-admin guard", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [
      { id: "admin-1", role: "admin" },
      { id: "user-1", role: "user" }
    ]);

    await expect(updateUserRole(fakeClient(fake), "user-1", "admin")).resolves.toEqual({ id: "user-1", role: "admin" });
  });

  it("is a no-op-safe re-assertion of the same role (admin -> admin does not trigger the last-admin check)", async () => {
    const fake = new FakeSupabase();
    fake.seed("user_profiles", [{ id: "admin-1", role: "admin" }]);

    await expect(updateUserRole(fakeClient(fake), "admin-1", "admin")).resolves.toEqual({ id: "admin-1", role: "admin" });
  });
});
