import * as React from "react";
import { cn, tied } from "@/lib/utils";

type FigureTone = "default" | "ok" | "warn" | "danger";

type Delta = {
  /** Which way it moved. The arrow carries it, so it never rides on color alone. Leave out for a remark that is not a move. */
  dir?: "up" | "down" | "flat";
  /** "1", "3 this week", "12%". */
  text: React.ReactNode;
  /** Whether that move is good news. Defaults to no judgment (muted). */
  tone?: "ok" | "warn" | "danger";
};

type FigureProps = Omit<React.HTMLAttributes<HTMLDivElement>, "children"> & {
  label: React.ReactNode;
  /** A status light before the label. */
  mark?: React.ReactNode;
  /** A small control after the label: an info button. Like `mark`, it sits outside the label's clipping. */
  aside?: React.ReactNode;
  /** The number. `null` while it loads: its room is held and a placeholder pulses there. */
  value: React.ReactNode | null;
  /** A unit set small after the number: "GB", "%". */
  unit?: React.ReactNode;
  /** The change, beside the number. Pass `null` when there is none yet: its room is held either way. */
  delta?: Delta | null;
  /** One short line under the number. Its line is held even when empty, so a late one moves nothing. */
  note?: React.ReactNode;
  tone?: FigureTone;
  /** "lg" is the page's lead figure; "md" the board figure. */
  size?: "md" | "lg";
  className?: string;
};

const arrows = { up: "▲", down: "▼", flat: "■" } as const;
const words = { up: "up", down: "down", flat: "no change" } as const;

/**
 * Figure — a label, a big number and the change beside it. No box. The change
 * and the note keep their room from the first paint, so a figure that fills in
 * late moves nothing around it.
 */
export function Figure({ label, mark, aside, value, unit, delta, note, tone = "default", size = "md", className, ...props }: FigureProps) {
  const loading = value === null;
  return (
    <div className={cn("min-w-0", className)} data-figure="" {...props}>
      <div className="flex min-h-[18px] items-center gap-2">
        {mark}
        <div
          className={cn(
            "eyebrow min-w-0 truncate text-faint",
            // In a row whose labels run long they wrap instead, and every label keeps two lines so the numbers stay level.
            "group-data-[long-labels]/figures:min-h-[2lh] group-data-[long-labels]/figures:whitespace-normal group-data-[long-labels]/figures:text-balance xl:group-data-[long-labels]/figures:min-h-0"
          )}
        >
          {label}
        </div>
        {aside}
      </div>
      {/* It wraps so a change too long for a narrow column drops under the number and is never cut off. */}
      <div className={cn("mt-2 flex flex-wrap items-baseline gap-x-2.5 gap-y-1", size === "lg" ? "min-h-[64px] lg:min-h-[78px]" : "min-h-[40px]")}>
        {loading ? (
          <span
            aria-hidden="true"
            // The margins make its line as tall as the number's (40, 64 or 78px): the row can wrap, so the line is no longer stretched for it.
            className={cn("animate-pulse self-center rounded-sm bg-panel-2", size === "lg" ? "my-[6px] h-[52px] w-[3.2ch] text-[64px] lg:my-[8px] lg:h-[62px] lg:text-[78px]" : "my-[5px] h-[30px] w-[3.2ch] text-[40px]")}
          />
        ) : (
          <span
            className={cn(
              "font-bold tabular-nums",
              // The line height comes after the size on purpose: twMerge drops a `leading-*` that a font size follows.
              size === "lg" ? "text-[64px] font-extrabold tracking-[-0.045em] lg:text-[78px]" : "text-[40px] tracking-[-0.03em]",
              "leading-none",
              tone === "ok" && "text-primary",
              tone === "warn" && "text-warning",
              tone === "danger" && "text-danger"
            )}
          >
            {value}
            {unit != null && <span className="ml-1 text-[0.4em] font-semibold tracking-normal text-muted-foreground">{unit}</span>}
          </span>
        )}
        {delta !== undefined && (
          <span
            className={cn(
              "eyebrow inline-flex min-h-[18px] min-w-[4ch] items-center gap-1 whitespace-nowrap",
              // Two across on a phone, a long change ("Action required") cannot sit beside the number. Its own line, in
              // every state, so the row is the same height before and after the number arrives.
              // It may also break there: at 320px with a scrollbar taking room, "Action required" is 6px wider than its column.
              "max-md:group-data-[stack-delta]/figures:basis-full max-md:group-data-[stack-delta]/figures:whitespace-normal",
              delta == null && "invisible",
              delta?.tone === "ok" ? "text-primary" : delta?.tone === "warn" ? "text-warning" : delta?.tone === "danger" ? "text-danger" : "text-muted-foreground"
            )}
          >
            {delta != null ? (
              <>
                {delta.dir && (
                  <>
                    <span aria-hidden="true">{arrows[delta.dir]}</span>
                    <span className="sr-only">{words[delta.dir]}</span>
                  </>
                )}
                {delta.text}
              </>
            ) : (
              "–"
            )}
          </span>
        )}
      </div>
      {note !== undefined && (
        <div data-figure-note="" className="mt-1.5 min-h-[1lh] text-pretty text-[12px] leading-snug text-muted-foreground">
          {/* 16: two across on a phone a note's column is about 120px, and a longer glued pair would not fit it. */}
          {tied(note, 16)}
        </div>
      )}
    </div>
  );
}

