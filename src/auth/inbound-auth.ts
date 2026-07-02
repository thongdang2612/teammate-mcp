import { timingSafeEqual } from "node:crypto";

const BEARER_PREFIX = "Bearer ";

/**
 * Gate for inbound MCP HTTP requests.
 *
 * When `expectedToken` is unset (local dev / no `MCP_INBOUND_TOKEN` configured), every request is
 * authorized. When it is set, the caller must present a matching `Authorization: Bearer <token>`
 * header. The comparison is constant-time to avoid leaking the token via response-time timing.
 */
export function isInboundAuthorized(authHeader: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true;
  if (!authHeader || !authHeader.startsWith(BEARER_PREFIX)) return false;
  const presented = authHeader.slice(BEARER_PREFIX.length);
  return timingSafeEqualStrings(presented, expectedToken);
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
