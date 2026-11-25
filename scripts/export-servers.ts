// Writes the fleet scripts' server list from the dashboard's database.
//
//   npm run servers:export             -> scripts/servers.local (this checkout)
//   npm run servers:export -- --home   -> ~/.config/fleet/servers (every checkout on this machine)
//   npm run servers:export -- --print  -> prints the list, writes nothing
//
// The format and the search order are described in scripts/lib-fleet-servers.sh.
// The golden mark is kept: whichever server the existing file marks stays marked,
// as long as that server is still in the database. A new file has no golden
// server until you add "|golden" to one line.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}

const LINE = /^[0-9a-fA-F.:]+\|[0-9]+\|[A-Za-z0-9_.-]+$/;
const print = process.argv.includes("--print");
const target = process.argv.includes("--home")
  ? resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "fleet/servers")
  : resolve(process.cwd(), "scripts/servers.local");

const { data, error } = await createClient(url, key).from("servers").select("id, ip, label").order("label");
if (error) {
  console.error(`Could not read the servers table: ${error.message}`);
  console.error("Check NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY in .env.local (npm run doctor says which is wrong), and that the migrations have run.");
  process.exit(1);
}
if (!data || data.length === 0) {
  console.error("The servers table is empty. Run `npm run sync` first, so the dashboard knows your servers.");
  process.exit(1);
}

const before = existsSync(target) ? readFileSync(target, "utf8").split("\n").filter((l) => /^[0-9a-fA-F]/.test(l)) : [];
const goldenBefore = before.find((l) => l.endsWith("|golden"))?.split("|")[2] ?? "";

const lines: string[] = [];
const skipped: string[] = [];
for (const s of data) {
  const line = `${s.ip}|${s.id}|${s.label}`;
  if (LINE.test(line)) lines.push(s.label === goldenBefore ? `${line}|golden` : line);
  else skipped.push(String(s.label ?? s.id));
}
if (skipped.length) {
  // A label the scripts cannot read must not vanish quietly from the list.
  console.error(`These servers have an address or a label the fleet scripts cannot read (letters, digits, . _ - only): ${skipped.join(", ")}`);
  process.exit(1);
}

const body = [
  "# The fleet's server list: <ip>|<GridPane server id>|<label>, plus |golden on one line.",
  "# Written by `npm run servers:export`. See scripts/lib-fleet-servers.sh.",
  ...lines,
  "",
].join("\n");

if (print) {
  process.stdout.write(body);
  process.exit(0);
}

const plain = (l: string) => l.replace(/\|golden$/, "");
const was = new Set(before.map(plain));
const now = new Set(lines.map(plain));
const added = [...now].filter((l) => !was.has(l)).map((l) => l.split("|")[2]);
const gone = [...was].filter((l) => !now.has(l)).map((l) => l.split("|")[2]);

mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, body, { mode: 0o600 });
console.log(`Wrote ${lines.length} servers to ${target}`);
if (before.length) console.log(`  new or changed: ${added.length ? added.join(", ") : "none"}; no longer listed: ${gone.length ? gone.join(", ") : "none"}`);
const golden = lines.find((l) => l.endsWith("|golden"));
if (golden) console.log(`  golden server: ${golden.split("|")[2]}`);
else if (goldenBefore) console.log(`  WARNING: the golden server was ${goldenBefore}, which is no longer in the database. Add |golden to another line.`);
else console.log("  No golden server yet: add |golden to the line of the server the install scripts should copy from.");
