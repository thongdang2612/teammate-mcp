import { describe, it, expect } from "vitest";
import { InMemoryClientStore } from "../../../src/auth/oauth/client-store.js";

describe("InMemoryClientStore", () => {
  it("registers a client with a generated id and reads it back", () => {
    const store = new InMemoryClientStore();
    const reg = store.registerClient({ redirect_uris: ["https://cb"] });
    expect(reg.client_id).toBeTruthy();
    expect(reg.client_id_issued_at).toBeGreaterThan(0);
    expect(store.getClient(reg.client_id)?.redirect_uris).toEqual(["https://cb"]);
  });

  it("returns undefined for an unknown client", () => {
    expect(new InMemoryClientStore().getClient("nope")).toBeUndefined();
  });
});
