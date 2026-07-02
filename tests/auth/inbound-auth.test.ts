import { describe, it, expect } from "vitest";
import { isInboundAuthorized } from "../../src/auth/inbound-auth.js";

describe("isInboundAuthorized", () => {
  it("authorizes any request when no token is configured", () => {
    expect(isInboundAuthorized(undefined, undefined)).toBe(true);
    expect(isInboundAuthorized("garbage", undefined)).toBe(true);
    expect(isInboundAuthorized("Bearer wrong", "")).toBe(true);
  });

  it("authorizes a matching bearer header when a token is configured", () => {
    expect(isInboundAuthorized("Bearer secret-token", "secret-token")).toBe(true);
  });

  it("rejects a missing header when a token is configured", () => {
    expect(isInboundAuthorized(undefined, "secret-token")).toBe(false);
  });

  it("rejects a mismatched header when a token is configured", () => {
    expect(isInboundAuthorized("Bearer wrong-token", "secret-token")).toBe(false);
    expect(isInboundAuthorized("secret-token", "secret-token")).toBe(false);
  });

  it("authorizes using a constant-time comparison for a matching token", () => {
    expect(isInboundAuthorized("Bearer secret-token", "secret-token")).toBe(true);
  });

  it("rejects a wrong token of the same length as the expected token", () => {
    expect(isInboundAuthorized("Bearer secret-tokeX", "secret-token")).toBe(false);
  });
});
