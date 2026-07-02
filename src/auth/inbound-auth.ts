/**
 * Gate for inbound MCP HTTP requests.
 *
 * When `expectedToken` is unset (local dev / no `MCP_INBOUND_TOKEN` configured), every request is
 * authorized. When it is set, the caller must present a matching `Authorization: Bearer <token>` header.
 */
export function isInboundAuthorized(authHeader: string | undefined, expectedToken: string | undefined): boolean {
  if (!expectedToken) return true;
  return authHeader === `Bearer ${expectedToken}`;
}
