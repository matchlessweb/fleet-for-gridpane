#!/usr/bin/env node
// Splits the test suites (every package.json script ending in ":test") into
// shards of about equal running time, so CI can run them side by side.
//
//   node scripts/ci-shard.mjs 2 3      the suites of shard 2 of 3, one line, space-separated
//   node scripts/ci-shard.mjs --plan 3 every shard with its suites and estimated seconds
//   node scripts/ci-shard.mjs --check 3   exit 1 unless every suite is in exactly one shard
//
// The seconds below were measured on GitHub's macOS runner (the platform CI holds to),
// on 2026-11-25. That runner is slower than a recent Mac, and not by one factor: the
// WAF inventory ran four times as long, the host-keys suite under twice. They only steer the
// split: a suite missing from the table counts as DEFAULT_SECONDS, and a new
// suite is picked up without a change here. The split is the same on every run
// (longest first, each to the shard with the least so far; ties by name).

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SECONDS = {
  "wafinv:test": 1155, "hostkeys:test": 449, "installers:test": 301, "sql:test": 281,
  "accesscheck:test": 110, "accesskeys:test": 88, "curlsecrets:test": 84, "access:rule:test": 65,
  "sso:schema:test": 65, "sso:keys:test": 64, "access:schema:test": 51, "privacy:denylist:test": 31,
  "user:test": 25, "accessgate:test": 22, "buildsecrets:test": 19, "names:test": 13, "export:test": 13,
  "sso:test": 10, "sso:install:test": 8,
  // Measured in the second run: its fifteen controls each build Postgres in memory, about 105 s each.
  "drift:test": 1781,
  // Not reached in that run: estimates. The OPcache suite gains a php install where it runs.
  "doctor:test": 100, "opcache:test": 120,
};
const DEFAULT_SECONDS = 20;

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const suites = Object.keys(JSON.parse(readFileSync(join(root, "package.json"), "utf8")).scripts)
  .filter((k) => k.endsWith(":test"))
  .sort();

function split(n) {
  const bins = Array.from({ length: n }, () => ({ total: 0, suites: [] }));
  const order = [...suites].sort((a, b) => (SECONDS[b] ?? DEFAULT_SECONDS) - (SECONDS[a] ?? DEFAULT_SECONDS) || a.localeCompare(b));
  for (const s of order) {
    const bin = bins.reduce((min, b) => (b.total < min.total ? b : min), bins[0]);
    bin.suites.push(s);
    bin.total += SECONDS[s] ?? DEFAULT_SECONDS;
  }
  return bins;
}

const usage = () => { console.error("usage: ci-shard.mjs <shard> <of>  |  --plan <of>  |  --check <of>"); process.exit(2); };
const whole = (v) => (/^[1-9][0-9]*$/.test(v ?? "") ? Number(v) : usage());
const [a, b] = process.argv.slice(2);

if (a === "--plan" || a === "--check") {
  const bins = split(whole(b));
  const seen = bins.flatMap((x) => x.suites);
  const once = seen.length === suites.length && new Set(seen).size === suites.length;
  if (a === "--plan") bins.forEach((x, i) => console.log(`shard ${i + 1}: ~${x.total}s  ${x.suites.join(" ")}`));
  console.log(once ? `${suites.length} suites, each in exactly one of ${bins.length} shards` : "NOT every suite is in exactly one shard");
  process.exit(once ? 0 : 1);
}
const of = whole(b), shard = whole(a);
if (shard > of) usage();
console.log(split(of)[shard - 1].suites.join(" "));
