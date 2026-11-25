/**
 * Checks for lib/site-caching.ts.   npm run caching:test
 *
 *   (no option)  GridPane's caching rules as found on a dev site (docs/gridpane-api-caching.md)
 *   --controls   break a copy of the helper one way at a time; each break must be caught
 *
 * SITE_CACHING_LIB points the checks at another copy (the controls use it).
 * What this guards: a body GridPane would refuse with a misleading 429 (a quoted value), a switch
 * GridPane refuses with a 409, and a read-back that calls a change made when it was not.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = process.env.SITE_CACHING_LIB || fileURLToPath(new URL("../lib/site-caching.ts", import.meta.url));

const swap = (from: string, to: string) => (s: string) => {
  if (!s.includes(from)) throw new Error(`a control found nothing to change: ${from.slice(0, 60)}`);
  return s.replace(from, to);
};
const BREAKS: [string, (s: string) => string][] = [
  ["a page cache can be switched straight to the other", swap("if (state.page !== null) {", "if (false) {")],
  ["page caching off is sent as null instead of \"none\"", swap('return { body: { nginx_caching: "none" } };', "return { body: { nginx_caching: null as unknown as string } };")],
  ["the time to live is sent quoted", swap("return { body: { nginx_caching_ttl: action.seconds } };", "return { body: { nginx_caching_ttl: String(action.seconds) } };")],
  ["the object cache is sent quoted", swap("return { body: { object_caching: action.on } };", "return { body: { object_caching: String(action.on) } };")],
  ["a time to live is allowed with no page cache on", swap("if (state.page === null) return { error: \"Turn a page cache on first", "if (false) return { error: \"Turn a page cache on first")],
  ["a time to live of zero is allowed", swap("action.seconds < 1 ||", "action.seconds < 0 ||")],
  ["the object cache is read from the record's top level", swap("objectCache: asBool(custom?.object_caching),", "objectCache: asBool(gp.object_caching),")],
  ["\"none\" from GridPane is read as a page cache", swap("page: isPageCache(gp.nginx_caching) ? gp.nginx_caching : null,", "page: (gp.nginx_caching as PageCache) ?? null,")],
  ["the read-back says a page cache turned off when it is still on", swap('case "page": return after.page === (action.to === "off" ? null : action.to);', 'case "page": return true;')],
  ["a cache clear claims to be confirmed", swap('case "clear": return null;', 'case "clear": return true;')],
  ["two changes in one request are accepted", swap("if (keys.length !== 1)", "if (keys.length === 0)")],
  ["the time to live is rounded", swap("if (seconds >= size && seconds % size === 0) {", "if (seconds >= size) {")],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "site-caching-controls-"));
  let caught = 0;
  try {
    for (const [name, edit] of BREAKS) {
      const copy = join(dir, "site-caching.ts");
      writeFileSync(copy, edit(readFileSync(LIB, "utf8")));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env: { ...process.env, SITE_CACHING_LIB: copy }, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch, and neither is one that failed everything.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} of ${m[1]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(`controls: ${caught} caught, ${BREAKS.length - caught} missed, of ${BREAKS.length}`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const lib = await import(pathToFileURL(LIB).href);
let ran = 0, failed = 0;
const ok = (name: string, got: unknown, want: unknown) => {
  ran++;
  const pass = JSON.stringify(got) === JSON.stringify(want);
  if (!pass) failed++;
  console.log(`  ${pass ? "pass" : "FAIL"}  ${name}${pass ? "" : `\n        got  ${JSON.stringify(got)}\n        want ${JSON.stringify(want)}`}`);
};
const status = (r: { status?: number; body?: unknown }) => ("status" in r ? r.status : "ok");

const off = { page: null, ttl: 2592000, objectCache: false, objectCachePro: false };
const fcgi = { ...off, page: "fastcgi", ttl: 60 };
const redis = { ...off, page: "redis" };

// Reading GridPane's record (shapes copied from a dev site's record).
ok("a record with no page cache", lib.cachingFromRecord({ nginx_caching: null, object_cache_pro: false, object_caching: null, site_customizer: { nginx_caching_ttl: 0, object_caching: false } }), { page: null, ttl: 0, objectCache: false, objectCachePro: false });
ok("FastCGI on, time to live 60", lib.cachingFromRecord({ nginx_caching: "fastcgi", site_customizer: { nginx_caching_ttl: 60, object_caching: false } }), { page: "fastcgi", ttl: 60, objectCache: false, objectCachePro: null });
ok("the object cache comes from site_customizer, not the top-level field", lib.cachingFromRecord({ object_caching: null, site_customizer: { object_caching: true } }).objectCache, true);
ok("\"none\" is no page cache", lib.cachingFromRecord({ nginx_caching: "none" }).page, null);
ok("an unknown cache name is no page cache", lib.cachingFromRecord({ nginx_caching: "varnish" }).page, null);
ok("a record without a customizer reads as not reported", lib.cachingFromRecord({}), { page: null, ttl: null, objectCache: null, objectCachePro: null });
ok("columns keep null for no page cache", lib.cachingColumns(off), { nginx_caching: null, nginx_caching_ttl: 2592000, object_caching: false, object_cache_pro: false });

// Reading a request.
ok("one page change", lib.parseAction({ page: "redis" }), { kind: "page", to: "redis" });
ok("two changes at once are refused", "error" in lib.parseAction({ page: "redis", ttl: 60 }), true);
ok("a quoted time to live is refused", "error" in lib.parseAction({ ttl: "60" }), true);
ok("a fractional time to live is refused", "error" in lib.parseAction({ ttl: 1.5 }), true);
ok("a quoted object cache value is refused", "error" in lib.parseAction({ objectCache: "true" }), true);
ok("an unknown page cache is refused", "error" in lib.parseAction({ page: "varnish" }), true);
ok("a clear of everything", lib.parseAction({ clear: "all" }), { kind: "clear", what: "all" });

// GridPane's rules, and the bodies sent.
ok("FastCGI on from off: sent as GridPane's word", lib.planChange(off, { kind: "page", to: "fastcgi" }), { body: { nginx_caching: "fastcgi" } });
ok("off is sent as \"none\"", lib.planChange(fcgi, { kind: "page", to: "off" }), { body: { nginx_caching: "none" } });
ok("FastCGI straight to Redis is refused before GridPane refuses it", status(lib.planChange(fcgi, { kind: "page", to: "redis" })), 409);
ok("and the refusal says to turn it off first", /turn page caching off first/.test(lib.planChange(redis, { kind: "page", to: "fastcgi" }).error), true);
ok("turning on what is already on is refused", status(lib.planChange(redis, { kind: "page", to: "redis" })), 409);
ok("turning off what is already off is refused", status(lib.planChange(off, { kind: "page", to: "off" })), 409);
ok("a time to live is a real number, not text", lib.planChange(fcgi, { kind: "ttl", seconds: 120 }), { body: { nginx_caching_ttl: 120 } });
ok("a time to live with no page cache on is refused", status(lib.planChange(off, { kind: "ttl", seconds: 120 })), 409);
ok("a time to live of zero is refused", status(lib.planChange(fcgi, { kind: "ttl", seconds: 0 })), 400);
ok("a time to live over a year is refused", status(lib.planChange(fcgi, { kind: "ttl", seconds: 31_536_001 })), 400);
ok("the object cache is a real boolean, not text", lib.planChange(off, { kind: "objectCache", on: true }), { body: { object_caching: true } });
ok("the object cache already on is refused", status(lib.planChange({ ...off, objectCache: true }, { kind: "objectCache", on: true })), 409);
ok("a clear is sent as GridPane's word", lib.planChange(off, { kind: "clear", what: "page" }), { body: { clear_cache: "page" } });

// The read-back.
ok("off shows when no page cache is on", lib.changeShows(off, { kind: "page", to: "off" }), true);
ok("off does not show while one is still on", lib.changeShows(redis, { kind: "page", to: "off" }), false);
ok("a page cache shows when it is that one", lib.changeShows(fcgi, { kind: "page", to: "fastcgi" }), true);
ok("a time to live shows only at that value", lib.changeShows(fcgi, { kind: "ttl", seconds: 120 }), false);
ok("the object cache shows when it matches", lib.changeShows({ ...off, objectCache: true }, { kind: "objectCache", on: true }), true);
ok("a clear cannot be read back", lib.changeShows(off, { kind: "clear", what: "all" }), null);

// Words.
ok("30 days", lib.formatTtl(2592000), "30 days");
ok("1 hour", lib.formatTtl(3600), "1 hour");
ok("90 seconds stays seconds, never rounded", lib.formatTtl(90), "90 seconds");
ok("1 second", lib.formatTtl(1), "1 second");
ok("not reported", lib.formatTtl(null), "not reported");

console.log(`site caching: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
