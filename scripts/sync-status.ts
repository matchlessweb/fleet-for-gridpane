// What the newest GridPane sync is doing, or how it ended: the same record the
// app's top bar reads (public.sync_runs). For a person or an agent watching a
// sync started in the app or with npm run sync. Reads only; changes nothing.
//
//   npm run sync:status                 one look
//   npm run sync:status -- --watch      a line whenever it moves, until the sync ends
//   npm run sync:status -- --json       the record as JSON (with --watch: one object a line)
//
// Exit code: 0 running or complete, 2 finished with sites not read, 1 failed,
// stopped or stopped reporting, 3 could not look.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { resolve } from "path";
import { describeSyncRun, isStale, latestSyncRun, type SyncDb, type SyncRun } from "../lib/sync-runs.ts";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), quiet: true });

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const args = new Set(process.argv.slice(2));
const watch = args.has("--watch");
const asJson = args.has("--json");
const EVERY_MS = 10_000;

if (!url || !key) {
  console.error("sync:status: .env.local needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (SETUP.md, step 2b).");
  process.exit(3);
}
const db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } }) as unknown as SyncDb;

function exitCodeFor(run: SyncRun | null, now: number): number {
  if (!run) return 0;
  if (run.status === "running") return isStale(run, now) ? 1 : 0;
  if (run.status === "complete") return 0;
  if (run.status === "partial") return 2;
  return 1;
}

function line(run: SyncRun | null, now: number): string {
  if (asJson) return JSON.stringify({ run, view: describeSyncRun(run, now) });
  const v = describeSyncRun(run, now);
  const pct = v.percent !== null && v.state === "running" ? ` (${v.percent}%)` : "";
  return `${new Date(now).toISOString().slice(11, 19)}  ${v.title}${pct}. ${v.detail}`;
}

async function look(): Promise<{ run: SyncRun | null; now: number } | null> {
  const { run, error } = await latestSyncRun(db);
  if (error) {
    const missing = /sync_runs/.test(error) && /(does not exist|schema cache|not find)/i.test(error);
    console.error(missing
      ? "sync:status: the database has no sync_runs table yet. Apply supabase/migrations/20261124000000_sync_runs.sql (SETUP.md, step 4)."
      : `sync:status: could not read the sync record: ${error}`);
    return null;
  }
  return { run, now: Date.now() };
}

const first = await look();
if (!first) process.exit(3);
console.log(line(first.run, first.now));

if (!watch || !first.run || first.run.status !== "running" || isStale(first.run, first.now)) {
  process.exit(exitCodeFor(first.run, first.now));
}

let last = JSON.stringify(first.run);
for (;;) {
  await new Promise((r) => setTimeout(r, EVERY_MS));
  const next = await look();
  if (!next) continue; // a failed read is not the end of the sync
  const changed = JSON.stringify(next.run) !== last;
  const stale = !!next.run && isStale(next.run, next.now);
  if (changed || stale) console.log(line(next.run, next.now));
  last = JSON.stringify(next.run);
  if (!next.run || next.run.id !== first.run.id || next.run.status !== "running" || stale) {
    // A newer record means the watched one ended and another began: report the watched one's end.
    process.exit(exitCodeFor(next.run, next.now));
  }
}
