#!/usr/bin/env node
// The privacy gate: does this tree hold anything that must not be published?
//
//   node scripts/privacy-gate.mjs                          # this checkout's tracked files
//   node scripts/privacy-gate.mjs --tree ../fleet-public   # an exported folder
//   node scripts/privacy-gate.mjs --generic-only           # the built-in checks alone (what CI can run)
//   node scripts/privacy-gate.mjs --json findings.json     # also write the findings to a file
//
// Two kinds of check.
//
//   1. YOUR OWN TERMS, from a denylist kept OUTSIDE the repository: server
//      addresses and labels, client domains, your project ids, names. One term a
//      line; # starts a comment. It is read from --denylist <file>, else
//      $FLEET_PRIVACY_DENYLIST, else ~/.config/fleet/privacy-denylist. Make it
//      with `npm run privacy:denylist`. A term matches whole, in any case: "ops1"
//      does not match "ops12". Start a line with ~ to match it anywhere.
//
//   2. BUILT-IN CHECKS that need no list: a public IP address outside the
//      ranges kept for documentation, a hostname or email address that is not
//      on scripts/privacy-allowlist.txt, a database project address, a real-
//      looking id or key (long hex, a random UUID, a token).
//
// A deliberate public mention of your own name (a copyright line, say) is
// allowed one exact text in one named file: a line in the allowlist written
//   in LICENSE: Copyright (c) 2026 Example Studio, LLC
// permits that text there and nowhere else. Anything else on the line, and the
// same words in any other file, are still findings.
//
// Exit 0: nothing found.  1: findings.  2: wrong usage.  3: it could not look
// (no files, or no denylist and --generic-only was not given). "Could not look"
// is never a pass.
//
// The last line is always `privacy_gate=clean|findings|blind`, and the line
// before it says how many files, lines and terms were looked at.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i === -1 ? null : (args[i + 1] ?? ""); };
const KNOWN = new Set(["--tree", "--denylist", "--allowlist", "--json", "--generic-only", "--quiet"]);
const TAKES_VALUE = new Set(["--tree", "--denylist", "--allowlist", "--json"]);
const end = (state, code) => { console.log(`privacy_gate=${state}`); process.exit(code); };
for (let i = 0; i < args.length; i++) {
  if (!KNOWN.has(args[i])) { console.error(`Unknown option: ${args[i]}`); end("blind", 2); }
  if (TAKES_VALUE.has(args[i])) { if (!args[i + 1] || args[i + 1].startsWith("--")) { console.error(`${args[i]} needs a value`); end("blind", 2); } i++; }
}
const genericOnly = args.includes("--generic-only");
const quiet = args.includes("--quiet");
const here = resolve(new URL(".", import.meta.url).pathname);
const tree = resolve(opt("--tree") || process.cwd());
const allowFile = opt("--allowlist") || join(here, "privacy-allowlist.txt");
const denyFile = opt("--denylist") || process.env.FLEET_PRIVACY_DENYLIST || join(process.env.XDG_CONFIG_HOME || join(homedir(), ".config"), "fleet/privacy-denylist");

