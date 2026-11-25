// Writes the privacy gate's denylist: the names and addresses that are YOURS and
// must never be published. It is written outside the repository and its
// contents are never printed.
//
//   npm run privacy:denylist              -> ~/.config/fleet/privacy-denylist
//   npm run privacy:denylist -- --check   -> says how many terms it would write; writes nothing
//
// Where the terms come from:
//
//   1. the dashboard's database: every server's address, label (also as typed
//      without its separators) and GridPane number, and every site's GridPane
//      number and address (the whole name, and its own label: "shop.acme.example"
//      gives "shop.acme.example", "acme.example" and "acme")
//   2. this checkout's settings (.env.local, .dev.vars): the database project id,
//      the Cloudflare Access team and audience, the allowed user ids
//   3. your own list, ~/.config/fleet/privacy-extra: one term a line. Put there
//      what no database knows: your name, your business, your office address,
//      a client's name as you would write it in a comment.
//
//      It is also where the Cloudflare Access team and audience go once they are
//      out of .env.local. They belong on the deployed Worker, and a local run
//      with them in .env.local refuses every request, so the advice everywhere
//      is to take them out. Copy the two lines here as they are, and this list
//      keeps them:
//        CF_ACCESS_TEAM_DOMAIN=yourteam.cloudflareaccess.com
//        CF_ACCESS_AUD=the application's audience tag
//      (SSO_ALLOWED_USER_IDS= is read the same way.) When neither place has the
//      team or the audience, this says so: it never drops one without a word.
//
// The gate reads the result: scripts/privacy-gate.mjs.
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve, sep } from "node:path";

dotenv.config({ path: resolve(process.cwd(), ".env.local"), quiet: true });
dotenv.config({ path: resolve(process.cwd(), ".dev.vars"), quiet: true });
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local.");
  process.exit(1);
}
const config = resolve(process.env.XDG_CONFIG_HOME || resolve(homedir(), ".config"), "fleet");
const target = resolve(config, "privacy-denylist");
const extraFile = resolve(config, "privacy-extra");
const check = process.argv.includes("--check");

// Words too ordinary to be a private name on their own. A site called "blog.acme.example" should not ban the word "blog".
const ORDINARY = new Set(["www", "staging", "stage", "dev", "test", "demo", "shop", "store", "blog", "mail", "app", "api", "admin", "portal", "site", "sites", "web", "home", "main", "prod", "server", "servers", "cloud", "local", "fleet", "example", "default", "backup", "status", "news", "docs", "help", "support", "online", "group", "team", "media", "design", "studio", "digital", "global", "training"]);
const SUFFIX = /\.(com|org|net|dev|io|app|co|us|uk|ca|au|info|biz|me|ai|church|family|shop|store|site|online|tech|cloud|xyz)$/;
const found = new Map<string, string>(); // term -> where it came from
const add = (term: unknown, from: string) => {
  if (typeof term !== "string") return;
  const t = term.trim().toLowerCase();
  if (t.length >= 3 && !found.has(t)) found.set(t, from);
};
/** A site address gives the whole name, each parent name, and the labels that are a name of their own. */
const addHost = (raw: unknown, from: string) => {
  if (typeof raw !== "string") return;
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/:?#].*$/, "");
  if (!host.includes(".")) return add(host, from);
  const labels = host.split(".");
  for (let i = 0; i < labels.length - 1; i++) add(labels.slice(i).join("."), from);
  let bare = host;
  while (SUFFIX.test(bare)) bare = bare.replace(SUFFIX, "");
  for (const label of bare.split(".")) if (label.length >= 5 && !ORDINARY.has(label) && !/^\d+$/.test(label)) add(label, from);
};

type Row = Record<string, unknown>;
let rows: { servers: Row[]; sites: Row[] };
// For the self-test only (scripts/test-make-privacy-denylist.ts): the rows come from a file, not the database.
// Allowed only when the list is written under the system's temporary folder, so made-up rows can never replace a real list.
const testRows = process.env.FLEET_PRIVACY_TEST_ROWS;
if (testRows) {
  const temp = [resolve(tmpdir()), realpathSync(tmpdir())];
  if (!temp.some((t) => config.startsWith(t + sep))) {
    console.error("FLEET_PRIVACY_TEST_ROWS is for the self-test: it is refused unless the list is written under the temporary folder. Nothing was written.");
    process.exit(1);
  }
  const fixture = JSON.parse(readFileSync(testRows, "utf8"));
  rows = { servers: Array.isArray(fixture.servers) ? fixture.servers : [], sites: Array.isArray(fixture.sites) ? fixture.sites : [] };
  console.log("TEST ROWS: the servers and sites came from a file, not the database.");
} else {
  const supabase = createClient(url, key, { auth: { persistSession: false } });
  const servers = await supabase.from("servers").select("id,ip,label,subdomain");
  const sites = await supabase.from("sites").select("id,url,cloudflare_dns_name");
  if (servers.error || sites.error) {
    console.error(`Could not read the database: ${(servers.error || sites.error)?.message}. Nothing was written.`);
    process.exit(1);
  }
  rows = { servers: servers.data ?? [], sites: sites.data ?? [] };
}
/** GridPane's number for a server or a site: in a comment ("/server/12345") it names one as surely as its address does. */
const addId = (id: unknown, from: string) => { const t = String(id ?? ""); if (/^\d{4,}$/.test(t)) add(t, from); };
for (const s of rows.servers) {
  add(s.ip, "a server's address");
  if (typeof s.label === "string" && s.label.trim().length >= 4 && !ORDINARY.has(s.label.trim().toLowerCase())) {
    add(s.label, "a server's label");
    // The same label as people type it in a comment, without its spaces, hyphens or underscores.
    const squashed = s.label.replace(/[^A-Za-z0-9]/g, "");
    if (squashed.length >= 5 && !ORDINARY.has(squashed.toLowerCase())) add(squashed, "a server's label");
  }
  addId(s.id, "a server's GridPane id");
  addHost(s.subdomain, "a server's hostname");
}
for (const s of rows.sites) {
  addHost(s.url, "a site");
  addHost(s.cloudflare_dns_name, "a site");
  addId(s.id, "a site's GridPane id");
}
const fromDatabase = found.size;

