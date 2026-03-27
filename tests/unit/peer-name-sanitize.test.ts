import { describe, test, expect } from "bun:test";
import { sanitizePeerName } from "../../src/server/http.js";

describe("sanitizePeerName", () => {
  test("passes through a normal name", () => {
    expect(sanitizePeerName("alice-laptop")).toBe("alice-laptop");
  });

  test("strips control characters", () => {
    expect(sanitizePeerName("bad\x00name\x1f")).toBe("badname");
    expect(sanitizePeerName("\x07bell\x08back")).toBe("bellback");
  });

  test("strips C1 control characters (U+007F–U+009F)", () => {
    expect(sanitizePeerName("test\x7fDEL\x80\x9f")).toBe("testDEL");
  });

  test("strips script tags' control chars but preserves visible HTML", () => {
    // The function strips control chars, not HTML — HTML escaping is the client's job (esc())
    const malicious = '<script>alert("xss")</script>';
    expect(sanitizePeerName(malicious)).toBe(malicious);
  });

  test("truncates to 64 characters", () => {
    const long = "a".repeat(200);
    expect(sanitizePeerName(long)).toBe("a".repeat(64));
  });

  test("truncates after stripping control chars", () => {
    const input = "\x00" + "b".repeat(100);
    expect(sanitizePeerName(input)).toBe("b".repeat(64));
  });

  test("returns empty string for non-string input", () => {
    expect(sanitizePeerName(undefined)).toBe("");
    expect(sanitizePeerName(null)).toBe("");
    expect(sanitizePeerName(42)).toBe("");
    expect(sanitizePeerName({})).toBe("");
  });

  test("returns empty string for empty string", () => {
    expect(sanitizePeerName("")).toBe("");
  });

  test("returns empty string when input is only control chars", () => {
    expect(sanitizePeerName("\x00\x01\x02\x1f")).toBe("");
  });

  test("preserves unicode display characters", () => {
    expect(sanitizePeerName("café-laptop")).toBe("café-laptop");
    expect(sanitizePeerName("日本語ホスト")).toBe("日本語ホスト");
  });
});
