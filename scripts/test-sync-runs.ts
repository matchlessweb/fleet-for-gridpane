/**
 * Checks for lib/sync-runs.ts.   npm run syncruns:test
 *
 *   (no option)  what screens say about a sync, and how a sync's record is started and ended
 *   --controls   break a copy of the helper one way at a time; each break must be caught
 *
 * SYNC_RUNS_LIB points the checks at another copy (the controls use it).
 * What this guards: two syncs running at once, a sync whose tab closed shown as running for
 * ever, a finished sync with sites not read reported as complete, and a stopped record revived.
 * The database is a stand-in that keeps rows in memory and enforces the one-running-row index.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = process.env.SYNC_RUNS_LIB || fileURLToPath(new URL("../lib/sync-runs.ts", import.meta.url));

const swap = (from: string, to: string) => (s: string) => {
  if (!s.includes(from)) throw new Error(`a control found nothing to change: ${from.slice(0, 60)}`);
  return s.replace(from, to);
};
const BREAKS: [string, (s: string) => string][] = [
  ["a silent sync is never seen as stopped", swap("return !Number.isFinite(beat) || now - beat > SYNC_STALE_AFTER_MS;", "return false;")],
  ["a finished sync with sites not read is called complete", swap("return c.errors === 0 && c.sitesRead >= c.sitesTotal ? \"complete\" : \"partial\";", "return c.errors === 0 ? \"complete\" : \"partial\";")],
  ["a silent sync is not closed before the next starts", swap('.eq("status", "running")\n    .lt("heartbeat_at", cutoff);', '.eq("status", "never")\n    .lt("heartbeat_at", cutoff);')],
  ["a busy start is reported as an error, not as the sync that holds it", swap('if (made.error?.code === "23505") {', 'if (made.error?.code === "never") {')],
  ["progress revives a record already closed", swap('    .update({ ...progress, heartbeat_at: new Date(now).toISOString() })\n    .eq("id", id)\n    .eq("status", "running");', '    .update({ ...progress, heartbeat_at: new Date(now).toISOString() })\n    .eq("id", id);')],
  ["closing overwrites a record another sync already closed", swap('    .update({ ...progress, status, phase: "done", heartbeat_at: iso, finished_at: iso })\n    .eq("id", id)\n    .eq("status", "running");', '    .update({ ...progress, status, phase: "done", heartbeat_at: iso, finished_at: iso })\n    .eq("id", id);')],
  ["a running app sync does not say to keep its tab open", swap('run.source === "app" ? " It runs in the tab that started it: keep that tab open." : ""', '""')],
  ["the progress percent ignores the site count", swap("Math.round((run.sites_done / total) * 100)", "Math.round(run.sites_done)")],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "sync-runs-controls-"));
  let caught = 0;
  try {
    for (const [name, edit] of BREAKS) {
      const copy = join(dir, "sync-runs.ts");
      writeFileSync(copy, edit(readFileSync(LIB, "utf8")));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env: { ...process.env, SYNC_RUNS_LIB: copy }, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch, and neither is one that failed everything.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} of ${m[1]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  console.log(`controls: ${caught} caught, ${BREAKS.length - caught} missed, of ${BREAKS.length}`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const lib = await import(pathToFileURL(LIB).href);

let ran = 0;
let failed = 0;
function ok(name: string, got: unknown, want: unknown) {
  ran++;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failed++;
  console.log(`  ${pass ? "ok  " : "FAIL"}  ${name}${pass ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
}

// ── A stand-in for the table, with the unique index that admits one running row ──
type Row = Record<string, unknown>;
function standIn() {
  const rows: Row[] = [];
  let n = 0;
  const query = (op: "select" | "insert" | "update", payload?: Row) => {
    const filters: ((r: Row) => boolean)[] = [];
    let order: { col: string; asc: boolean } | null = null;
    let lim = Infinity;
    let returning = op === "select";
    let one: "single" | "maybe" | null = null;
    const run = () => {
      if (op === "insert") {
        const row = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, status: "running", phase: "starting", sites_total: null, sites_done: 0, sites_read: 0, schedules: 0, errors: 0, servers_saved: null, message: null, finished_at: null, ...payload };
        if (row.status === "running" && rows.some((r) => r.status === "running")) {
          return { data: null, error: { message: "duplicate key value violates unique constraint \"sync_runs_one_running\"", code: "23505" } };
        }
        rows.push(row);
        return { data: one ? row : [row], error: null };
      }
      let hit = rows.filter((r) => filters.every((f) => f(r)));
      if (op === "update") {
        for (const r of hit) Object.assign(r, payload);
        return { data: returning ? hit : null, error: null };
      }
      if (order) { const { col, asc } = order; hit = [...hit].sort((a, b) => (String(a[col]) < String(b[col]) ? -1 : 1) * (asc ? 1 : -1)); }
      hit = hit.slice(0, lim);
      if (one) return { data: hit[0] ?? null, error: null };
      return { data: hit, error: null };
    };
    const q = {
      eq(c: string, v: unknown) { filters.push((r) => r[c] === v); return q; },
      lt(c: string, v: unknown) { filters.push((r) => String(r[c]) < String(v)); return q; },
      order(c: string, o: { ascending: boolean }) { order = { col: c, asc: o.ascending }; return q; },
      limit(k: number) { lim = k; return q; },
      select() { returning = true; return q; },
      single() { one = "single"; return Promise.resolve(run()); },
      maybeSingle() { one = "maybe"; return Promise.resolve(run()); },
      then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return q;
  };
  const db = { from: () => ({ select: () => query("select"), insert: (r: Row) => query("insert", r), update: (r: Row) => query("update", r) }) };
  return { db, rows };
}

const T0 = Date.parse("2026-11-24T12:00:00Z");
const MIN = 60_000;

// Starting, one at a time.
{
  const { db, rows } = standIn();
  const a = await lib.openSyncRun(db, { source: "app", now: T0 });
  ok("the first sync starts a record", a.ok && a.run.status, "running");
  const b = await lib.openSyncRun(db, { source: "cli", now: T0 + MIN });
  ok("a second sync while the first reports is refused", b.ok, false);
  ok("and is told which sync holds it", b.busy?.id, a.run.id);
  ok("and no second record is made", rows.length, 1);

  await lib.touchSyncRun(db, a.run.id, { phase: "details", sites_total: 100, sites_done: 30 }, T0 + 4 * MIN);
  ok("progress moves the heartbeat", rows[0].heartbeat_at, new Date(T0 + 4 * MIN).toISOString());
  const c = await lib.openSyncRun(db, { source: "cli", now: T0 + 9 * MIN });
  ok("five minutes after its last report it still holds the lock", c.ok, false);

  const d = await lib.openSyncRun(db, { source: "cli", now: T0 + 11 * MIN });
  ok("seven minutes silent: the next sync starts", d.ok, true);
  ok("and the silent one is closed as stopped", rows[0].status, "stopped");

  await lib.touchSyncRun(db, a.run.id, { sites_done: 31 }, T0 + 12 * MIN);
  ok("a late report from the stopped sync does not revive it", [rows[0].status, rows[0].sites_done], ["stopped", 30]);

  if (d.ok) await lib.closeSyncRun(db, d.run.id, "complete", { sites_read: 100 }, T0 + 30 * MIN);
  ok("closing ends the record", [rows[1]?.status, rows[1]?.phase, rows[1]?.finished_at], ["complete", "done", new Date(T0 + 30 * MIN).toISOString()]);
  await lib.closeSyncRun(db, a.run.id, "failed", { message: "late" }, T0 + 31 * MIN);
  ok("a record already closed is not closed again", rows[0].status, "stopped");

  const latest = await lib.latestSyncRun(db);
  ok("the newest record is the one read", latest.run?.id, d.run?.id ?? "the second sync never started");
}

// How a sync that reached the end is recorded.
ok("every site read, no error: complete", lib.finishedStatus({ sitesTotal: 101, sitesRead: 101, errors: 0 }), "complete");
ok("two sites refused: partial", lib.finishedStatus({ sitesTotal: 101, sitesRead: 99, errors: 0 }), "partial");
ok("every site read but an error: partial", lib.finishedStatus({ sitesTotal: 101, sitesRead: 101, errors: 1 }), "partial");

// What screens say.
const base = { id: "x", source: "app", status: "running", phase: "details", started_by: null, started_at: new Date(T0).toISOString(), heartbeat_at: new Date(T0 + 2 * MIN).toISOString(), finished_at: null, servers_saved: 18, sites_total: 101, sites_done: 34, sites_read: 33, schedules: 90, errors: 0, message: null };
const now = T0 + 3 * MIN;
ok("no record: nothing synced yet", lib.describeSyncRun(null, now).state, "none");
const running = lib.describeSyncRun(base, now);
ok("running: the count", running.title, "Syncing: 34 of 101 sites");
ok("running: the percent", running.percent, 34);
ok("the percent is of the site count", lib.describeSyncRun({ ...base, sites_total: 200, sites_done: 50 }, now).percent, 25);
ok("running in the app: keep the tab open", /keep that tab open/.test(running.detail), true);
ok("running from the command line: no tab to keep open", /tab/.test(lib.describeSyncRun({ ...base, source: "cli" }, now).detail), false);
ok("running: the time left at GridPane's pace", /About 12 minutes left/.test(running.detail), true);
ok("reading servers: says so", lib.describeSyncRun({ ...base, phase: "servers", sites_total: null }, now).title, "Syncing: reading your servers");
ok("silent for seven minutes: stopped reporting", lib.describeSyncRun(base, T0 + 9 * MIN).state, "stalled");
ok("and says what it saved stays saved", /stays saved/.test(lib.describeSyncRun(base, T0 + 9 * MIN).detail), true);
const partial = lib.describeSyncRun({ ...base, status: "partial", sites_done: 101, sites_read: 99, finished_at: new Date(now).toISOString() }, now);
ok("partial: names the sites not read", /2 not read/.test(partial.detail), true);
ok("complete: says all were read", lib.describeSyncRun({ ...base, status: "complete", sites_done: 101, sites_read: 101, finished_at: new Date(now).toISOString() }, now).detail, "Finished just now: 101 of 101 sites read, 18 servers.");
ok("failed: carries the reason", /GridPane refused/.test(lib.describeSyncRun({ ...base, status: "failed", message: "GridPane refused the site list." }, now).detail), true);

// Words.
ok("just now", lib.ago(new Date(T0).toISOString(), T0 + 20_000), "just now");
ok("minutes", lib.ago(new Date(T0).toISOString(), T0 + 4 * MIN), "4 min ago");
ok("hours", lib.ago(new Date(T0).toISOString(), T0 + 120 * MIN), "2 h ago");
ok("no time", lib.ago(null, T0), "at an unknown time");
ok("101 sites take about 19 minutes", lib.syncDuration(101), "about 19 minutes");
ok("5 sites take about a minute", lib.syncDuration(5), "about a minute");
ok("1000 sites are counted in hours", lib.syncDuration(1000), "about 3.1 hours");

console.log(`sync runs: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
