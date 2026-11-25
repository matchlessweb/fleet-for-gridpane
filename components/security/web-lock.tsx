"use client";

import { Copyable, StatusPill } from "@/components/ui";
import { allowlistLabel, describeWebLock, type CloudflareRanges, type WebLock } from "@/lib/web-lock";
import { tied } from "@/lib/utils";

type AllowLike = { ip: string; label: string | null };

/** The one-word answer: are this server's web ports locked to Cloudflare? */
export function WebLockPill({ lock }: { lock: WebLock }) {
  const { label, tone } = describeWebLock(lock);
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** Pill, explanation, and the addresses behind the verdict. */
export function WebLockDetail({
  lock,
  ranges,
  allows = [],
}: {
  lock: WebLock;
  ranges: CloudflareRanges;
  /** Operator allowlist rows, so an extra address is named by its label. */
  allows?: readonly AllowLike[];
}) {
  const { note } = describeWebLock(lock);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <WebLockPill lock={lock} />
        {lock.cloudflareSources > 0 && (
          <span className="font-mono text-[10.5px] text-faint">
            {lock.cloudflareSources} Cloudflare {lock.cloudflareSources === 1 ? "range" : "ranges"} allowed
          </span>
        )}
      </div>
      <p className="text-pretty text-[11.5px] leading-relaxed text-faint">{tied(note)}</p>
      {lock.others.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-faint">Also open to</span>
          <OtherAddresses addrs={lock.others} allows={allows} />
        </div>
      )}
      {lock.status === "cloudflare-partial" && (
        <div className="flex flex-col gap-1">
          <span className="eyebrow text-faint">Cloudflare ranges with no rule</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {lock.missing.map((addr) => (
              <Copyable key={addr} value={addr} what="IP range" className="text-[11.5px] text-muted-foreground">
                {addr}
              </Copyable>
            ))}
          </div>
        </div>
      )}
      {lock.status !== "unreported" && <RangesSource ranges={ranges} />}
    </div>
  );
}

/**
 * Each extra address with its allowlist label, or a warning that none covers it:
 * an address with web access and no record of why is the one to look at.
 */
export function OtherAddresses({ addrs, allows }: { addrs: string[]; allows: readonly AllowLike[] }) {
  return (
    <span className="flex flex-wrap gap-x-4 gap-y-1">
      {addrs.map((addr) => {
        const label = allowlistLabel(addr, allows);
        return (
          <span key={addr} className="inline-flex flex-wrap items-baseline gap-x-1.5">
            <Copyable value={addr} what="IP address" className="text-[11.5px] text-muted-foreground">
              {addr}
            </Copyable>
            {label ? (
              <span className="text-[11px] text-faint">{label}</span>
            ) : (
              <span className="text-[11px] text-warning">not on the allowlist</span>
            )}
          </span>
        );
      })}
    </span>
  );
}

export function RangesSource({ ranges }: { ranges: CloudflareRanges }) {
  return (
    <p className="text-pretty text-[11px] leading-relaxed text-faint">
      {ranges.source === "cloudflare"
        ? `Compared with Cloudflare's ${ranges.ranges.length} published ranges as of\u00a0${ranges.asOf}.`
        : `Compared with the ${ranges.ranges.length} ranges built into the app (${ranges.asOf}); Cloudflare's current list could not be fetched.`}
    </p>
  );
}
