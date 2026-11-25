import type { createClient } from "@/lib/supabase/client";
import type { Database } from "@/lib/database.types";

/**
 * Action logs: one place for what an entry is called, what kind it is and what
 * "read" means for it.
 *
 * The table has one flag, `is_read`. For an ordinary entry it means read. For a
 * problem (an error or a warning) it means resolved, and only an explicit
 * "Mark resolved" sets it: opening a failure to look at it must not hide it.
 */
export type SystemLog = Database["public"]["Tables"]["system_logs"]["Row"];

export const isProblem = (log: SystemLog) => log.level === "error" || log.level === "warning";
/** A problem nobody has marked resolved. */
export const isOpenProblem = (log: SystemLog) => isProblem(log) && !log.is_read;
/** An ordinary entry nobody has read. */
export const isUnread = (log: SystemLog) => !isProblem(log) && !log.is_read;
/** Still asking for attention, either way. */
export const needsAttention = (log: SystemLog) => !log.is_read;

const PREFIX = /^\[(.*?)\]\s*/;

/** The bracketed prefix, or the opening clause, or a plain fallback. Never a guess at what happened. */
export function logTitle(log: SystemLog): string {
  const tagged = log.message.match(PREFIX)?.[1]?.trim();
  if (tagged) return tagged;
  const clause = log.message.split(/[:.\n]/, 1)[0]?.trim() ?? "";
  if (clause && clause.length <= 60) return clause;
  return isProblem(log) ? "System error" : "System event";
}

/** The text after the prefix. Site-change entries were stored with a literal "\\n" between changes; shown as line breaks. */
export const logBody = (log: SystemLog) => log.message.replace(PREFIX, "").replace(/\\n/g, "\n");

export type LogKind = "sync" | "site" | "backup" | "upkeep" | "other";

export const KIND_LABELS: Record<LogKind, string> = {
  sync: "Syncs",
  site: "Site changes",
  backup: "Backups",
  upkeep: "Upkeep",
  other: "Other",
};

/** Kinds are read from what the app writes today. An entry it does not recognize is "other", never forced into a kind. */
export function logKind(log: SystemLog): LogKind {
  const title = logTitle(log);
  const target = log.site_url ?? "";
  if (/backup synchroni[sz]ation/i.test(title) || target === "Edge Sync Controller") return "sync";
  if (/^(php |edge override|configuration failed)/i.test(title)) return "site";
  if (target === "Dashboard Auto-Resolver" || /backup schedule/i.test(log.message)) return "backup";
  if (/^telemetry prune/i.test(title) || target === "Telemetry Retention") return "upkeep";
  return "other";
}

export type DayGroup = "Today" | "Yesterday" | "Earlier";

export function dayGroup(iso: string, now: Date): DayGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const t = new Date(iso).getTime();
  if (t >= startOfToday) return "Today";
  if (t >= startOfToday - 86_400_000) return "Yesterday";
  return "Earlier";
}

/** Time for today's entries, date and time for older ones. */
export function logStamp(iso: string, group: DayGroup): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (group !== "Earlier") return time;
  return `${d.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${time}`;
}

type Client = ReturnType<typeof createClient>;

/**
 * What "Clear" would do, counted in the database: the loaded list stops at 100
 * entries and the question has to state the real numbers.
 */
export async function countClearable(supabase: Client): Promise<{ clearable: number; staying: number }> {
  const [done, open] = await Promise.all([
    supabase.from("system_logs").select("id", { count: "exact", head: true }).eq("is_read", true),
    supabase.from("system_logs").select("id", { count: "exact", head: true }).eq("is_read", false),
  ]);
  if (done.error) throw new Error(done.error.message);
  if (open.error) throw new Error(open.error.message);
  return { clearable: done.count ?? 0, staying: open.count ?? 0 };
}

/** Deletes read and resolved entries. Open problems and unread entries are never touched. */
export async function clearDoneLogs(supabase: Client): Promise<void> {
  const { error } = await supabase.from("system_logs").delete().eq("is_read", true);
  if (error) throw new Error(error.message);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The two sentences of the clear question, from real counts. */
export function clearQuestion(clearable: number, staying: number): { title: string; body: string; confirm: string } {
  return {
    title: `Delete ${plural(clearable, "log entry", "log entries")}?`,
    body:
      `This removes every read or resolved entry, for everyone who uses Fleet. ` +
      (staying > 0
        ? `${plural(staying, "entry", "entries")} still unread or unresolved ${staying === 1 ? "stays" : "stay"}. `
        : "") +
      `It can’t be undone.`,
    confirm: `Delete ${plural(clearable, "entry", "entries")}`,
  };
}
