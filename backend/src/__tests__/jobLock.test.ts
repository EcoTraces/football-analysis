import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "pino";
import { FakeSupabase } from "./testSupabaseFake.js";
import { acquireJobLock } from "../lib/jobLock.js";

function fakeClient(fake: FakeSupabase): SupabaseClient {
  return fake as unknown as SupabaseClient;
}

function fakeLogger(): Logger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
}

describe("acquireJobLock", () => {
  it("acquires a lock for a job that has never been locked before", async () => {
    const fake = new FakeSupabase();
    const acquired = await acquireJobLock(fakeClient(fake), "sync_fixtures", fakeLogger());
    expect(acquired).toBe(true);
    expect(fake.rows("job_locks")).toHaveLength(1);
  });

  it("refuses a second acquire while the first lock is still live", async () => {
    const fake = new FakeSupabase();
    const logger = fakeLogger();
    const first = await acquireJobLock(fakeClient(fake), "sync_fixtures", logger, 3600);
    const second = await acquireJobLock(fakeClient(fake), "sync_fixtures", logger, 3600);
    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("lets a new acquire steal an expired lock", async () => {
    const fake = new FakeSupabase();
    // A negative TTL sets expires_at safely in the past — simulates a lock
    // left behind by a previous run once its time is up, without needing to
    // fake the clock or risk a same-millisecond race against a 0-second TTL.
    const first = await acquireJobLock(fakeClient(fake), "sync_fixtures", fakeLogger(), -60);
    const second = await acquireJobLock(fakeClient(fake), "sync_fixtures", fakeLogger(), 3600);
    expect(first).toBe(true);
    expect(second).toBe(true);
  });

  it("locks are independent per job name", async () => {
    const fake = new FakeSupabase();
    const logger = fakeLogger();
    await acquireJobLock(fakeClient(fake), "sync_fixtures", logger, 3600);
    const otherJob = await acquireJobLock(fakeClient(fake), "sync_odds", logger, 3600);
    expect(otherJob).toBe(true);
  });

  it("returns false (never throws) when the RPC call itself errors", async () => {
    const fake = new FakeSupabase();
    vi.spyOn(fake, "rpc").mockResolvedValue({ data: null, error: { message: "connection reset" } });
    const logger = fakeLogger();

    const acquired = await acquireJobLock(fakeClient(fake), "sync_fixtures", logger);

    expect(acquired).toBe(false);
    expect(logger.error).toHaveBeenCalled();
  });
});
