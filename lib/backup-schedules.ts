/**
 * Backup schedule overlap detection and staggered resolution.
 *
 * Extracted from `app/(dashboard)/backups/schedules/page.tsx`.
 * The arithmetic here reschedules production backups on every server and had no
 * tests while it lived inline in a large component. The rules are
 * unchanged apart from the weekly day-rollover fix documented on
 * `generatePlan`.
 *
 * Pure on purpose — no imports, no Supabase, no React. Every consumer passes
 * plain rows in, so the rules can be tested with fixtures.
 */

/** The columns these rules actually read. Structural, so both the Supabase row
 *  type and hand-built test fixtures satisfy it. */
export type ScheduleLike = {
  id: number;
  site_id?: number | null;
  type?: string | null;
  bup_schedule?: string | null;
  hour?: string | null;
  minute?: string | null;
  day?: string | null;
};

/**
 * A schedule's hour, minute or day as GridPane sent it, as the text the database
 * keeps. Only a missing value is null. Zero is a real time (midnight, the top of
 * the hour, Sunday), so it is never tested for truth: a `value ? … : null` test
 * would store a numeric 0 as "no time", and a schedule with no minute is left
 * out of the overlap check.
 */
export function scheduleField(value: unknown): string | null {
  if (value === null || value === undefined || value === "") return null;
  return String(value);
}

/** A schedule paired with the server it runs on — resolved by the caller,
 *  since the join lives in the page's `sites` map. */
export type PlacedSchedule = ScheduleLike & { server_id: number | string | null | undefined };

export type PlanEntry = {
  id: number;
  hour: string | null;
  minute: string;
  /** Carried explicitly because a midnight wrap can move a WEEKLY backup to the
   *  next day. Previously the caller sent the original day, silently landing the
   *  backup ~24h earlier than intended. */
  day: string | null;
};

/**
 * The single definition of "these two backups run at the same moment".
 *
 * Keyed on server rather than destination: two backups on one box contend for
 * that box's disk and CPU regardless of where the bytes end up. Note this
 * deliberately does NOT include `service_id`: changing it is a separate
 * decision about what "overlap" should mean.
 */
export function scheduleKey(
  serverId: number | string | null | undefined,
  type: string | null | undefined,
  bupSchedule: string | null | undefined,
  hour: string | null | undefined,
  minute: string | null | undefined,
  day: string | null | undefined
): string {
  return `${serverId}-${type}-${bupSchedule}-${hour}-${minute}-${day || "n"}`;
}

/** Key for a row as it stands today. */
export function keyForSchedule(s: PlacedSchedule): string {
  return scheduleKey(s.server_id, s.type, s.bup_schedule, s.hour, s.minute, s.day);
}

export type OverlapReport = {
  /** key -> the schedules sharing that slot (only groups of 2+). */
  groups: Map<string, PlacedSchedule[]>;
  /** How many schedules sit in a contended slot. 19, for the current fleet. */
  schedulesInvolved: number;
  /** How many distinct slots are contended. 7, for the current fleet. */
  collisionCount: number;
};

/**
 * Find every contended slot.
 *
 * Both counts are returned because they are different numbers: a collision is
 * one contended slot, and several schedules can share it, so "19 overlaps"
 * could be 19 schedules across 7 collisions.
 *
 * Rows without a resolvable server, or without a minute, are skipped — they
 * cannot be placed on a timeline, so they cannot be proven to overlap.
 */
export function detectOverlaps(rows: PlacedSchedule[]): OverlapReport {
  const buckets = new Map<string, PlacedSchedule[]>();

  for (const s of rows) {
    if (!s.server_id || s.minute === null || s.minute === undefined) continue;
    const key = keyForSchedule(s);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(s);
    else buckets.set(key, [s]);
  }

  const groups = new Map<string, PlacedSchedule[]>();
  let schedulesInvolved = 0;
  for (const [key, members] of buckets) {
    if (members.length > 1) {
      groups.set(key, members);
      schedulesInvolved += members.length;
    }
  }

  return { groups, schedulesInvolved, collisionCount: groups.size };
}

