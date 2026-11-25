"use client";

import * as React from "react";
import { usePathname } from "next/navigation";
import { ArrowDown, ArrowUp, ChevronDown, ChevronsUpDown } from "lucide-react";
import { cn, tied } from "@/lib/utils";
import { Pager } from "./pager";
import { Select } from "./select";

export type SortDir = "asc" | "desc";
export type Sort = { id: string; dir: SortDir };

export type Column<T> = {
  id: string;
  /** The heading, in plain words. On phones it labels the value when a row is opened. */
  header: string;
  /** `where` says which layout is asking, for the rare cell that reads differently in a phone row. */
  cell: (row: T, where: "table" | "phone") => React.ReactNode;
  /** Gives the heading a sort. Return the value to order by; nothing sorts last either way. */
  sortValue?: (row: T) => string | number | null | undefined;
  /** Numbers go right, in mono, so their digits line up down the column. */
  numeric?: boolean;
  /** Sits at the right without the number styling: a status in the last column. */
  end?: boolean;
  /** What the two sort directions are called on a phone, when "A to Z" would read oddly: ["oldest first", "newest first"]. */
  sortWords?: [asc: string, desc: string];
  /** Extra classes for the cell and its heading (a width, usually). */
  className?: string;
  /**
   * The column that gives way: it takes the room the others leave and clips
   * with an ellipsis when there is not enough, so the table never runs wider
   * than its column. One per table, usually the name. Its cell must truncate.
   */
  grow?: boolean;
  /**
   * Its place on a phone. "title" and "subtitle" make the two-line summary,
   * "trailing" sits at its right (a status), "field" shows when the row is
   * opened (the default), "hidden" never shows.
   */
  phone?: "title" | "subtitle" | "trailing" | "field" | "hidden";
  /** How wide its placeholder is while loading: a width class. */
  skeleton?: string;
};

type Selection<T> = {
  selected: ReadonlySet<string>;
  onToggle: (key: string, row: T) => void;
  /** Called with the keys on the page being shown. */
  onToggleAll: (keys: string[], select: boolean) => void;
  /** Names the row for its checkbox: "example.com". */
  label: (row: T) => string;
};

type DataTableProps<T> = {
  /** What the table lists, plural and lower case: "servers". Names the table and the pager. */
  noun: string;
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  /** True until the first rows arrive. The headings stay and rows shaped like the table pulse. */
  loading?: boolean;
  /** How many placeholder rows to hold while loading. */
  skeletonRows?: number;
  /** Shown where the rows would be when there are none. */
  empty: { title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode };
  defaultSort?: Sort;
  /** Controlled sort. Leave both out to let the table keep it. */
  sort?: Sort | null;
  onSortChange?: (sort: Sort) => void;
  /** Rows per page. Leave out to show every row with no pager. */
  pageSize?: number;
  /** Buttons at the end of a row; on a phone they sit in the opened row. */
  rowActions?: (row: T, where: "table" | "phone") => React.ReactNode;
  /** Shown first when a phone row is opened, above its fields (a row's meters, say). */
  phoneDetail?: (row: T) => React.ReactNode;
  selection?: Selection<T>;
  /** Marks rows that need the eye: a tint and nothing else. */
  rowTone?: (row: T) => "warn" | "danger" | undefined;
  /** True for a row that starts a new group: a small gap is left above it. */
  breakBefore?: (row: T, prev: T | undefined) => boolean;
  /** Change it to send the table back to its first page: pass the filters as one string. */
  resetKey?: string;
  /** Told which rows are on screen, in order, whenever that changes (a quick view steps through them). */
  onView?: (view: TableView) => void;
  className?: string;
};

export type TableView = { keys: string[]; start: number; total: number };

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function compare(a: unknown, b: unknown, dir: SortDir) {
  const an = a == null || a === "";
  const bn = b == null || b === "";
  if (an || bn) return an === bn ? 0 : an ? 1 : -1; // nothing sorts last, whichever way
  const r = typeof a === "number" && typeof b === "number" ? a - b : collator.compare(String(a), String(b));
  return dir === "asc" ? r : -r;
}

