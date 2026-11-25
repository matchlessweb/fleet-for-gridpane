"use client";

import * as React from "react";
import { SlidersHorizontal } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./button";
import { FilterPill } from "./filter-pill";
import { SearchInput } from "./input";
import { PopoverSheet } from "./popover-sheet";

export type FilterOption = {
  id: string;
  label: string;
  /** How many rows it holds right now. `null` while that is not known yet: the pill keeps its place. */
  count: number | null;
};

type FilterBarProps = {
  /** What is being filtered, plural: "servers". Names the controls for screen readers. */
  noun: string;
  search?: { value: string; onChange: (value: string) => void; placeholder?: string };
  /** The questions people actually ask, one tap each. The first is "All". */
  pills?: FilterOption[];
  value?: string;
  onChange?: (id: string) => void;
  /** The rarer filters: selects and the like. They open under "More". */
  more?: React.ReactNode;
  /** How many of the rarer filters are set. Shown on the button so a hidden filter is never a surprise. */
  moreActive?: number;
  /** Puts everything back. Shown only when something is set. */
  onClear?: () => void;
  /** Anything that belongs at the end of the row (a page action). */
  children?: React.ReactNode;
  className?: string;
};

/**
 * FilterBar — the quick filters as pills with live counts, then search, then
 * "More" for the rest. On phones the pills take the first line and scroll
 * sideways; search and "More" share the line under it.
 */
export function FilterBar({ noun, search, pills, value, onChange, more, moreActive = 0, onClear, children, className }: FilterBarProps) {
  const [moreOpen, setMoreOpen] = React.useState(false);
  const anchor = React.useRef<HTMLDivElement>(null);
  const anySet = (search?.value ?? "") !== "" || (pills != null && value != null && value !== pills[0]?.id) || moreActive > 0;

  return (
    <div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2.5", className)} data-filter-bar={noun}>
      {pills && pills.length > 0 && (
        <div
          role="group"
          aria-label={`Filter ${noun}`}
          className="hide-scrollbar flex min-w-0 items-center gap-1.5 max-lg:basis-full max-md:-mx-5 max-md:overflow-x-auto max-md:px-5 md:flex-wrap"
        >
          {pills.map((p) => (
            <FilterPill key={p.id} active={p.id === value} count={p.count ?? undefined} onClick={() => onChange?.(p.id)}>
              {p.label}
              {p.count === null && <span aria-hidden="true" className="inline-block h-[9px] w-[1.6ch] animate-pulse rounded-sm bg-current opacity-20" />}
            </FilterPill>
          ))}
        </div>
      )}
      {/* One line from lg, flush right. Below that it takes the line under the pills. */}
      <div className="flex min-w-0 items-center gap-2 max-lg:basis-full lg:ml-auto">
        {search && (
          <SearchInput
            type="search"
            value={search.value}
            onChange={(e) => search.onChange(e.target.value)}
            placeholder={search.placeholder ?? `Search ${noun}`}
            aria-label={search.placeholder ?? `Search ${noun}`}
            wrapperClassName="min-w-0 max-md:flex-1 md:w-[260px]"
          />
        )}
        {more != null && (
          <div ref={anchor} className="relative shrink-0">
            <Button aria-haspopup="dialog" aria-expanded={moreOpen} onClick={() => setMoreOpen((o) => !o)}>
              <SlidersHorizontal size={13} strokeWidth={1.75} aria-hidden="true" />
              More
              {moreActive > 0 && (
                <span className="rounded-sm bg-foreground px-1 font-mono text-[10px] leading-[1.5] text-background">
                  {moreActive}
                  <span className="sr-only"> set</span>
                </span>
              )}
            </Button>
            <PopoverSheet open={moreOpen} onClose={() => setMoreOpen(false)} anchorRef={anchor} label={`More filters for ${noun}`} className="w-[300px]">
              <div className="flex flex-col gap-3.5 p-4">
                <div className="rulehead">More filters</div>
                {more}
              </div>
            </PopoverSheet>
          </div>
        )}
        {/* From lg it appears left of the search, in the free space, so the search and "More" stay where they are. */}
        {onClear && anySet && (
          <button type="button" onClick={onClear} className="eyebrow touch-hit shrink-0 px-1 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline lg:order-first">
            Clear
          </button>
        )}
      </div>
      {children != null && <div className="ml-auto flex shrink-0 items-center gap-2">{children}</div>}
    </div>
  );
}

/** A labeled control inside the "More" panel. */
export function FilterField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="eyebrow text-faint">{label}</span>
      {children}
    </label>
  );
}
