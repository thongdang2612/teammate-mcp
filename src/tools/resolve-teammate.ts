import type { TeammatesApi } from "../diaflow/teammates.js";

export type ResolveResult =
  | { ok: true; id: string }
  | { ok: false; error: string; candidates?: string[] };

/**
 * Resolve a teammate to its uniqueId from EITHER an explicit id OR a name.
 * When only a name is given, it is looked up (case-insensitive exact match) via
 * a search list. Shared by tools that accept teammateId-or-teammateName.
 */
export async function resolveTeammateId(
  teammates: Pick<TeammatesApi, "list">,
  args: { teammateId?: string; teammateName?: string },
): Promise<ResolveResult> {
  if (args.teammateId) return { ok: true, id: args.teammateId };
  if (!args.teammateName) return { ok: false, error: "Provide teammateId or teammateName to identify the teammate." };
  const page = await teammates.list({ search: args.teammateName });
  const wanted = args.teammateName.trim().toLowerCase();
  const match = page.results.find((a) => (a.name ?? "").trim().toLowerCase() === wanted);
  if (!match) {
    return { ok: false, error: `No teammate named "${args.teammateName}" found.`, candidates: page.results.map((a) => a.name).filter((n): n is string => Boolean(n)) };
  }
  return { ok: true, id: match.uniqueId };
}
