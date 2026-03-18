import { describe, test, expect } from "bun:test";
import { generateCspNonce } from "../../src/server/http.js";

describe("CSP nonce", () => {
  test("generateCspNonce returns a base64 string", () => {
    const nonce = generateCspNonce();
    expect(typeof nonce).toBe("string");
    expect(nonce.length).toBeGreaterThan(0);
    // 16 bytes → 24 chars base64
    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  test("each nonce is unique", () => {
    const nonces = new Set(Array.from({ length: 100 }, () => generateCspNonce()));
    expect(nonces.size).toBe(100);
  });
});
