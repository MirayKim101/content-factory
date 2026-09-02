import { z } from "zod";

export const MAX_SELECTED_PROJECTS = 20;
const projectIdSchema = z.uuid();

export function normalizeProjectIds(value: unknown): {
  ids: string[];
  removed: boolean;
} {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string" || !raw)
    return { ids: [], removed: Boolean(raw) };
  const seen = new Set<string>();
  let removed = false;
  for (const candidate of raw.split(",")) {
    const parsed = projectIdSchema.safeParse(candidate);
    if (
      !parsed.success ||
      seen.has(candidate) ||
      seen.size >= MAX_SELECTED_PROJECTS
    ) {
      removed = true;
      continue;
    }
    seen.add(candidate);
  }
  return { ids: [...seen], removed };
}

export function toggleProjectSelection(
  ids: string[],
  projectId: string,
): string[] {
  return ids.includes(projectId)
    ? ids.filter((id) => id !== projectId)
    : ids.length < MAX_SELECTED_PROJECTS
      ? [...ids, projectId]
      : ids;
}

export function mergeProjectSelections(...groups: string[][]): string[] {
  const result: string[] = [];
  for (const id of groups.flat()) {
    if (!result.includes(id) && result.length < MAX_SELECTED_PROJECTS)
      result.push(id);
  }
  return result;
}

export function projectIdsFromReturnTo(value: unknown): string[] {
  if (typeof value !== "string" || !value.startsWith("/horizontal")) return [];
  try {
    const url = new URL(value, "http://content-factory.local");
    if (url.pathname !== "/horizontal") return [];
    return normalizeProjectIds(url.searchParams.get("projectIds")).ids;
  } catch {
    return [];
  }
}
