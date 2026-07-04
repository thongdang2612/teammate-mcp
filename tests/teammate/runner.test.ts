import { describe, it, expect, vi } from "vitest";
import { runToCompletion, runRelay, startJob } from "../../src/teammate/runner.js";
import { JobStore } from "../../src/teammate/job-store.js";
import type { RunnerConversations } from "../../src/teammate/runner.js";

const conv = (over: Partial<RunnerConversations>): RunnerConversations => ({
  sendMessage: vi.fn(async () => ({ status: "completed" as const, threadId: "T", reply: "x" })),
  waitForReply: vi.fn(async () => ({ status: "completed" as const, threadId: "T", reply: "x" })),
  ...over,
});

describe("runToCompletion", () => {
  it("returns immediately when sendMessage already completed", async () => {
    const waitForReply = vi.fn();
    const c = conv({ sendMessage: vi.fn(async () => ({ status: "completed" as const, threadId: "T1", reply: "done" })), waitForReply });
    const r = await runToCompletion(c, { teammateId: "u1", message: "hi" });
    expect(r).toEqual({ status: "completed" as const, threadId: "T1", reply: "done" });
    expect(waitForReply).not.toHaveBeenCalled();
  });

  it("polls waitForReply until it completes", async () => {
    const waitForReply = vi
      .fn()
      .mockResolvedValueOnce({ status: "working" as const, threadId: "T1" })
      .mockResolvedValueOnce({ status: "completed" as const, threadId: "T1", reply: "final" });
    const c = conv({ sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "T1" })), waitForReply });
    const r = await runToCompletion(c, { teammateId: "u1", message: "long" });
    expect(r).toEqual({ status: "completed" as const, threadId: "T1", reply: "final" });
    expect(waitForReply).toHaveBeenCalledTimes(2);
  });

  it("gives up with status working when the deadline passes", async () => {
    const times = [0, 50, 150]; // deadline calc = 0+100; loop check 50<100 (poll), 150<100 stop
    const now = () => times.shift() ?? 999;
    const waitForReply = vi.fn(async () => ({ status: "working" as const, threadId: "T1" }));
    const c = conv({ sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "T1" })), waitForReply });
    const r = await runToCompletion(c, { teammateId: "u1", message: "x" }, { maxMs: 100, now });
    expect(r).toEqual({ status: "working" as const, threadId: "T1" });
    expect(waitForReply).toHaveBeenCalledTimes(1);
  });

  it("returns working with empty threadId if the run never yielded one", async () => {
    const c = conv({ sendMessage: vi.fn(async () => ({ status: "working" as const, threadId: "" })) });
    const r = await runToCompletion(c, { message: "x" });
    expect(r).toEqual({ status: "working" as const, threadId: "" });
  });
});

describe("runRelay", () => {
  it("feeds each hop's reply into the next and returns the final", async () => {
    const sent: string[] = [];
    const sendMessage = vi.fn(async (p: { message: string }) => {
      sent.push(p.message);
      return { status: "completed" as const, threadId: "T", reply: `reply-to:${p.message}` };
    });
    const c = conv({ sendMessage });
    const r = await runRelay(c, [{ teammateId: "A" }, { teammateId: "B", instruction: "analyze" }], "start");
    expect(sent[0]).toBe("start");
    expect(sent[1]).toBe("analyze\n\nreply-to:start"); // hop B gets its instruction + hop A's reply
    expect(r).toEqual({ status: "completed" as const, threadId: "", reply: "reply-to:analyze\n\nreply-to:start" });
  });

  it("stops and reports the step that fails", async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce({ status: "completed" as const, threadId: "T", reply: "ok" })
      .mockResolvedValueOnce({ status: "failed" as const, threadId: "T", error: "boom" });
    const c = conv({ sendMessage });
    const r = await runRelay(c, [{ teammateId: "A" }, { teammateId: "B" }], "go");
    expect(r.status).toBe("failed");
    expect(r.atStep).toBe(2);
    expect(r.error).toContain("boom");
  });
});

describe("startJob", () => {
  it("records a completed result into the store", async () => {
    const store = new JobStore();
    const { jobId, settled } = startJob(store, "message", async () => ({ status: "completed" as const, threadId: "T", reply: "yo" }));
    expect(store.get(jobId)!.status).toBe("working");
    await settled;
    expect(store.get(jobId)).toMatchObject({ status: "completed" as const, reply: "yo" });
  });

  it("records a thrown error as a failed job (never rejects)", async () => {
    const store = new JobStore();
    const { jobId, settled } = startJob(store, "message", async () => {
      throw new Error("kaboom");
    });
    await expect(settled).resolves.toBeDefined();
    expect(store.get(jobId)).toMatchObject({ status: "failed" as const, error: "kaboom" });
  });
});
