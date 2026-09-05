import { describe, expect, it, vi } from "vitest";
import { TtlCache, cached } from "../lib/ttlCache.js";

describe("TtlCache", () => {
  it("returns undefined for a key that was never set", () => {
    const cache = new TtlCache<string>(1000);
    expect(cache.get("missing")).toBeUndefined();
  });

  it("returns a value that was set and hasn't expired", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("key", "value");
    expect(cache.get("key")).toBe("value");
  });

  it("expires a value once its TTL has passed", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>(1000);
      cache.set("key", "value");
      vi.advanceTimersByTime(1000);
      expect(cache.get("key")).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not expire a value that's just under its TTL", () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<string>(1000);
      cache.set("key", "value");
      vi.advanceTimersByTime(999);
      expect(cache.get("key")).toBe("value");
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear() drops every entry", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });

  it("keeps different keys independent", () => {
    const cache = new TtlCache<string>(1000);
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.get("a")).toBe("1");
    expect(cache.get("b")).toBe("2");
  });
});

describe("cached()", () => {
  it("calls the factory on a miss and returns its result", async () => {
    const cache = new TtlCache<number>(1000);
    const factory = vi.fn().mockResolvedValue(42);

    const result = await cached(cache, "key", factory);

    expect(result).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("does not call the factory again on a hit", async () => {
    const cache = new TtlCache<number>(1000);
    const factory = vi.fn().mockResolvedValue(42);

    await cached(cache, "key", factory);
    const second = await cached(cache, "key", factory);

    expect(second).toBe(42);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("calls the factory again once the cached value has expired", async () => {
    vi.useFakeTimers();
    try {
      const cache = new TtlCache<number>(1000);
      const factory = vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2);

      const first = await cached(cache, "key", factory);
      vi.advanceTimersByTime(1000);
      const second = await cached(cache, "key", factory);

      expect(first).toBe(1);
      expect(second).toBe(2);
      expect(factory).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats different cache keys as independent entries in the same cache", async () => {
    const cache = new TtlCache<number>(1000);
    const factoryA = vi.fn().mockResolvedValue(1);
    const factoryB = vi.fn().mockResolvedValue(2);

    const a = await cached(cache, "a", factoryA);
    const b = await cached(cache, "b", factoryB);

    expect(a).toBe(1);
    expect(b).toBe(2);
  });
});