// Written out in full so Tailwind sees every class: the row forms at `md`, or at `lg` for five across.
const rowAt = {
  md: {
    cols: { 2: "md:grid-cols-2", 3: "md:grid-cols-3", 4: "md:grid-cols-4" },
    below:
      "max-md:[&>*:nth-child(even)]:border-l max-md:[&>*:nth-child(even)]:border-border max-md:[&>*:nth-child(even)]:pl-5 max-md:[&>*:nth-child(odd)]:pr-5",
    from: "md:[&>*]:border-l md:[&>*]:border-border md:[&>*]:px-5 md:[&>*:first-child]:border-l-0 md:[&>*:first-child]:pl-0 md:[&>*:last-child]:pr-0",
  },
  lg: {
    cols: { 5: "lg:grid-cols-5" },
    below:
      "max-lg:[&>*:nth-child(even)]:border-l max-lg:[&>*:nth-child(even)]:border-border max-lg:[&>*:nth-child(even)]:pl-5 max-lg:[&>*:nth-child(odd)]:pr-5",
    from: "lg:[&>*]:border-l lg:[&>*]:border-border lg:[&>*]:px-5 lg:[&>*:first-child]:border-l-0 lg:[&>*:first-child]:pl-0 lg:[&>*:last-child]:pr-0",
  },
} as const;

/**
 * Figures — a row of figures split by hairlines, with one rule under them. Two
 * across on a narrow screen, then one row of `cols`: from `md`, or from `lg`
 * when there are five, which need the room.
 */
export function Figures({
  cols = 4,
  longLabels = false,
  stackDelta = false,
  className,
  children,
}: {
  cols?: 2 | 3 | 4 | 5;
  /** Set when a change can outrun a phone's half-width column ("Action required"): below `md` every change sits under its number. */
  stackDelta?: boolean;
  /** Set when a label can outrun its column ("Standard, reordered"): labels wrap to two lines instead of being cut short. */
  longLabels?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  const at = cols === 5 ? rowAt.lg : rowAt.md;
  return (
    <div
      data-long-labels={longLabels ? "" : undefined}
      data-stack-delta={stackDelta ? "" : undefined}
      className={cn(
        "group/figures grid grid-cols-2 gap-y-5 border-b border-line-strong pb-5",
        // Two across on a narrow screen, a note nearly always takes two lines: hold both so it does not grow when it arrives.
        cols === 5 ? "max-lg:[&_[data-figure-note]]:min-h-[2lh]" : "max-md:[&_[data-figure-note]]:min-h-[2lh]",
        (at.cols as Record<number, string>)[cols],
        // hairlines between figures, never before the first in a row
        at.below,
        at.from,
        className
      )}
    >
      {children}
    </div>
  );
}
