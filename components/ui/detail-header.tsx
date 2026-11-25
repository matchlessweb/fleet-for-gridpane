import * as React from "react";
import { cn } from "@/lib/utils";

type Fact = React.ReactNode | null | undefined | false;

type DetailHeaderProps = {
  /** The thing's name. `null` while it loads: its line is held and a placeholder pulses there. */
  title: React.ReactNode | null;
  /** Status pills beside the name. */
  status?: React.ReactNode;
  /** The line of facts under the name: an IP, a provider, a count. Empty ones are dropped. `null` while they load. */
  facts?: Fact[] | null;
  /** Buttons at the right; under the facts on phones, sharing the width. */
  actions?: React.ReactNode;
  /** Set to 2 when the facts are long enough to take two lines on a phone, so that room is held while they load. */
  phoneFactLines?: 1 | 2;
  className?: string;
};

/**
 * DetailHeader — the title block on a page about one thing (a server, a site,
 * a zone, a snapshot). The breadcrumb above it comes from the layout. Then the
 * name with its status, a line of facts, actions on the right and one rule
 * under it. The name and the facts keep their lines while they load, so
 * nothing under the rule moves when they arrive.
 */
export function DetailHeader({ title, status, facts, actions, phoneFactLines = 1, className }: DetailHeaderProps) {
  const shown = (facts ?? []).filter((f) => f != null && f !== false && f !== "");
  return (
    <header data-detail-header="" className={cn("flex flex-wrap items-end justify-between gap-x-5 gap-y-4 border-b border-line-strong pb-5", className)}>
      <div className="min-w-0 flex-1 basis-[280px]">
        <div className="flex min-h-[32px] flex-wrap items-center gap-x-3 gap-y-1.5">
          {title === null ? (
            <span aria-hidden="true" className="block h-[22px] w-56 max-w-full animate-pulse rounded-sm bg-panel-2" />
          ) : (
            <h1 className="min-w-0 text-[26px] font-extrabold leading-[1.15] tracking-[-0.02em] [overflow-wrap:anywhere]">{title}</h1>
          )}
          {status}
        </div>
        {/* Each fact carries its dot on its left, in room the row pulls back out of view: a fact that
            starts a line shows no dot, so a wrapped line never ends or begins with one. */}
        {/* 22px is a fact with a copy button beside it: the line is that tall from the start. */}
        <div
          className={cn("-ml-1 mt-2 min-h-[22px] overflow-x-clip pl-1 font-mono text-[11.5px] text-muted-foreground", facts === null && phoneFactLines === 2 && "max-sm:min-h-[48px]")}
          data-detail-facts=""
        >
          {facts === null ? (
            <span aria-hidden="true" className="mt-[6.5px] block h-[9px] w-64 max-w-full animate-pulse rounded-sm bg-panel-2" />
          ) : (
            <div className="-ml-[17px] flex min-h-[22px] flex-wrap items-center gap-y-1">
              {shown.map((fact, i) => (
                <span key={i} className="relative inline-flex min-h-[22px] min-w-0 items-center gap-1.5 pl-[17px]">
                  <span aria-hidden="true" className="absolute left-[6px] top-1/2 -translate-y-1/2 text-faint">
                    ·
                  </span>
                  {fact}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {actions != null && <div className="flex flex-wrap items-center gap-2 max-sm:w-full max-sm:[&>*]:flex-1">{actions}</div>}
    </header>
  );
}