/* ── which files ─────────────────────────────────────────────────────────── */
const SKIP_DIRS = new Set([".git", "node_modules", ".next", ".open-next", ".wrangler", "coverage"]);
const BINARY = /\.(png|jpe?g|gif|webp|avif|ico|icns|woff2?|ttf|otf|eot|pdf|zip|gz|tgz|mp4|mov|webm)$/i;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) walk(p, out); else if (s.isFile()) out.push(relative(tree, p));
  }
  return out;
}
let files;
if (!existsSync(tree) || !statSync(tree).isDirectory()) { console.error(`No such folder: ${tree}`); end("blind", 3); }
try {
  // In a checkout, look at what is tracked: that is what an export copies.
  if (!existsSync(join(tree, ".git"))) throw new Error("not a checkout");
  files = execFileSync("git", ["-C", tree, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0").filter(Boolean);
} catch { files = walk(tree); }
files = files.filter((f) => existsSync(join(tree, f)));

/* ── the lists ───────────────────────────────────────────────────────────── */
const readList = (file) => readFileSync(file, "utf8").split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).filter((l) => l && !l.startsWith("#"));
const allowLines = existsSync(allowFile) ? readList(allowFile) : [];
const IN_FILE = /^in ([^:]+): (.+)$/;
// path -> the exact texts permitted in that file
const allowedText = new Map();
for (const l of allowLines) { const m = l.match(IN_FILE); if (m) allowedText.set(m[1].trim(), [...(allowedText.get(m[1].trim()) || []), m[2].trim()]); }
const allowFileRel = relative(tree, resolve(allowFile));
const allow = allowLines.filter((l) => !IN_FILE.test(l)).map((l) => l.toLowerCase());
// "host" allows the host and its subdomains; "=host" allows that one name only.
const allowHosts = allow.filter((a) => !a.startsWith("=") && !a.includes("/") && !a.includes("@") && !/^[0-9a-f:.]+$/.test(a));
const allowOnly = new Set(allow.filter((a) => a.startsWith("=")).map((a) => a.slice(1)));
const allowExact = new Set(allow);
const allowCidrs = allow.filter((a) => /^\d+\.\d+\.\d+\.\d+\/\d+$/.test(a));
let terms = [];
if (!genericOnly) {
  if (!existsSync(denyFile)) {
    console.error(`No denylist at ${denyFile}.\nMake one with: npm run privacy:denylist   (or pass --generic-only to run the built-in checks alone)`);
    end("blind", 3);
  }
  terms = [...new Set(readList(denyFile).map((t) => t.toLowerCase()))].filter((t) => t.replace(/^~/, "").length >= 3);
  if (terms.length === 0) { console.error(`The denylist at ${denyFile} holds no usable terms (three characters or more).`); end("blind", 3); }
}
const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anywhere = terms.filter((t) => t.startsWith("~")).map((t) => t.slice(1));
const whole = terms.filter((t) => !t.startsWith("~"));
// One pass per kind keeps a 300-term list fast: an alternation, longest first.
const byLength = (a, b) => b.length - a.length;
const wholeRe = whole.length ? new RegExp(`(?<![a-z0-9])(?:${whole.sort(byLength).map(escape).join("|")})(?![a-z0-9])`, "gi") : null;
const anyRe = anywhere.length ? new RegExp(anywhere.sort(byLength).map(escape).join("|"), "gi") : null;

/* ── the built-in checks ─────────────────────────────────────────────────── */
const ip4 = (s) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
const inCidr = (addr, cidr) => { const [base, bits] = cidr.split("/"); const size = 2 ** (32 - Number(bits)); const b = Math.floor(ip4(base) / size) * size; const a = ip4(addr); return a >= b && a < b + size; };
// Private, loopback, link-local, carrier NAT, multicast and the three documentation ranges (RFC 5737).
const SAFE4 = ["0.0.0.0/8", "10.0.0.0/8", "100.64.0.0/10", "127.0.0.0/8", "169.254.0.0/16", "172.16.0.0/12", "192.0.2.0/24", "192.168.0.0/16", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/3"];
const safe4 = (a) => SAFE4.some((c) => inCidr(a, c)) || allowExact.has(a) || allowCidrs.some((c) => inCidr(a, c));
// Loopback, unspecified, link-local, unique-local, and the documentation range 2001:db8::/32.
const safe6 = (a) => { const l = a.toLowerCase(); return l === "::" || l === "::1" || /^fe[89ab][0-9a-f]:/.test(l) || /^f[cd][0-9a-f]{2}:/.test(l) || /^2001:0?db8(:|$)/.test(l) || allowExact.has(l); };
const looksIp6 = (s) => { if (!/^[0-9a-f:]+$/i.test(s) || (s.match(/::/g) || []).length > 1) return false; const groups = s.split(":").filter(Boolean); if (groups.some((g) => g.length > 4)) return false; return s.includes("::") ? groups.length >= 2 && groups.length <= 7 : groups.length === 8; };
// Top-level domains worth checking. Ones that double as code (row.site, public.app, font.family, console.info) are
// left out on purpose: your own names on those are caught by the denylist, which is made from your site list.
const TLD = "com|org|net|dev|io|co|uk|ca|au|de|fr|eu|ai|xyz|church|biz";
const hostRe = new RegExp(`(?<![a-z0-9._%+@-])(?<!(?<!\\/)\\/)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+(?:${TLD})(?![a-z0-9-]|\\.[a-z0-9])`, "gi");
const emailRe = /[a-z0-9._%+-]+@(?:[a-z0-9-]+\.)+[a-z]{2,}/gi;
const SAFE_DOMAIN = /(^|\.)(example\.(com|org|net)|example|test|invalid|localhost)$/;
const hostAllowed = (h) => SAFE_DOMAIN.test(h) || allowOnly.has(h) || allowHosts.some((a) => h === a || h.endsWith("." + a));
// Third-party metadata: registry addresses, authors and checksums that are not ours to change.
const LOCKFILE = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/;
const distinct = (s) => new Set(s.toLowerCase().replace(/[^0-9a-f]/g, "")).size;
const CHECKS = [
  { kind: "ip-address", re: /(?<![0-9.])(?:\d{1,3}\.){3}\d{1,3}(?![0-9]|\.[0-9])/g, bad: (m) => m.split(".").every((o) => Number(o) <= 255) && !safe4(m) },
  // Not after a letter or "_": a 7G log joins its rule names with a double colon (bad_querystring_10, then bad_request_15), and that is not an address.
  { kind: "ip-address", re: /(?<![0-9a-z_:.])(?:[0-9a-f]{0,4}:){2,7}[0-9a-f]{0,4}(?![0-9a-f:])/gi, bad: (m) => looksIp6(m) && !safe6(m) },
  { kind: "project-address", re: /[a-z]{20}\.supabase\.(?:co|in)/g, bad: () => true },
  { kind: "email-address", re: emailRe, skip: LOCKFILE, bad: (m) => { const l = m.toLowerCase(); return !hostAllowed(l.slice(l.lastIndexOf("@") + 1)) && !allowExact.has(l); } },
  { kind: "hostname", re: hostRe, skip: LOCKFILE, bad: (m) => !hostAllowed(m.toLowerCase()) && !/^[a-z]{20}\.supabase\.(?:co|in)$/i.test(m) /* reported once, as a project address */ },
  // A real id or key is long and varied; a made-up one in a test repeats a few characters.
  { kind: "long-hex", re: /(?<![0-9a-f])[0-9a-f]{32,}(?![0-9a-f])/gi, bad: (m) => distinct(m) > 6 && !allowExact.has(m.toLowerCase()), skip: LOCKFILE },
  { kind: "uuid", re: /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/gi, bad: (m) => distinct(m) > 8 && !allowExact.has(m.toLowerCase()) },
  // An SSH key's fingerprint or public half names one person's key: SHA256 form, the older MD5 form, and a public key line.
  { kind: "key-fingerprint", re: /SHA256:[A-Za-z0-9+/]{43}(?![A-Za-z0-9+/])/g, bad: (m) => new Set(m.slice(7)).size > 8 && !allowExact.has(m.toLowerCase()) },
  { kind: "key-fingerprint", re: /(?<![0-9a-f:])(?:[0-9a-f]{2}:){15}[0-9a-f]{2}(?![0-9a-f:])/gi, bad: (m) => distinct(m) > 6 },
  { kind: "key-fingerprint", re: /(?:ssh-(?:ed25519|rsa|dss)|ecdsa-sha2-nistp\d+|sk-[a-z0-9-]+@openssh\.com) AAAA[A-Za-z0-9+/]{40,}={0,2}/g, bad: () => true, skip: LOCKFILE },
  { kind: "token", re: /eyJ[A-Za-z0-9_-]{16,}\.eyJ[A-Za-z0-9_-]{16,}|\b(?:sbp|sb_secret|sk_live|rk_live|ghp|gho|github_pat|xox[bap])_[A-Za-z0-9_-]{16,}/g, bad: (m) => !/fake|example|not-a-real/i.test(m) },
];

/* ── look ─────────────────────────────────────────────────────────────────── */
const findings = [];
let scanned = 0, lines = 0, binary = 0;
const add = (file, line, kind, match) => findings.push({ file, line, kind, match: match.length > 80 ? match.slice(0, 77) + "…" : match });
for (const file of files) {
  // A private name in a path is published too.
  for (const re of [wholeRe, anyRe]) if (re) { re.lastIndex = 0; for (const m of file.matchAll(re)) add(file, 0, "your-term-in-a-path", m[0]); }
  if (BINARY.test(file)) { binary++; continue; }
  let text;
  try { text = readFileSync(join(tree, file), "utf8"); } catch { continue; }
  if (text.includes("\u0000")) { binary++; continue; }
  scanned++;
  const rows = text.split("\n");
  const permitted = file === allowFileRel ? [...allowedText.entries()].map(([path, texts]) => texts.map((t) => `in ${path}: ${t}`)).flat() : (allowedText.get(file) || []);
  lines += rows.length;
  for (let i = 0; i < rows.length; i++) {
    let row = rows[i];
    // A permitted text is blanked in its own file, and on the allowlist line that declares it.
    for (const text of permitted) row = row.split(text).join(" ".repeat(text.length));
    if (wholeRe) for (const m of row.matchAll(wholeRe)) add(file, i + 1, "your-term", m[0]);
    if (anyRe) for (const m of row.matchAll(anyRe)) add(file, i + 1, "your-term", m[0]);
    for (const c of CHECKS) {
      if (c.skip && c.skip.test(file)) continue;
      for (const m of row.matchAll(c.re)) if (c.bad(m[0])) add(file, i + 1, c.kind, m[0]);
    }
    // A private key: the header alone is only text; the header with key material under or beside it is a key.
    if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(row) && (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*(\\n)?[A-Za-z0-9+/=]{40,}/.test(row) || /^[A-Za-z0-9+/=]{40,}$/.test((rows[i + 1] || "").trim()))) add(file, i + 1, "token", "a private key");
  }
}

/* ── say ──────────────────────────────────────────────────────────────────── */
if (scanned === 0) { console.error(`No text files to look at under ${tree}.`); end("blind", 3); }
const kinds = {};
for (const f of findings) kinds[f.kind] = (kinds[f.kind] || 0) + 1;
if (!quiet) {
  const seen = new Set();
  for (const f of findings) {
    const key = `${f.file}:${f.line}:${f.kind}:${f.match.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    console.log(`${f.file}${f.line ? ":" + f.line : ""}  ${f.kind}  ${f.match}`);
  }
}
if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify({ tree, scanned, lines, binary, terms: terms.length, genericOnly, kinds, findings }, null, 2));
if (findings.length) {
  console.log(`\n${findings.length} finding(s) in ${new Set(findings.map((f) => f.file)).size} file(s): ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")}`);
  console.log("A made-up value belongs in a documentation range (203.0.113.x, 2001:db8::, example.com). A public name every reader may see goes in scripts/privacy-allowlist.txt.");
}
console.log(`looked at ${scanned} text files (${lines} lines), ${binary} binary files left unread; ${genericOnly ? "built-in checks only, no denylist" : `${terms.length} of your own terms`}; ${allow.length} allowed names, ${[...allowedText.values()].flat().length} permitted texts`);
end(findings.length ? "findings" : "clean", findings.length ? 1 : 0);