// How many rows a table held the last time it was on screen in this browser tab. Its loading shape takes that
// size, so coming back to a page does not move what sits under the table. Nothing is known on the server or on
// a first visit: `skeletonRows` stands in.
const never = () => () => {};
function useRememberedRows(key: string): number | null {
  return React.useSyncExternalStore(
    never,
    () => {
      try {
        const raw = sessionStorage.getItem(key);
        const n = raw === null ? NaN : Number(raw);
        return Number.isInteger(n) && n >= 0 ? n : null;
      } catch {
        return null;
      }
    },
    () => null
  );
}

// A share of the table to aim for, and no floor: the cell's own text no longer sets a minimum, so it can give way.
const GROW = "w-[36%] max-w-0";

const tone = (t: "warn" | "danger" | undefined) => (t === "danger" ? "bg-danger/8" : t === "warn" ? "bg-warning/8" : undefined);

/**
 * DataTable — the one table. Click a heading to sort. Every table shares one
 * row height and one number alignment. Below `md` the same rows become
 * two-line summaries that open in place to show the rest, so there is no
 * second list to keep in step. While loading, and when empty, the headings
 * stay and the body keeps its shape.
 */
export function DataTable<T>({
  noun,
  columns,
  rows,
  rowKey,
  loading = false,
  skeletonRows = 6,
  empty,
  defaultSort,
  sort: sortProp,
  onSortChange,
  pageSize,
  rowActions,
  phoneDetail,
  selection,
  rowTone,
  breakBefore,
  resetKey,
  onView,
  className,
}: DataTableProps<T>) {
  const [ownSort, setOwnSort] = React.useState<Sort | null>(defaultSort ?? null);
  const sort = sortProp !== undefined ? sortProp : ownSort;
  const [page, setPage] = React.useState(1);
  const [opened, setOpened] = React.useState<string | null>(null);
  const id = React.useId();
  const [seenKey, setSeenKey] = React.useState(resetKey);
  if (seenKey !== resetKey) {
    setSeenKey(resetKey);
    setPage(1);
  }

  const setSort = (next: Sort) => {
    if (sortProp === undefined) setOwnSort(next);
    onSortChange?.(next);
    setPage(1);
  };
  const toggleSort = (colId: string) => setSort({ id: colId, dir: sort?.id === colId && sort.dir === "asc" ? "desc" : "asc" });

  const sorted = React.useMemo(() => {
    const col = sort ? columns.find((c) => c.id === sort.id) : undefined;
    if (!sort || !col?.sortValue) return rows;
    const value = col.sortValue;
    return rows
      .map((row, i) => ({ row, i, v: value(row) }))
      .sort((a, b) => compare(a.v, b.v, sort.dir) || a.i - b.i)
      .map((x) => x.row);
  }, [rows, columns, sort]);

  const total = sorted.length;
  const pages = pageSize ? Math.max(1, Math.ceil(total / pageSize)) : 1;
  const current = Math.min(page, pages);
  const shown = pageSize ? sorted.slice((current - 1) * pageSize, current * pageSize) : sorted;

  const sortable = columns.filter((c) => c.sortValue);
  const titleCol = columns.find((c) => c.phone === "title") ?? columns[0];
  const subCols = columns.filter((c) => c.phone === "subtitle");
  const trailingCol = columns.find((c) => c.phone === "trailing");
  const fieldCols = columns.filter((c) => c !== titleCol && (c.phone ?? "field") === "field");
  const span = columns.length + (selection ? 1 : 0) + (rowActions ? 1 : 0);
  // The first column sits flush with the page's left edge, unless rows can carry a tint: type needs air inside a tint.
  const flush = !selection && !rowTone;
  // Likewise the last column runs to the right edge when no actions follow it. A column hidden at every width is skipped.
  const lastShown = columns.reduce((last, c, i) => (/(^|\s)hidden(\s|$)/.test(c.className ?? "") ? last : i), -1);
  const edge = (i: number) => cn(i === 0 && flush && "pl-0 lg:pl-0", i === lastShown && !rowActions && !rowTone && "pr-0 lg:pr-0");
  const pageKeys = shown.map(rowKey);

  const rowsKey = `fleet:rows:${usePathname() ?? ""}:${noun}`;
  const placeholders = useRememberedRows(rowsKey) ?? skeletonRows;
  const shownCount = shown.length;
  React.useEffect(() => {
    if (loading) return;
    try {
      sessionStorage.setItem(rowsKey, String(shownCount));
    } catch {
      // private mode, or storage switched off: the default row count stands in
    }
  }, [loading, rowsKey, shownCount]);
  // The last visit found nothing: hold the room the empty message takes, not rows.
  const emptyHold = (
    <div aria-hidden="true" className="flex min-h-[171px] items-center justify-center py-6">
      <span className="block h-[10px] w-40 animate-pulse rounded-sm bg-panel-2" />
    </div>
  );
  const start = pageSize ? (current - 1) * pageSize : 0;

  // Report what is on screen by its keys, so a parent that builds `rows` afresh on every render is not told twice.
  const viewSig = `${start}/${total}/${pageKeys.join("\u0001")}`;
  const report = React.useRef<() => void>(() => {});
  React.useEffect(() => {
    report.current = () => onView?.({ keys: pageKeys, start, total });
  });
  React.useEffect(() => {
    if (!loading) report.current();
  }, [viewSig, loading]);
  const allSelected = !!selection && pageKeys.length > 0 && pageKeys.every((k) => selection.selected.has(k));
  const someSelected = !!selection && pageKeys.some((k) => selection.selected.has(k));

  const emptyBlock = (
    <div className="flex min-h-[171px] flex-col items-center justify-center gap-1.5 py-6 text-center" data-table-empty="">
      <div className="text-balance text-[13px] font-semibold">{empty.title}</div>
      {empty.hint != null && <div className="max-w-[60ch] text-pretty text-[12px] text-muted-foreground">{tied(empty.hint)}</div>}
      {empty.action != null && <div className="mt-2">{empty.action}</div>}
    </div>
  );

  const checkbox = (row: T, key: string) =>
    selection && (
      <input
        type="checkbox"
        aria-label={`Select ${selection.label(row)}`}
        checked={selection.selected.has(key)}
        onChange={() => selection.onToggle(key, row)}
        className="touch-hit h-[15px] w-[15px] shrink-0 accent-[var(--primary)]"
      />
    );

  return (
    <div className={className} data-table={noun}>
      {/* ── from md: the table ─────────────────────────────────────────── */}
      <div className="overflow-x-auto max-md:hidden">
        <table className="w-full border-collapse text-[12.5px]" aria-busy={loading || undefined}>
          <caption className="sr-only">
            {noun}
            {sort ? `, sorted by ${columns.find((c) => c.id === sort.id)?.header ?? sort.id}, ${sort.dir === "asc" ? "ascending" : "descending"}` : ""}
          </caption>
          <thead>
            <tr className="border-b-2 border-foreground">
              {selection && (
                <th scope="col" className="w-[34px] py-3 pr-2 text-left">
                  <input
                    type="checkbox"
                    aria-label={`Select all ${noun} on this page`}
                    checked={allSelected}
                    ref={(el) => {
                      if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={() => selection.onToggleAll(pageKeys, !allSelected)}
                    disabled={loading || shown.length === 0}
                    className="h-[15px] w-[15px] accent-[var(--primary)]"
                  />
                </th>
              )}
              {columns.map((c, i) => {
                const active = sort?.id === c.id;
                return (
                  <th
                    key={c.id}
                    scope="col"
                    aria-sort={c.sortValue ? (active ? (sort!.dir === "asc" ? "ascending" : "descending") : "none") : undefined}
                    className={cn("eyebrow px-3 py-3 font-medium text-faint lg:px-4", edge(i), c.numeric || c.end ? "text-right" : "text-left", c.grow && GROW, c.className)}
                  >
                    {c.sortValue ? (
                      <button
                        type="button"
                        onClick={() => toggleSort(c.id)}
                        className={cn(
                          "group -my-1 inline-flex items-center gap-1 rounded-sm py-1 uppercase tracking-[inherit] transition-colors duration-150 hover:text-foreground",
                          (c.numeric || c.end) && "flex-row-reverse",
                          active && "text-foreground"
                        )}
                      >
                        {c.header}
                        <span aria-hidden="true" className={cn("inline-flex w-[11px] justify-center", !active && "opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100")}>
                          {active ? sort!.dir === "asc" ? <ArrowUp size={11} strokeWidth={2} /> : <ArrowDown size={11} strokeWidth={2} /> : <ChevronsUpDown size={11} strokeWidth={1.75} />}
                        </span>
                      </button>
                    ) : (
                      c.header
                    )}
                  </th>
                );
              })}
              {rowActions && (
                <th scope="col" className="eyebrow py-3 pl-3 text-right font-medium text-faint lg:pl-4">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {loading && placeholders === 0 ? (
              <tr aria-hidden="true" className="border-b border-border">
                <td colSpan={span}>{emptyHold}</td>
              </tr>
            ) : loading ? (
              Array.from({ length: placeholders }, (_, r) => (
                <tr key={r} aria-hidden="true" className="h-[61px] border-b border-border">
                  {selection && <td className="py-2 pr-2" />}
                  {columns.map((c, i) => (
                    <td key={c.id} className={cn("px-3 py-2 lg:px-4", edge(i), c.grow && GROW, c.className)}>
                      <span className={cn("block h-[10px] animate-pulse rounded-sm bg-panel-2", (c.numeric || c.end) && "ml-auto", c.skeleton ?? (i === 0 ? "w-40" : "w-16"))} />
                    </td>
                  ))}
                  {rowActions && (
                    <td className="py-2 pl-3 lg:pl-4">
                      <span className="ml-auto block h-[10px] w-14 animate-pulse rounded-sm bg-panel-2" />
                    </td>
                  )}
                </tr>
              ))
            ) : shown.length === 0 ? (
              <tr className="border-b border-border">
                <td colSpan={span}>{emptyBlock}</td>
              </tr>
            ) : (
              shown.map((row, at) => {
                const key = rowKey(row);
                return (
                  <React.Fragment key={key}>
                  {breakBefore?.(row, shown[at - 1]) && (
                    <tr aria-hidden="true" className="h-2.5">
                      <td colSpan={span} className="p-0" />
                    </tr>
                  )}
                  <tr className={cn("h-[61px] border-b border-border transition-colors duration-150 hover:bg-panel-2/60", tone(rowTone?.(row)), selection?.selected.has(key) && "bg-primary/8")}>
                    {selection && <td className="py-2 pr-2 align-middle">{checkbox(row, key)}</td>}
                    {columns.map((c, i) => (
                      <td key={c.id} className={cn("px-3 py-2 lg:px-4 align-middle", edge(i), c.numeric && "text-right font-mono tabular-nums", c.end && "text-right", c.grow && GROW, c.className)}>
                        {c.cell(row, "table")}
                      </td>
                    ))}
                    {rowActions && (
                      <td className="py-2 pl-3 lg:pl-4 align-middle">
                        <div className="flex items-center justify-end gap-2">{rowActions(row, "table")}</div>
                      </td>
                    )}
                  </tr>
                  </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* ── below md: the same rows as summaries that open ─────────────── */}
      <div className="md:hidden">
        {(sortable.length > 0 || selection) && (
          <div className="flex min-h-[33px] items-center gap-2 pb-3">
            {selection && (
              <label className="eyebrow flex shrink-0 items-center gap-2 pr-2 text-faint">
                <input
                  type="checkbox"
                  aria-label={`Select all ${noun} on this page`}
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected && !allSelected;
                  }}
                  onChange={() => selection.onToggleAll(pageKeys, !allSelected)}
                  disabled={loading || shown.length === 0}
                  className="touch-hit h-[15px] w-[15px] accent-[var(--primary)]"
                />
                All
              </label>
            )}
            {sortable.length > 0 && (
              <span className="eyebrow text-faint" id={`${id}-sort`}>
                Sort
              </span>
            )}
            {sortable.length > 0 && (
            <Select
              aria-labelledby={`${id}-sort`}
              wrapperClassName="min-w-0 flex-1"
              // Stays in place with nothing to sort, so the list below does not move when its rows arrive.
              disabled={loading || total < 2}
              value={sort ? `${sort.id}:${sort.dir}` : ""}
              onChange={(e) => {
                const [colId, dir] = e.target.value.split(":");
                if (colId) setSort({ id: colId, dir: dir as SortDir });
              }}
            >
              {!sort && <option value="">As listed</option>}
              {sortable.flatMap((c) => [
                <option key={`${c.id}:asc`} value={`${c.id}:asc`}>
                  {c.header}, {c.sortWords?.[0] ?? (c.numeric ? "low to high" : "A to Z")}
                </option>,
                <option key={`${c.id}:desc`} value={`${c.id}:desc`}>
                  {c.header}, {c.sortWords?.[1] ?? (c.numeric ? "high to low" : "Z to A")}
                </option>,
              ])}
            </Select>
            )}
          </div>
        )}
        <ul className="border-t-2 border-foreground" aria-label={noun} aria-busy={loading || undefined}>
          {loading && placeholders === 0 ? (
            <li aria-hidden="true" className="border-b border-border">
              {emptyHold}
            </li>
          ) : loading ? (
            Array.from({ length: placeholders }, (_, r) => (
              <li key={r} aria-hidden="true" className="box-content flex h-[61px] flex-col justify-center gap-2 border-b border-border">
                <span className="block h-[11px] w-44 animate-pulse rounded-sm bg-panel-2" />
                <span className="block h-[9px] w-28 animate-pulse rounded-sm bg-panel-2" />
              </li>
            ))
          ) : shown.length === 0 ? (
            <li className="border-b border-border">{emptyBlock}</li>
          ) : (
            shown.map((row, at) => {
              const key = rowKey(row);
              const isOpen = opened === key;
              const more = fieldCols.length > 0 || !!rowActions || !!phoneDetail;
              return (
                <li
                  key={key}
                  className={cn("border-b border-border", tone(rowTone?.(row)), selection?.selected.has(key) && "bg-primary/8", breakBefore?.(row, shown[at - 1]) && "mt-2.5 border-t")}
                >
                  <div className="relative flex min-h-[61px] items-center gap-3 py-2">
                    {selection && <span className="relative z-[1] flex">{checkbox(row, key)}</span>}
                    {more && (
                      <button
                        type="button"
                        aria-expanded={isOpen}
                        // Ids come from the row's place, not its key: a key can hold spaces ("nginx · site"), and these
                        // two attributes are lists split on spaces. The panel is only named while it is in the page.
                        aria-controls={isOpen ? `${id}-r${at}` : undefined}
                        aria-labelledby={`${id}-r${at}-t`}
                        onClick={() => setOpened(isOpen ? null : key)}
                        className="absolute inset-0 rounded-sm focus-visible:-outline-offset-2"
                      />
                    )}
                    <div className="pointer-events-none relative flex min-w-0 flex-1 items-center gap-3 [&_a]:pointer-events-auto [&_button]:pointer-events-auto">
                      <div className="min-w-0 flex-1">
                        <div id={`${id}-r${at}-t`} className="truncate text-[13px] font-semibold">
                          {titleCol.cell(row, "phone")}
                        </div>
                        {subCols.length > 0 && (
                          <div className="mt-0.5 flex min-w-0 items-center gap-1.5 truncate text-[11.5px] text-muted-foreground">
                            {subCols.map((c, i) => (
                              <React.Fragment key={c.id}>
                                {i > 0 && <span aria-hidden="true">·</span>}
                                <span className="min-w-0 truncate">{c.cell(row, "phone")}</span>
                              </React.Fragment>
                            ))}
                          </div>
                        )}
                      </div>
                      {trailingCol && <div className="shrink-0">{trailingCol.cell(row, "phone")}</div>}
                      {more && <ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" className={cn("shrink-0 text-muted-foreground transition-transform duration-150", isOpen && "rotate-180")} />}
                    </div>
                  </div>
                  {more && isOpen && (
                    <div id={`${id}-r${at}`} className="pb-3.5">
                      {phoneDetail?.(row)}
                      {fieldCols.length > 0 && (
                        <dl>
                          {fieldCols.map((c) => (
                            <div key={c.id} className="flex items-baseline justify-between gap-4 border-t border-border py-2 first:border-t-0">
                              <dt className="eyebrow shrink-0 text-faint">{c.header}</dt>
                              <dd className={cn("min-w-0 text-right text-[12.5px]", c.numeric && "font-mono tabular-nums")}>{c.cell(row, "phone")}</dd>
                            </div>
                          ))}
                        </dl>
                      )}
                      {rowActions && <div className="mt-2.5 flex flex-wrap items-center justify-end gap-2">{rowActions(row, "phone")}</div>}
                    </div>
                  )}
                </li>
              );
            })
          )}
        </ul>
      </div>

      {pageSize != null && !loading && <Pager page={current} pageSize={pageSize} total={total} noun={noun} onPage={setPage} className="pt-3.5" />}
      {pageSize != null && loading && <div className="h-[calc(33px+14px)]" aria-hidden="true" />}
    </div>
  );
}
