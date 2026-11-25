/**
 * Telemetry warn/critical thresholds.
 *
 * Before this existed the fleet had two disagreeing sets of hardcoded numbers:
 * `Meter` coloured amber at >= 75 and red at >= 90 for every metric, while the
 * dashboard counted a node "under load" at `cpu > 80 || ram > 90`. Neither was
 * reachable from the settings page, which offered a third set (90/95/85) bound
 * to nothing at all. This module is the single definition all of them now read.
 *
 * Pure on purpose — no imports, no Supabase. The row is fetched once by
 * SettingsProvider and passed in, so every consumer can be tested with plain
 * values and the resolution rule stays independent of how it is loaded.
 */

export type Metric = "cpu" | "memory" | "disk";

/** Ordered by severity — callers rely on "critical" being the worst. */
export type Tone = "ok" | "warn" | "critical";

export type Band = { warn: number; critical: number };

export type Thresholds = Record<Metric, Band>;

/**
 * Matches the behaviour that was hardcoded in `Meter` before this table
 * existed, so adopting the setting changes nothing until it is deliberately
 * edited. The database carries the same defaults; this constant is the
 * client-side fallback for the moment before the row loads (and if it ever
 * fails to), because a meter with no colour is a worse answer than a meter
 * with yesterday's rule.
 */
export const DEFAULT_THRESHOLDS: Thresholds = {
  cpu: { warn: 75, critical: 90 },
  memory: { warn: 75, critical: 90 },
  disk: { warn: 75, critical: 90 },
};

export const METRIC_LABELS: Record<Metric, string> = {
  cpu: "CPU",
  memory: "Memory",
  disk: "Disk",
};

/** Shape of the single `app_settings` row, as PostgREST returns it. */
export type AppSettingsRow = {
  cpu_warn: number;
  cpu_critical: number;
  memory_warn: number;
  memory_critical: number;
  disk_warn: number;
  disk_critical: number;
};

/**
 * Numeric columns arrive from PostgREST as numbers, but a hand-edited row or a
 * future `numeric` serialisation change could hand us a string or a null. Coerce
 * defensively and fall back per-field rather than discarding the whole row —
 * one bad column should not reset the other five.
 */
function num(value: unknown, fallback: number): number {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : fallback;
}

export function thresholdsFromRow(row: Partial<AppSettingsRow> | null | undefined): Thresholds {
  if (!row) return DEFAULT_THRESHOLDS;
  const d = DEFAULT_THRESHOLDS;
  return {
    cpu: {
      warn: num(row.cpu_warn, d.cpu.warn),
      critical: num(row.cpu_critical, d.cpu.critical),
    },
    memory: {
      warn: num(row.memory_warn, d.memory.warn),
      critical: num(row.memory_critical, d.memory.critical),
    },
    disk: {
      warn: num(row.disk_warn, d.disk.warn),
      critical: num(row.disk_critical, d.disk.critical),
    },
  };
}

/**
 * Which band a reading falls into.
 *
 * Boundaries are inclusive (`>=`), matching the original Meter rule: a reading
 * of exactly 90 against a critical of 90 is critical, not warning. The old
 * dashboard counter used exclusive `>`, so its figure will shift slightly —
 * that inconsistency is the thing being removed, not a regression.
 */
export function toneFor(value: number, metric: Metric, t: Thresholds): Tone {
  const band = t[metric];
  if (value >= band.critical) return "critical";
  if (value >= band.warn) return "warn";
  return "ok";
}

/** True when any of the three readings has reached its critical band. */
export function isUnderLoad(
  readings: Partial<Record<Metric, number | null | undefined>>,
  t: Thresholds
): boolean {
  return (Object.keys(t) as Metric[]).some((m) => {
    const v = readings[m];
    return typeof v === "number" && toneFor(v, m, t) === "critical";
  });
}

/**
 * Validation shared by the settings form and anything else that writes.
 * Mirrors the CHECK constraints on the table — the database is the real
 * guarantee, this exists so the operator gets a message instead of a 400.
 *
 * Returns null when valid, otherwise the reason.
 */
export function validateBand(band: Band, label: string): string | null {
  const { warn, critical } = band;
  if (!Number.isFinite(warn) || !Number.isFinite(critical)) {
    return `${label}: both values must be numbers.`;
  }
  if (warn < 0 || warn > 100 || critical < 0 || critical > 100) {
    return `${label}: values must be between 0 and 100.`;
  }
  if (warn >= critical) {
    // Not a style preference: with warn >= critical the amber band is empty and
    // a meter would jump straight from green to red.
    return `${label}: warning (${warn}) must be below critical (${critical}).`;
  }
  return null;
}

export function validateThresholds(t: Thresholds): string | null {
  for (const m of Object.keys(t) as Metric[]) {
    const err = validateBand(t[m], METRIC_LABELS[m]);
    if (err) return err;
  }
  return null;
}
