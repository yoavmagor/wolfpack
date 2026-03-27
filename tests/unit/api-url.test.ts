import { describe, test, expect } from "bun:test";

/**
 * Tests the URL construction logic used in public/app.ts api() function:
 *   machineUrl ? new URL("/api" + path, machineUrl).href : "/api" + path
 */
function buildApiUrl(path: string, machineUrl?: string): string {
  if (machineUrl) {
    return new URL("/api" + path, machineUrl).href;
  }
  return "/api" + path;
}

describe("api URL construction", () => {
  test("no machineUrl — relative path", () => {
    expect(buildApiUrl("/sessions")).toBe("/api/sessions");
    expect(buildApiUrl("/info")).toBe("/api/info");
  });

  test("machineUrl without trailing slash", () => {
    expect(buildApiUrl("/sessions", "http://10.0.0.5:3000")).toBe(
      "http://10.0.0.5:3000/api/sessions",
    );
  });

  test("machineUrl WITH trailing slash — no double slash", () => {
    expect(buildApiUrl("/sessions", "http://10.0.0.5:3000/")).toBe(
      "http://10.0.0.5:3000/api/sessions",
    );
  });

  test("machineUrl with path component", () => {
    // new URL with absolute path replaces the base path, which is correct
    expect(buildApiUrl("/sessions", "http://10.0.0.5:3000/some/prefix")).toBe(
      "http://10.0.0.5:3000/api/sessions",
    );
  });

  test("machineUrl with fragment — fragment is stripped", () => {
    const url = buildApiUrl("/sessions", "http://10.0.0.5:3000#frag");
    expect(url).toBe("http://10.0.0.5:3000/api/sessions");
    expect(url).not.toContain("#");
  });

  test("path with query string is preserved", () => {
    expect(
      buildApiUrl("/git-status?session=foo", "http://10.0.0.5:3000"),
    ).toBe("http://10.0.0.5:3000/api/git-status?session=foo");
  });

  test("path with encoded query params", () => {
    const path = "/next-session-name?project=" + encodeURIComponent("my project");
    expect(buildApiUrl(path, "http://10.0.0.5:3000")).toBe(
      "http://10.0.0.5:3000/api/next-session-name?project=my%20project",
    );
  });

  test("machineUrl with port only", () => {
    expect(buildApiUrl("/info", "http://localhost:4567")).toBe(
      "http://localhost:4567/api/info",
    );
  });
});
