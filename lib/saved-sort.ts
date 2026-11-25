import type { Sort } from "@/components/ui";

/**
 * A table's sort is saved as "column-direction" ("name-asc"), under the same
 * localStorage key the old sort dropdowns used. `legacy` maps the values those
 * dropdowns saved that do not fit the pattern ("agent-live", "A-Z").
 */
export function readSavedSort(saved: string, fallback: Sort, legacy: Record<string, Sort> = {}): Sort {
  if (legacy[saved]) return legacy[saved];
  const at = saved.lastIndexOf("-");
  const dir = saved.slice(at + 1);
  return at > 0 && (dir === "asc" || dir === "desc") ? { id: saved.slice(0, at), dir } : fallback;
}

export const writeSavedSort = (sort: Sort) => `${sort.id}-${sort.dir}`;
