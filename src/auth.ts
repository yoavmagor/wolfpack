/**
 * JWT auth stub — built-in HS256 implementation removed.
 * To enable auth, install `jose` or `jsonwebtoken` and implement validation here.
 */
import type { IncomingHttpHeaders } from "node:http";

export interface JwtValidationResult {
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: string;
}

if (process.env.WOLFPACK_JWT_SECRET) {
  console.warn(
    "⚠ WOLFPACK_JWT_SECRET is set but built-in JWT auth was removed. " +
      "Install `jose` or `jsonwebtoken` and implement auth in src/auth.ts to enable.",
  );
}

/** No-op — always allows requests. Implement real validation to enforce auth. */
export function validateRequestJwt(
  _headers: IncomingHttpHeaders,
  _url: URL,
  _allowQueryToken: boolean,
): JwtValidationResult {
  return { ok: true };
}