try { add(new URL(url).hostname.split(".")[0], "the database project id"); } catch { /* a local address has none */ }
// Three settings are private terms themselves. They are read from this checkout's settings and, as the same
// lines, from your own list: the two Access ones are meant to be taken out of .env.local.
const SETTINGS = ["CF_ACCESS_TEAM_DOMAIN", "CF_ACCESS_AUD", "SSO_ALLOWED_USER_IDS"];
const SETTING_LINE = /^(CF_ACCESS_TEAM_DOMAIN|CF_ACCESS_AUD|SSO_ALLOWED_USER_IDS)\s*=\s*(.*)$/;
const given = new Set<string>(); // the settings that had a value somewhere
const addSetting = (name: string, raw: string | undefined) => {
  const value = (raw ?? "").trim().replace(/^(["'])(.*)\1$/, "$2").trim();
  if (!value) return;
  given.add(name);
  if (name === "CF_ACCESS_TEAM_DOMAIN") addHost(value, "the Cloudflare Access team");
  else if (name === "CF_ACCESS_AUD") add(value, "the Cloudflare Access audience");
  else for (const id of value.split(",")) add(id, "an allowed user id");
};
for (const name of SETTINGS) addSetting(name, process.env[name]);
const fromSettings = found.size - fromDatabase;

let fromExtra = 0;
if (existsSync(extraFile)) {
  for (const line of readFileSync(extraFile, "utf8").split("\n")) {
    const t = line.replace(/\s+#.*$/, "").trim();
    if (!t || t.startsWith("#")) continue;
    const before = found.size;
    const setting = SETTING_LINE.exec(t);
    if (setting) addSetting(setting[1], setting[2]);
    // A ~ in front means "match anywhere"; keep it as written.
    else if (t.startsWith("~")) { if (t.length >= 4 && !found.has(t.toLowerCase())) found.set(t.toLowerCase(), "your own list"); } else add(t, "your own list");
    fromExtra += found.size - before;
  }
}

const say = `${found.size} terms: ${fromDatabase} from ${rows.servers.length} servers and ${rows.sites.length} sites, ${fromSettings} from this checkout's settings, ${fromExtra} from ${existsSync(extraFile) ? extraFile : "your own list (none yet: " + extraFile + ")"}`;
if (found.size === 0) {
  console.error("Nothing to write: the database has no servers or sites, and there is no list of your own.");
  process.exit(1);
}
// The two Access values name this install as surely as a server's address does. Said every time one is missing:
// an install without Cloudflare Access can ignore it, and one with it must not lose them from the list unnoticed.
const absent = [["CF_ACCESS_TEAM_DOMAIN", "team address"], ["CF_ACCESS_AUD", "audience tag"]].filter(([name]) => !given.has(name));
const two = absent.length === 2;
const note = absent.length === 0 ? "" : `\nNote: this list has no Cloudflare Access ${absent.map(([, what]) => what).join(" and no ")}. ${two ? "Neither is" : "It is not"} in .env.local, .dev.vars or ${extraFile}, so the gate cannot keep ${two ? "them" : "it"} out of what you publish. If this app sits behind Cloudflare Access, add ${two ? "these lines" : "this line"} to ${extraFile} with ${two ? "their values" : "its value"}, then run this again:\n${absent.map(([name]) => `  ${name}=`).join("\n")}`;
if (check) {
  console.log(`Would write ${say}. Nothing was written.${note}`);
  process.exit(0);
}
mkdirSync(dirname(target), { recursive: true });
const body = ["# Written by `npm run privacy:denylist`. Never commit this file: it is a list of what must stay private.", "# Edit ~/.config/fleet/privacy-extra to add terms of your own, then run it again.", ...[...found.keys()].sort()].join("\n") + "\n";
writeFileSync(target, body, { mode: 0o600 });
chmodSync(target, 0o600);
console.log(`Wrote ${target}\n${say}${note}`);
