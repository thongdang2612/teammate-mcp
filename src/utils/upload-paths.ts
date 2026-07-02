export function buildModulePath(folder: string, date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `${folder}/${dd}-${mm}-${yy}`;
}

export function buildAgentUploadPath(threadId: string | undefined, date: Date): string {
  const dd = String(date.getUTCDate()).padStart(2, "0");
  const mm = String(date.getUTCMonth() + 1).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  return `agent-workspace/${threadId ?? "new"}/uploads/${dd}-${mm}-${yy}`;
}
