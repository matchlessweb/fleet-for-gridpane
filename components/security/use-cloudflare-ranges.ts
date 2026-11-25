"use client";

import { useEffect, useState } from "react";
import { BUILT_IN_RANGES, type CloudflareRanges } from "@/lib/web-lock";

/** Today's Cloudflare ranges; the built-in list until (or unless) the fetch lands. */
export function useCloudflareRanges(): CloudflareRanges {
  const [ranges, setRanges] = useState<CloudflareRanges>(BUILT_IN_RANGES);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch("/api/cloudflare-ips");
        const data = (await res.json()) as CloudflareRanges;
        if (!cancelled && Array.isArray(data?.ranges) && data.ranges.length > 0) setRanges(data);
      } catch {
        // keep the built-in list
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return ranges;
}
