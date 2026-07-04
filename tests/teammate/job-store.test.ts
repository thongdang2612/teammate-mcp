import { describe, it, expect } from "vitest";
import { JobStore, MAX_ACTIVE_JOBS } from "../../src/teammate/job-store.js";

describe("JobStore", () => {
  it("creates a working job with a unique id and tracks it", () => {
    const s = new JobStore();
    const a = s.create("message");
    const b = s.create("relay");
    expect(a.status).toBe("working");
    expect(a.kind).toBe("message");
    expect(a.id).not.toBe(b.id);
    expect(s.get(a.id)).toEqual(a);
  });

  it("updates a job and bumps updatedAt", () => {
    let t = 100;
    const s = new JobStore(() => t);
    const job = s.create("message");
    t = 500;
    s.update(job.id, { status: "completed", reply: "done" });
    const after = s.get(job.id)!;
    expect(after.status).toBe("completed");
    expect(after.reply).toBe("done");
    expect(after.updatedAt).toBe(500);
    expect(after.createdAt).toBe(100);
  });

  it("counts only working jobs toward capacity", () => {
    const s = new JobStore();
    const a = s.create("message");
    s.create("message");
    expect(s.activeCount()).toBe(2);
    s.update(a.id, { status: "completed" });
    expect(s.activeCount()).toBe(1);
  });

  it("reports capacity once MAX_ACTIVE_JOBS working jobs exist", () => {
    const s = new JobStore();
    for (let i = 0; i < MAX_ACTIVE_JOBS - 1; i += 1) s.create("message");
    expect(s.atCapacity()).toBe(false);
    s.create("message");
    expect(s.atCapacity()).toBe(true);
  });

  it("sweeps terminal jobs past TTL and hung working jobs past max age, keeping recent ones", () => {
    let t = 0;
    const s = new JobStore(() => t);
    const doneOld = s.create("message");
    s.update(doneOld.id, { status: "completed" }); // updatedAt = 0
    const workingOld = s.create("message"); // createdAt = 0
    t = 31 * 60 * 1000; // past the 30-min TTL and 20-min max age
    const recent = s.create("message"); // createdAt = now → age 0
    s.sweep();
    expect(s.get(doneOld.id)).toBeUndefined(); // terminal + past TTL → dropped
    expect(s.get(workingOld.id)).toBeUndefined(); // working + past max age → dropped
    expect(s.get(recent.id)).toBeDefined(); // still within max age → kept
  });
});
