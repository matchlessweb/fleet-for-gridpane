"use client";

import { cn } from "@/lib/utils";
import { useThresholds } from "@/components/providers/settings-provider";
import { toneFor, type Metric } from "@/lib/thresholds";

/**
 * Hairline meter.
 *
 * `metric` opts a meter INTO utilization colouring against the operator's
 * configured warn/critical bands. Omit it and the bar stays a single colour at
 * every value.
 *
 * That default is the point, not laziness. The colouring used to be
 * unconditional (amber >= 75, red >= 90), which quietly made the task-progress
 * bar turn red as a job approached completion — the one moment it should have
 * looked healthiest. A progress bar and a utilization bar want opposite things
 * from a high number, so the component now makes each caller say which it is.
 */
export function Meter({
  value,
  metric,
  className,
}: {
  value: number;
  metric?: Metric;
  className?: string;
}) {
  const thresholds = useThresholds();
  const v = Math.max(0, Math.min(100, value));
  const tone = metric ? toneFor(v, metric, thresholds) : "ok";
  return (
    <div
      role="meter"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={v}
      className={cn(
        "h-[4px] w-full overflow-hidden rounded-sm bg-panel-2 border border-border",
        className
      )}
    >
      <div
        className={cn(
          "h-full transition-all duration-300",
          tone === "critical" ? "bg-danger" : tone === "warn" ? "bg-warning" : "bg-primary"
        )}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}
