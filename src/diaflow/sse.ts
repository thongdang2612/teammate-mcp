export interface SseFrame {
  event: string;
  data: unknown;
}

/**
 * Parse an SSE `Response` body into frames. Frames are separated by a blank line; within a frame
 * `event:` sets the type (default "message") and `data:` lines are concatenated with "\n" then
 * JSON-parsed when possible. Comment lines (starting ":") are ignored. Iteration ends when the
 * stream closes or `signal` aborts (the underlying reader is cancelled).
 */
export async function* readSse(res: Response, signal?: AbortSignal): AsyncGenerator<SseFrame> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = (): void => void reader.cancel().catch(() => {});
  signal?.addEventListener("abort", onAbort);
  if (signal?.aborted) onAbort();

  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split(/\r?\n\r?\n/);
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        const frame = parseFrame(part);
        if (frame) yield frame;
      }
    }
    buffer += decoder.decode(); // flush any trailing multibyte UTF-8 sequence held by the decoder
    const tail = parseFrame(buffer);
    if (tail) yield tail;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    await reader.cancel().catch(() => {});
  }
}

function parseFrame(block: string): SseFrame | null {
  let event = "message";
  const dataLines: string[] = [];
  for (const line of block.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
  }
  if (!dataLines.length) return null;
  const dataStr = dataLines.join("\n");
  let data: unknown = dataStr;
  try {
    data = JSON.parse(dataStr);
  } catch {
    /* keep the raw string */
  }
  return { event, data };
}
