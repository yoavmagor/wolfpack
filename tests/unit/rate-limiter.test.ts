import { describe, expect, test } from "bun:test";
import { createRateLimiter, createPerIpRateLimiter } from "../../src/server/http.ts";

describe("createRateLimiter", () => {
  test("allows up to `rate` requests then denies", () => {
    const rl = createRateLimiter(5);
    for (let i = 0; i < 5; i++) {
      expect(rl.allow()).toBe(true);
    }
    expect(rl.allow()).toBe(false);
  });

  test("refills tokens over time", async () => {
    const rl = createRateLimiter(10);
    // Drain all tokens
    for (let i = 0; i < 10; i++) rl.allow();
    expect(rl.allow()).toBe(false);

    // Wait ~200ms → should refill ~2 tokens (10/sec * 0.2s)
    await new Promise((r) => setTimeout(r, 220));
    expect(rl.allow()).toBe(true);
  });
});

describe("createPerIpRateLimiter", () => {
  test("tracks separate buckets per IP", () => {
    const rl = createPerIpRateLimiter(3);
    // Drain IP-A
    for (let i = 0; i < 3; i++) rl.allow("1.1.1.1");
    expect(rl.allow("1.1.1.1")).toBe(false);

    // IP-B should still be fresh
    expect(rl.allow("2.2.2.2")).toBe(true);
    clearInterval(rl._evictTimer);
  });

  test("burst 200 requests exceeds limit and gets denied", () => {
    const rl = createPerIpRateLimiter(10);
    let allowed = 0;
    let denied = 0;
    for (let i = 0; i < 200; i++) {
      if (rl.allow("10.0.0.1")) allowed++;
      else denied++;
    }
    expect(allowed).toBe(10);
    expect(denied).toBe(190);
    clearInterval(rl._evictTimer);
  });

  test("evicts stale entries", async () => {
    const rl = createPerIpRateLimiter(5, 100); // 100ms evict interval
    rl.allow("stale-ip");
    expect(rl._map.has("stale-ip")).toBe(true);
    await new Promise((r) => setTimeout(r, 250));
    expect(rl._map.has("stale-ip")).toBe(false);
    clearInterval(rl._evictTimer);
  });
});
