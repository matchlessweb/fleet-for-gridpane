/**
 * Checks for lib/site-row-id.ts and the three places that use it.   npm run siteid:test
 *
 *   (no option)  a real id of any size is a site; only a negative id is a staging copy
 *   --controls   break a copy of the helper, or of a file that uses it, one way at a time; each break must be caught
 *
 * SITE_ID_LIB, SITE_ID_PAGE, SITE_ID_LIST and SITE_ID_CRUMBS point the checks at other copies (the controls use them).
 * The bug this guards: "an id of 1,000,000 or more is a staging copy" made every newer site's page say Not found.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const FILES = {
  lib: process.env.SITE_ID_LIB || here("../lib/site-row-id.ts"),
  page: process.env.SITE_ID_PAGE || here("../app/(dashboard)/sites/[id]/page.tsx"),
  list: process.env.SITE_ID_LIST || here("../app/(dashboard)/sites/page.tsx"),
  crumbs: process.env.SITE_ID_CRUMBS || here("../components/layout/route-breadcrumbs.tsx"),
};
type Where = keyof typeof FILES;
type Break = [name: string, file: Where, edit: (s: string) => string];
const swap = (from: string | RegExp, to: string) => (s: string) => {
  const out = s.replace(from, to);
  if (out === s) throw new Error(`a control found nothing to change: ${String(from).slice(0, 60)}`);
  return out;
};
const BREAKS: Break[] = [
  ["an id of a million or more is read as a staging copy again", "lib", swap("return { siteId: Math.abs(n), staging: n < 0 };", "return n >= 1000000 ? { siteId: n - 1000000, staging: true } : { siteId: Math.abs(n), staging: n < 0 };")],
  ["a staging copy gets the live id plus a million again", "lib", swap("=> -liveSiteId;", "=> liveSiteId + 1000000;")],
  ["a staging copy gets its live site's own id", "lib", swap("=> -liveSiteId;", "=> liveSiteId;")],
  ["a negative id is read as a live site", "lib", swap("staging: n < 0 }", "staging: false }")],
  ["every id is read as a staging copy", "lib", swap("staging: n < 0 }", "staging: true }")],
  ["a staging id keeps its minus sign", "lib", swap("siteId: Math.abs(n)", "siteId: n")],
  ["an id with letters after it is read as a site", "lib", swap("!/^-?[1-9][0-9]{0,14}$/.test(raw)", "Number.isNaN(parseInt(raw))")],
  ["zero is read as a site", "lib", swap("/^-?[1-9][0-9]{0,14}$/", "/^-?[0-9]{1,15}$/")],
  ["the site page goes back to the million rule", "page", swap("const isStaging = siteParam?.staging ?? false;", "const isStaging = Number(resolvedParams.id) >= 1000000;")],
  ["the site page stops using the shared reader", "page", swap("const siteParam = readSiteParam(resolvedParams.id);", "const siteParam = { siteId: parseInt(resolvedParams.id), staging: false };")],
  ["the list goes back to the live id plus a million", "list", swap("id: stagingRowId(site.id)", "id: site.id + 1000000")],
  ["the breadcrumbs go back to the million rule", "crumbs", swap("const staging = site?.staging ?? false;", "const staging = Number(id) >= 1000000;")],
  ["the breadcrumbs stop using the shared reader", "crumbs", swap('const site = parent === "sites" ? readSiteParam(id) : null;', 'const site = parent === "sites" ? { siteId: Number(id), staging: false } : null;')],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "site-row-id-controls-"));
  const ENV: Record<Where, string> = { lib: "SITE_ID_LIB", page: "SITE_ID_PAGE", list: "SITE_ID_LIST", crumbs: "SITE_ID_CRUMBS" };
  let caught = 0;
  try {
    for (const [name, file, edit] of BREAKS) {
      const env: NodeJS.ProcessEnv = { ...process.env };
      const copy = join(dir, file === "lib" ? "lib.ts" : `${file}.txt`);
      writeFileSync(copy, edit(readFileSync(FILES[file], "utf8"))); env[ENV[file]] = copy;
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch, and neither is one that failed everything: only a run that finished, passed some and failed some.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} of ${m[1]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(`\n${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const { readSiteParam, stagingRowId } = (await import(pathToFileURL(FILES.lib).href)) as typeof import("../lib/site-row-id.ts");

let ran = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => { ran++; if (!ok) failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : "\n       " + detail}`); };
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

console.log("a real id of any size is a live site");
for (const id of [1, 400001, 999999, 1000000, 1000001, 1234567, 1500000, 1400001, 25000000, 999999999999999])
  check(`/sites/${id} is live site ${id}`, same(readSiteParam(String(id)), { siteId: id, staging: false }), JSON.stringify(readSiteParam(String(id))));

console.log("a negative id is the staging copy of that live site");
for (const id of [1, 400001, 999999, 1000000, 1234567, 25000000])
  check(`/sites/-${id} is the staging copy of ${id}`, same(readSiteParam(`-${id}`), { siteId: id, staging: true }), JSON.stringify(readSiteParam(`-${id}`)));

console.log("the list's staging id comes back as the same site, and is never a real site's id");
// Made-up ids on both sides of a million; 1400001 is 400001 plus a million, the old rule's collision.
const real = [400001, 800002, 999999, 1000000, 1000003, 1234567, 1400001, 1500000];
for (const id of real) {
  const row = stagingRowId(id);
  check(`the staging row of ${id} reads back as its staging copy`, same(readSiteParam(String(row)), { siteId: id, staging: true }), `row id ${row} -> ${JSON.stringify(readSiteParam(String(row)))}`);
  check(`the staging row of ${id} has an id no real site has`, row < 0 && !real.includes(row), `row id ${row}`);
}
check("the staging row of one site is never another site's page (400001 and 1400001)", stagingRowId(400001) !== 1400001 && readSiteParam(String(stagingRowId(400001)))?.siteId === 400001);

console.log("what is not an id is no site");
for (const raw of ["", "0", "-0", "abc", "12abc", "1e6", "1.5", " 12", "12 ", "+12", "--12", "0x10", "012", "1000000000000000", "NaN", "null"])
  check(`/sites/${JSON.stringify(raw)} is no site`, readSiteParam(raw) === null, JSON.stringify(readSiteParam(raw)));
check("a missing id is no site", readSiteParam(undefined) === null && readSiteParam(null) === null);

console.log("the three places that use it");
const page = readFileSync(FILES.page, "utf8"), list = readFileSync(FILES.list, "utf8"), crumbs = readFileSync(FILES.crumbs, "utf8");
const million = /1[_,]?000[_,]?000|1e6/;
check("the site page reads its id with the shared reader", /const siteParam = readSiteParam\(resolvedParams\.id\);/.test(page) && /const isStaging = siteParam\?\.staging \?\? false;/.test(page) && /const siteId = siteParam\?\.siteId \?\? null;/.test(page));
check("the site page has no million rule", !million.test(page), (million.exec(page) || [""])[0]);
check("the site page looks nothing up for an address that is not an id", /if \(siteId === null\) \{ setIsLoading\(false\); return; \}/.test(page));
check("the sites list makes a staging row's id with the shared helper", /id: stagingRowId\(site\.id\)/.test(list));
check("the sites list has no million rule", !million.test(list), (million.exec(list) || [""])[0]);
check("the breadcrumbs read a site's id with the shared reader", /const site = parent === "sites" \? readSiteParam\(id\) : null;/.test(crumbs) && /const staging = site\?\.staging \?\? false;/.test(crumbs) && /site \? site\.siteId : Number\(id\)/.test(crumbs));
check("the breadcrumbs have no million rule", !million.test(crumbs), (million.exec(crumbs) || [""])[0]);

console.log(`\nsite ids: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
