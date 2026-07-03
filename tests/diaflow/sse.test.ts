import { describe, it, expect } from "vitest";
import { readSse } from "../../src/diaflow/sse.js";

const streamOf = (chunks: string[]): Response => {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      c.close();
    },
  });
  return new Response(body, { status: 200 });
};

const collect = async (res: Response, signal?: AbortSignal) => {
  const out = [];
  for await (const f of readSse(res, signal)) out.push(f);
  return out;
};

describe("readSse", () => {
  it("parses a single event+data frame with JSON data", async () => {
    const out = await collect(streamOf(['event: metadata\ndata: {"thread_id":"T9"}\n\n']));
    expect(out).toEqual([{ event: "metadata", data: { thread_id: "T9" } }]);
  });

  it("parses multiple frames split across chunk boundaries", async () => {
    const out = await collect(streamOf(['event: metadata\ndata: {"thread_id":"T9"}\n\nev', 'ent: final\ndata: {"content":"hi"}\n\n']));
    expect(out).toEqual([
      { event: "metadata", data: { thread_id: "T9" } },
      { event: "final", data: { content: "hi" } },
    ]);
  });

  it("joins multi-line data and ignores comments", async () => {
    const out = await collect(streamOf([': keep-alive\nevent: note\ndata: line1\ndata: line2\n\n']));
    expect(out).toEqual([{ event: "note", data: "line1\nline2" }]);
  });

  it("flushes a trailing frame with no terminating blank line", async () => {
    const out = await collect(streamOf(['event: final\ndata: {"content":"end"}']));
    expect(out).toEqual([{ event: "final", data: { content: "end" } }]);
  });

  it("stops when the signal aborts on an open stream", async () => {
    const enc = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode('event: metadata\ndata: {"thread_id":"T9"}\n\n'));
        // never closed → simulates an in-progress run
      },
    });
    const res = new Response(body, { status: 200 });
    const ctrl = new AbortController();
    const out = [];
    for await (const f of readSse(res, ctrl.signal)) {
      out.push(f);
      ctrl.abort(); // abort right after the first frame
    }
    expect(out).toEqual([{ event: "metadata", data: { thread_id: "T9" } }]);
  });
});