/** Weekly is the only frequency where `day` selects when the backup runs;
 *  daily and hourly ignore it, so a midnight wrap must not touch it. */
function dayIsMeaningful(bupSchedule: string | null | undefined): boolean {
  return bupSchedule === "weekly";
}

/**
 * Stagger a contended group.
 *
 * The first node keeps its slot (offset 0) and each subsequent node moves by
 * `i × interval` minutes — the behaviour the operator expects: one stays put,
 * the rest shift.
 *
 * MIDNIGHT: minutes past 60 roll the hour, and the hour rolls with `% 24`. When
 * the hour wraps past midnight the calendar day advances too — and for a WEEKLY
 * schedule that must be reflected in `day`, or the backup lands on the previous
 * week's slot, ~24 hours earlier than intended. The old code wrapped the hour
 * and kept the day, so a weekly backup at 23:50 shifted +15m silently became
 * 00:05 on the SAME day. Daily and hourly carry no meaningful day and are left
 * alone.
 *
 * An `interval` of 0 returns every node unchanged, which is a no-op the
 * conflict check will correctly reject (the group is still contended).
 */
export function generatePlan(interval: number, nodes: ScheduleLike[]): PlanEntry[] {
  return nodes.map((s, i) => {
    const startMin = parseInt(s.minute || "0", 10) || 0;
    const startHour = parseInt(s.hour || "0", 10) || 0;

    let minute = startMin + i * interval;
    let hour = startHour;
    let daysCarried = 0;

    if (minute >= 60) {
      hour += Math.floor(minute / 60);
      minute = minute % 60;
    }
    if (hour >= 24) {
      daysCarried = Math.floor(hour / 24);
      hour = hour % 24;
    }

    let day = s.day ?? null;
    if (daysCarried > 0 && dayIsMeaningful(s.bup_schedule) && day !== null) {
      const parsed = parseInt(day, 10);
      if (Number.isFinite(parsed)) day = ((parsed + daysCarried) % 7).toString();
    }

    return {
      id: s.id,
      // Hourly schedules carry a null hour and must keep it: the backup runs
      // every hour at :minute, and sending an hour would pin it to one.
      hour: s.hour === null || s.hour === undefined ? null : hour.toString().padStart(2, "0"),
      minute: minute.toString().padStart(2, "0"),
      day,
    };
  });
}

/**
 * Would applying this plan land any backup on top of another?
 *
 * Builds the timeline as it WOULD look — planned positions for the moved nodes,
 * current positions for everything else on that server — and reports the first
 * slot holding two or more. This is what stops a stagger from solving one
 * collision by creating another.
 *
 * Returns the offending key so a caller can name the pair; null when clear.
 */
export function findPlanConflict(
  plan: PlanEntry[],
  allOnServer: PlacedSchedule[]
): string | null {
  const planById = new Map<number, PlanEntry>();
  for (const p of plan) planById.set(p.id, p);

  const future = new Map<string, number>();

  for (const s of allOnServer) {
    const moved = planById.get(s.id);
    const hour = moved ? moved.hour : s.hour;
    const minute = moved ? moved.minute : s.minute;
    const day = moved ? moved.day : s.day;

    if (minute === null || minute === undefined) continue;

    const key = scheduleKey(s.server_id, s.type, s.bup_schedule, hour, minute, day);
    future.set(key, (future.get(key) || 0) + 1);
  }

  for (const p of plan) {
    const original = allOnServer.find((s) => s.id === p.id);
    if (!original) continue;
    const key = scheduleKey(
      original.server_id,
      original.type,
      original.bup_schedule,
      p.hour,
      p.minute,
      p.day
    );
    if ((future.get(key) || 0) > 1) return key;
  }

  return null;
}
