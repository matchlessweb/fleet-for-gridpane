/**
 * Checks for lib/access-gate.ts and its place in middleware.ts, for Patchstack's
 * guard in front of it, and for which paths get the Access check and the session
 * check at all (lib/middleware-scope.ts).   npm run accessgate:test
 *
 *   (no option)  every "this is let through" sits beside the same request with one thing wrong
 *   --controls   break a copy of the gate, or of the middleware, one way at a time; each break must be caught
 *
 * GATE_LIB, GATE_MIDDLEWARE, GATE_SCOPE, GATE_GUARD, GATE_RULES and GATE_WRANGLER point the checks at other copies (the controls use them).
 * Touches nothing outside this process: the keys are made here and "Cloudflare" is a function.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const LIB = process.env.GATE_LIB || here("../lib/access-gate.ts");
const MIDDLEWARE = process.env.GATE_MIDDLEWARE || here("../middleware.ts");
const SCOPE = process.env.GATE_SCOPE || here("../lib/middleware-scope.ts");
const GUARD = process.env.GATE_GUARD || here("../patchstack.next.ts");
const WRANGLER = process.env.GATE_WRANGLER || here("../wrangler.jsonc");
const RULES = process.env.GATE_RULES || here("../patchstack.rules.json");
const JWT_LIB = here("../lib/sso/access-jwt.ts");

type Break = [name: string, file: "gate" | "middleware" | "scope" | "guard" | "wrangler" | "rules", edit: (s: string) => string];
const swap = (from: string | RegExp, to: string) => (s: string) => {
  const out = s.replace(from, to);
  if (out === s) throw new Error(`a control found nothing to change: ${String(from).slice(0, 60)}`);
  return out;
};
const BREAKS: Break[] = [
  ["half a setup reads as no Access at all", "gate", swap("env.CF_ACCESS_TEAM_DOMAIN?.trim() || env.CF_ACCESS_AUD?.trim()", "env.CF_ACCESS_TEAM_DOMAIN?.trim() && env.CF_ACCESS_AUD?.trim()")],
  ["every token is let through", "gate", swap('if (access.ok || access.reason === "not-a-person")', "if (true)")],
  ["a request with no token is let through", "gate", swap('access.reason === "not-a-person")', 'access.reason === "not-a-person" || access.reason === "missing")')],
  ["a token for another application is let through", "gate", swap('access.reason === "not-a-person")', 'access.reason === "not-a-person" || access.reason === "wrong-audience")')],
  ["an unfinished setup lets the request through", "gate", swap(/if \(access\.reason === "not-configured"\) \{\n[\s\S]*?\n  \}/, 'if (access.reason === "not-configured") return { allow: true, checked: false };')],
  ["keys that cannot be fetched let the request through", "gate", swap(/if \(access\.reason === "keys-unavailable"\) \{[\s\S]*?\n  \}/, 'if (access.reason === "keys-unavailable") return { allow: true, checked: true };')],
  ["a 'could not check' answer is sent as 403, like a forged token", "gate", swap('status: 503, reason: "access-keys-unavailable"', 'status: 403, reason: "access-keys-unavailable"')],
  ["a 'could not check' answer does not say to try again", "gate", swap('message: "Could not check with Cloudflare Access just now. Try again in a moment." };', 'message: "This request did not come through Cloudflare Access." };')],
  ["a service token is turned away", "gate", swap('if (access.ok || access.reason === "not-a-person")', "if (access.ok)")],
  ["an install without Access says the check ran", "gate", swap("return { allow: true, checked: false };", "return { allow: true, checked: true };")],
  ["a refusal tells the caller why", "gate", swap('message: "This request did not come through Cloudflare Access." };', "message: `Refused: ${access.reason}` };")],
  ["a wrong team address is reported as a missing setting", "gate", swap("const wrongFormat = Boolean(team) && normalizeTeamDomain(team) === null;", "const wrongFormat = false;")],
  ["a missing setting is reported as a wrong team address", "gate", swap("const wrongFormat = Boolean(team) && normalizeTeamDomain(team) === null;", "const wrongFormat = true;")],
  ["a deployed app tells a stranger about .env.local", "gate", swap('if (!development || refusal.reason !== "access-missing") return refusal.message;', 'if (refusal.reason !== "access-missing") return refusal.message;')],
  ["a local run is not told why every request is refused", "gate", swap('if (!development || refusal.reason !== "access-missing") return refusal.message;', "return refusal.message;")],
  ["a local run is told the likely cause for a forged token too", "gate", swap('if (!development || refusal.reason !== "access-missing") return refusal.message;', "if (!development) return refusal.message;")],
  ["a local run is told to take the settings out, without a word about the privacy list", "gate", swap(" Copy the two lines to ~/.config/fleet/privacy-extra first, so the privacy list (npm run privacy:denylist) still keeps them out of anything you publish.", "")],
  ["the middleware treats every run as a development run", "middleware", swap("refusalMessage(gate, process.env.NODE_ENV === 'development')", "refusalMessage(gate, true)")],
  ["the middleware answers with the plain message even in development", "middleware", swap("NextResponse.json({ error: message }", "NextResponse.json({ error: gate.message }")],
  ["the middleware asks but does not act on the answer", "middleware", swap("if (!gate.allow) {", "if (false) {")],
  ["the middleware asks after the session has been read", "middleware", (s) => {
    const a = s.indexOf("  // The front door"), b = s.indexOf("  let supabaseResponse = NextResponse.next({");
    const c = s.indexOf("  const url = request.nextUrl.clone()");
    if (a < 0 || b < 0 || c < 0 || !(a < b && b < c)) throw new Error("a control found nothing to move");
    return s.slice(0, a) + s.slice(b, c) + s.slice(a, b) + s.slice(c);
  }],
  ["the middleware reads the token from a header anyone can name", "middleware", swap("request.headers.get(ACCESS_JWT_HEADER)", "request.headers.get('x-access-token')")],
  ["the middleware checks only pages, not the API", "middleware", swap("  if (!gate.allow) {", "  if (!gate.allow && !request.nextUrl.pathname.startsWith('/api')) {")],
  ["the middleware hard-codes the two settings as unset", "middleware", swap("env: { CF_ACCESS_TEAM_DOMAIN: process.env.CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD: process.env.CF_ACCESS_AUD },", "env: {},")],
  ["any path that ends like a picture skips the checks, folders and all (the old pattern)", "scope", swap("|[^/]*\\.(?:svg|", "|.*\\.(?:svg|")],
  ["a path that only begins like favicon.ico or the manifest skips the checks", "scope", swap("|_next\\/image|", "|_next\\/image|favicon.ico|manifest\\.webmanifest|")],
  ["no file is let past the checks at all", "scope", swap("|[^/]*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$", "")],
  ["the matcher narrows again, so Patchstack's guard misses paths", "middleware", swap('matcher: "/:path*",', "matcher: ['/((?!_next/static|_next/image).*)'],")],
  ["the scope check is dropped, so icons and the manifest need a session", "middleware", swap("  if (!inAppScope(request.nextUrl.pathname)) return\n", "")],
  ["the scope check moves after the Access check", "middleware", (s) => {
    const line = "  if (!inAppScope(request.nextUrl.pathname)) return\n", a = s.indexOf(line), b = s.indexOf("  // Says on every answer");
    if (a < 0 || b < 0) throw new Error("a control found nothing to move");
    return (s.slice(0, a) + s.slice(a + line.length)).replace("  // Says on every answer", line + "  // Says on every answer");
  }],
  ["Patchstack's guard moves after the Access check", "middleware", (s) => {
    const a = s.indexOf("  // #region patchstack-next"), b = s.indexOf("  // #endregion\n", a) + "  // #endregion\n".length, c = s.indexOf("  // Says on every answer");
    if (a < 0 || b < a || c < 0) throw new Error("a control found nothing to move");
    return s.slice(0, a) + s.slice(b, c) + s.slice(a, b) + s.slice(c);
  }],
  ["Patchstack's answer lets a request in", "middleware", swap("if (psBlocked) return psBlocked;", "if (psBlocked) return psBlocked;\n  if (psProtection) return;")],
  ["Patchstack's fetch wrapper is switched back on (it ran the Worker out of memory)", "guard", swap("egress: false,", "egress: true,")],
  ["Patchstack's fetch wrapper is left to the package default", "guard", swap("egress: false, ", "")],
  ["a failed guard build is not tried again in the same request", "guard", swap("attempt < 2", "attempt < 1")],
  ["a dead shared build is kept for every later request", "guard", swap("if (_protection === pending) _protection = undefined;", "")],
  ["the guard is no longer told the visitor's address", "guard", swap(", peerAddress: cloudflareClientIp,", ",")],
  ["the visitor's address is read from a header a visitor can set", "guard", swap('get?.("cf-connecting-ip")', 'get?.("x-forwarded-for")')],
  ["a streamed answer (the Sync button's progress) is held back by the response screen again", "guard", swap("if (!protection || isLiveStream(settled)) return settled;", "if (!protection) return settled;")],
  ["the saved rules go back to report-only", "rules", swap('"enforcement": "block"', '"enforcement": "dry-run"')],
  ["a cold start waits Patchstack's default 5 s again", "guard", swap(", bootTimeoutMs: 1500 }", " }")],
  ["the guard build time is no longer logged", "guard", swap("if (fresh) console.log(", "if (false) console.log(")],
  ["the middleware stops handing the guard the request's waitUntil", "middleware", swap('getPatchstackProtection((promise) => event.waitUntil(promise), "middleware")', 'getPatchstackProtection(undefined, "middleware")')],
  ["the Worker may fetch private and internal addresses again", "wrangler", swap('"global_fetch_strictly_public"', '"global_fetch_public"')],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "access-gate-controls-"));
  let caught = 0;
  let skipped = 0;
  // Patchstack's starter rules (the public copy's) carry no "enforcement" line to break: the
  // saved-rules check skips them, so does its control.
  const siteRules = Boolean((JSON.parse(readFileSync(RULES, "utf8")) as { _patchstack?: unknown })._patchstack);
  try {
    for (const [name, file, edit] of BREAKS) {
      if (file === "rules" && !siteRules) {
        skipped++;
        console.log(`  skip    ${name}  (Patchstack's starter rules, not a site's)`);
        continue;
      }
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (file === "gate") {
        // A copy in a temp folder cannot find its neighbor: point its import at the real verifier.
        const broken = edit(readFileSync(LIB, "utf8")).replace('"./sso/access-jwt.ts"', JSON.stringify(pathToFileURL(JWT_LIB).href));
        writeFileSync(join(dir, "gate.ts"), broken); env.GATE_LIB = join(dir, "gate.ts");
      } else if (file === "scope") {
        writeFileSync(join(dir, "scope.ts"), edit(readFileSync(SCOPE, "utf8"))); env.GATE_SCOPE = join(dir, "scope.ts");
      } else if (file === "guard") {
        writeFileSync(join(dir, "guard.ts"), edit(readFileSync(GUARD, "utf8"))); env.GATE_GUARD = join(dir, "guard.ts");
      } else if (file === "rules") {
        writeFileSync(join(dir, "rules.json"), edit(readFileSync(RULES, "utf8"))); env.GATE_RULES = join(dir, "rules.json");
      } else if (file === "wrangler") {
        writeFileSync(join(dir, "wrangler.jsonc"), edit(readFileSync(WRANGLER, "utf8"))); env.GATE_WRANGLER = join(dir, "wrangler.jsonc");
      } else {
        writeFileSync(join(dir, "middleware.ts"), edit(readFileSync(MIDDLEWARE, "utf8"))); env.GATE_MIDDLEWARE = join(dir, "middleware.ts");
      }
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch: only a run that finished and counted failures is.
      // Nor is a copy that fails every check: it did not run the checks, it broke before them.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const tried = BREAKS.length - skipped;
  console.log(`\n${tried} broken copies: ${caught} caught, ${tried - caught} missed${skipped ? `, ${skipped} skipped` : ""}`);
  process.exit(caught === tried ? 0 : 1);
}

const { checkAccessGate, usesAccess, refusalMessage, ACCESS_JWT_HEADER } = (await import(pathToFileURL(LIB).href)) as typeof import("../lib/access-gate.ts");
const { clearAccessKeyCache } = await import(pathToFileURL(JWT_LIB).href) as typeof import("../lib/sso/access-jwt.ts");

let ran = 0, failed = 0;
function check(name: string, ok: boolean, detail = "") {
  ran++; if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : `\n       ${detail}`}`);
}

const TEAM = "team.example.com", AUD = "a".repeat(64), NOW = 1_800_000_000;
const ENV = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const b64u = (v: Uint8Array | string) => Buffer.from(typeof v === "string" ? new TextEncoder().encode(v) : v).toString("base64url");
async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } };
}
type Key = Awaited<ReturnType<typeof makeKey>>;
async function sign(key: Key, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const real = await makeKey("k1"), other = await makeKey("k1"); // the same name, another key: a forger's
let asked = 0;
const keys = async () => { asked++; return [real.jwk]; };
const down = async () => { asked++; throw new Error("no answer"); };
const PERSON = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, email: "person@example.com", sub: "user-1" };
const SERVICE = { iss: `https://${TEAM}`, aud: [AUD], exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, common_name: "abc.access", sub: "" };
const gate = (accessJwt: string | null, env = ENV as Record<string, string | undefined>, fetchKeys = keys) => { clearAccessKeyCache(); return checkAccessGate({ accessJwt, env, now: NOW, fetchKeys }); };
const refused = (r: Awaited<ReturnType<typeof gate>>, status: number, reason: string) => r.allow === false && r.status === status && r.reason === reason;
const show = (r: unknown) => JSON.stringify(r);

console.log("An install that does not use Access");
{
  asked = 0;
  for (const [label, env] of [["neither setting", {}], ["both empty", { CF_ACCESS_TEAM_DOMAIN: "", CF_ACCESS_AUD: "" }], ["both only spaces", { CF_ACCESS_TEAM_DOMAIN: "  ", CF_ACCESS_AUD: " " }]] as const) {
    const r = await gate(null, env);
    check(`${label}: the request goes on, and the answer says nothing was checked`, r.allow === true && r.checked === false, show(r));
    check(`${label}: usesAccess says no`, usesAccess(env) === false);
  }
  check("and Cloudflare was never asked for keys", asked === 0, `${asked} requests`);
}

console.log("Both settings set: what gets through");
{
  const r = await gate(await sign(real, PERSON));
  check("a person's token, signed by the team's key for this application", r.allow === true && r.checked === true, show(r));
  const s = await gate(await sign(real, SERVICE));
  check("a service token, signed by the team's key for this application", s.allow === true && s.checked === true, show(s));
  check("usesAccess says yes", usesAccess(ENV) === true);
  check("the header read is the one Access sets", ACCESS_JWT_HEADER === "cf-access-jwt-assertion");
}

console.log("Both settings set: what is refused (each is the request above with one thing wrong)");
{
  const cases: [string, string | null, string][] = [
    ["no token at all", null, "access-missing"],
    ["an empty token", "", "access-missing"],
    ["text that is not a token", "not.a.token", "access-malformed"],
    ["a token signed by another key of the same name", await sign(other, PERSON), "access-bad-signature"],
    ["a token that names no algorithm", await sign(real, PERSON, { alg: "none" }), "access-wrong-algorithm"],
    ["a token signed by a key the team does not publish", await sign({ ...real, kid: "k9" }, PERSON), "access-unknown-key"],
    ["a token for another application", await sign(real, { ...PERSON, aud: ["b".repeat(64)] }), "access-wrong-audience"],
    ["a token from another team", await sign(real, { ...PERSON, iss: "https://other.example.com" }), "access-wrong-issuer"],
    ["a token that ran out", await sign(real, { ...PERSON, exp: NOW - 3600 }), "access-expired"],
    ["a token not yet in force", await sign(real, { ...PERSON, nbf: NOW + 3600, iat: NOW + 3600 }), "access-not-yet-valid"],
    ["a service token for another application", await sign(real, { ...SERVICE, aud: ["b".repeat(64)] }), "access-wrong-audience"],
    ["a service token that ran out", await sign(real, { ...SERVICE, exp: NOW - 3600 }), "access-expired"],
    ["a service token signed by another key", await sign(other, SERVICE), "access-bad-signature"],
  ];
  for (const [label, token, reason] of cases) {
    const r = await gate(token);
    check(`${label} is refused (403)`, refused(r, 403, reason), show(r));
    check(`${label}: the caller is not told why`, r.allow === false && r.message === "This request did not come through Cloudflare Access.", show(r));
  }
}

console.log("Half a setup, and Cloudflare not answering");
{
  const good = await sign(real, PERSON);
  for (const [label, env] of [
    ["only the team address is set", { CF_ACCESS_TEAM_DOMAIN: TEAM }],
    ["only the audience tag is set", { CF_ACCESS_AUD: AUD }],
    ["the audience tag is only spaces", { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: "   " }],
  ] as const) {
    check(`${label}: usesAccess says yes`, usesAccess(env) === true);
    const r = await gate(good, env);
    check(`${label}: even a good token is refused (503), and the message names both settings`,
      refused(r, 503, "access-not-configured") && r.allow === false && /CF_ACCESS_TEAM_DOMAIN/.test(r.message) && /CF_ACCESS_AUD/.test(r.message), show(r));
    const n = await gate(null, env);
    check(`${label}: a request with no token is refused too`, n.allow === false, show(n));
  }
  const r = await gate(good, ENV, down);
  check("Cloudflare's keys cannot be fetched and none are held: a good token is refused (503), not waved through", refused(r, 503, "access-keys-unavailable"), show(r));
  // The same failure after the keys were fetched once: the app goes on working (the cache is not cleared between these two).
  clearAccessKeyCache();
  const before = await checkAccessGate({ accessJwt: good, env: ENV, now: NOW, fetchKeys: keys });
  const during = await checkAccessGate({ accessJwt: await sign(real, { ...PERSON, exp: NOW + 1500 }), env: ENV, now: NOW + 900, fetchKeys: down });
  check("Cloudflare stops answering after the keys were fetched: a good token is still let through", before.allow === true && during.allow === true && during.checked === true, show(during));
  const forged = await checkAccessGate({ accessJwt: await sign(other, { ...PERSON, exp: NOW + 1500 }), env: ENV, now: NOW + 901, fetchKeys: down });
  check("and a forged one is still refused (403) meanwhile", refused(forged, 403, "access-bad-signature"), show(forged));
  clearAccessKeyCache();
}

console.log("A key Cloudflare has just started signing with, when the second look cannot be made");
{
  const newer = await makeKey("k2");
  const both = async () => { asked++; return [real.jwk, newer.jwk]; };
  const person = await sign(newer, PERSON);
  clearAccessKeyCache();
  await checkAccessGate({ accessJwt: await sign(real, PERSON), env: ENV, now: NOW, fetchKeys: keys }); // the keys held: k1 only
  const stranger = await checkAccessGate({ accessJwt: await sign({ ...real, kid: "k9" }, PERSON), env: ENV, now: NOW + 1, fetchKeys: keys });
  check("a forged token naming a key nobody publishes is refused (403): Cloudflare was asked, and it is not there", refused(stranger, 403, "access-unknown-key"), show(stranger));
  asked = 0;
  const early = await checkAccessGate({ accessJwt: person, env: ENV, now: NOW + 5, fetchKeys: both });
  check("right after it, a token signed with the new key is refused with 503, not 403: the look was already used, so Fleet could not check", refused(early, 503, "access-keys-unavailable") && asked === 0, `${show(early)} asked ${asked}`);
  check("and it is told to try again in a moment", early.allow === false && early.message === "Could not check with Cloudflare Access just now. Try again in a moment.", show(early));
  const later = await checkAccessGate({ accessJwt: person, env: ENV, now: NOW + 61, fetchKeys: both });
  check("a minute on, the same token is let through", later.allow === true && later.checked === true, show(later));
  clearAccessKeyCache();
  await checkAccessGate({ accessJwt: await sign(real, PERSON), env: ENV, now: NOW, fetchKeys: keys });
  const unheard = await checkAccessGate({ accessJwt: person, env: ENV, now: NOW + 5, fetchKeys: down });
  check("when the look gets no answer from Cloudflare, the new key is refused with 503 too, never let through", refused(unheard, 503, "access-keys-unavailable"), show(unheard));
  const held = await checkAccessGate({ accessJwt: await sign(real, PERSON), env: ENV, now: NOW + 6, fetchKeys: down });
  check("control: a token signed with a key that is held is let through all the while", held.allow === true && held.checked === true, show(held));
  clearAccessKeyCache();
}

console.log("The team address");
{
  const good = await sign(real, PERSON);
  for (const typed of [`https://${TEAM}`, `https://${TEAM}/`, `  ${TEAM.toUpperCase()}  `]) {
    const r = await gate(good, { CF_ACCESS_TEAM_DOMAIN: typed, CF_ACCESS_AUD: AUD });
    check(`pasted as "${typed}": the check runs and a good token is let through`, r.allow === true && r.checked === true, show(r));
    const n = await gate(null, { CF_ACCESS_TEAM_DOMAIN: typed, CF_ACCESS_AUD: AUD });
    check(`pasted as "${typed}": a request with no token is refused (403)`, refused(n, 403, "access-missing"), show(n));
  }
  for (const typed of [`${TEAM}/some/path`, `http://${TEAM}`, `${TEAM}:8443`, "not an address"]) {
    const env = { CF_ACCESS_TEAM_DOMAIN: typed, CF_ACCESS_AUD: AUD };
    asked = 0;
    const r = await gate(good, env);
    check(`"${typed}" is not a team address: even a good token is refused (503), and Cloudflare is not asked`, refused(r, 503, "access-not-configured") && asked === 0, show(r));
    check(`"${typed}": the message says the address is wrong, not that a setting is missing, and does not repeat the value`,
      r.allow === false && /CF_ACCESS_TEAM_DOMAIN is set, but it is not a team address/.test(r.message) && !/incomplete/.test(r.message) && !r.message.includes(typed), show(r));
  }
  const missing = await gate(good, { CF_ACCESS_TEAM_DOMAIN: TEAM });
  check("control: a setting that is missing is still called incomplete, not a wrong address", missing.allow === false && /incomplete/.test(missing.message) && !/not a team address/.test(missing.message), show(missing));
  const both = await gate(good, { CF_ACCESS_TEAM_DOMAIN: `${TEAM}/x`, CF_ACCESS_AUD: "" });
  check("a wrong address AND no audience tag: refused (503)", refused(both, 503, "access-not-configured"), show(both));
}

console.log("What a refused caller is told");
{
  const none = await gate(null), forged = await gate(await sign(other, PERSON));
  if (none.allow || forged.allow) check("both requests are refused", false, show([none, forged]));
  else {
    const plain = "This request did not come through Cloudflare Access.";
    check("a deployed app says only that the request did not come through Access", refusalMessage(none, false) === plain && refusalMessage(forged, false) === plain, refusalMessage(none, false));
    const local = refusalMessage(none, true);
    check("a development run with no token is also told the likely cause: the two settings in .env.local", local.startsWith(plain) && /\.env\.local/.test(local) && /CF_ACCESS_TEAM_DOMAIN/.test(local) && /CF_ACCESS_AUD/.test(local) && /development run/.test(local), local);
    check("and to copy the two lines to the privacy list's own file before taking them out", /Copy the two lines to ~\/\.config\/fleet\/privacy-extra first/.test(local) && /npm run privacy:denylist/.test(local), local);
    check("control: a development run with a forged token gets the plain message", refusalMessage(forged, true) === plain, refusalMessage(forged, true));
    const half = await gate(null, { CF_ACCESS_TEAM_DOMAIN: TEAM });
    check("control: half a setup keeps its own message in a development run", half.allow === false && refusalMessage(half, true) === half.message, show(half));
  }
}

console.log("The middleware asks first, and acts on the answer");
{
  const src = readFileSync(MIDDLEWARE, "utf8");
  const at = (needle: string) => src.indexOf(needle);
  const ask = at("await checkAccessGate({"), act = at("if (!gate.allow) {"), session = at("createServerClient("), getUser = at("supabase.auth.getUser()");
  check("it asks the gate before it builds the session client or reads the user", ask > 0 && ask < session && ask < getUser, `ask ${ask}, client ${session}, user ${getUser}`);
  check("it acts on a refusal before it builds the session client", act > ask && act < session, `act ${act}`);
  const block = act > 0 ? src.slice(act, at("  // Says on every answer")) : "";
  check("the refusal block returns for pages and for the API, with the gate's own status", (block.match(/status: gate\.status/g) || []).length === 2 && /NextResponse\.json\(/.test(block) && /new NextResponse\(/.test(block) && !/NextResponse\.next\(/.test(block), block.slice(0, 200));
  check("pages and the API are both answered with the message for this kind of run", /const message = refusalMessage\(gate, process\.env\.NODE_ENV === 'development'\)/.test(block) && /NextResponse\.json\(\{ error: message \}/.test(block) && /new NextResponse\(`\$\{message\}\\n`/.test(block) && !/gate\.message/.test(block), block.slice(0, 300));
  check("the refusal is never cached", /'cache-control': 'no-store'/.test(block));
  check("the token comes from the header Access sets", /accessJwt: request\.headers\.get\(ACCESS_JWT_HEADER\)/.test(src));
  check("the two settings are read from the environment by name", /CF_ACCESS_TEAM_DOMAIN: process\.env\.CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD: process\.env\.CF_ACCESS_AUD/.test(src));
  check("no path is excused from the gate inside the function", !/gate\.allow\s*&&/.test(src) && !/if \(false\)/.test(src));
  const returns = (src.slice(at("  let supabaseResponse")).match(/\n\s+return (?!stamp\()/g) || []).length;
  check("every answer after the gate says whether the check ran", returns === 1 /* the cookies getAll() */ && /x-fleet-access-check/.test(src), `${returns} unstamped returns`);
}

console.log("Patchstack's guard sees every request, first, and can only refuse one");
{
  const src = readFileSync(MIDDLEWARE, "utf8");
  const at = (needle: string) => src.indexOf(needle);
  // Comment lines are dropped first, so an apostrophe in one cannot be read as a quote.
  const config = src.slice(at("export const config")).replace(/^\s*\/\/.*$/gm, "");
  check("the matcher is the catch-all, and nothing else", /^export const config = \{\s*matcher: "\/:path\*",\s*\}\s*$/.test(config.trim()), config.trim());
  const guard = at("const psBlocked = psProtection && await psProtection.fetchGuard()(request, event);");
  const scope = at("if (!inAppScope(request.nextUrl.pathname)) return\n"), ask = at("await checkAccessGate({");
  check("the guard runs before the scope check and before the Access check", guard > 0 && guard < scope && guard < ask, `guard ${guard}, scope ${scope}, gate ${ask}`);
  check("the scope check runs before the Access check", scope > 0 && scope < ask, `scope ${scope}, gate ${ask}`);
  const region = src.slice(at("  // #region patchstack-next-composed"), at("  // #endregion"));
  check("the guard sits in Patchstack's own marker for composed middleware", at("  // #region patchstack-next-composed") > 0);
  check("the guard's only return is its own refusal", (region.match(/\breturn\b/g) || []).length === 1 && /if \(psBlocked\) return psBlocked;/.test(region), region);
  check("the guard comes from the shared helper the routes use", /^import \{ getPatchstackProtection \} from '\.\/patchstack\.next'$/m.test(src));

  // With egress on, the guard wraps globalThis.fetch; on the Worker that wrapper and Next's own
  // fetch wrapper call each other until the Worker runs out of memory.
  const guardSrc = readFileSync(GUARD, "utf8").replace(/^\s*\/\/.*$/gm, "");
  const egress = guardSrc.match(/\begress:\s*(\w+)/g) || [];
  check("the guard keeps Patchstack's fetch wrapper off, said once and in so many words", egress.length === 1 && egress[0].replace(/\s/g, "") === "egress:false", egress.join(", ") || "no egress setting: the package default turns it on");
  const boot = Number(guardSrc.match(/\bbootTimeoutMs:\s*(\d+)/)?.[1] ?? NaN);
  check("a cold start waits at most 2 s for Patchstack before starting on the saved rules (the package default is 5 s)", boot > 0 && boot <= 2000, Number.isNaN(boot) ? "not set: 5 s" : `${boot} ms`);
  const flags = readFileSync(WRANGLER, "utf8").replace(/^\s*\/\/.*$/gm, "").match(/"compatibility_flags":\s*\[([^\]]*)\]/)?.[1] || "";
  check("the Worker refuses fetches to private and internal addresses itself (what the wrapper screened)", /"global_fetch_strictly_public"/.test(flags), flags);
  // The guard falls back to these when Patchstack cannot be reached as a Worker starts. They must
  // enforce: saved rules left in dry-run mean a cold start without Patchstack only logs.
  const saved = JSON.parse(readFileSync(RULES, "utf8")) as { enforcement?: string; firewall?: unknown[]; _patchstack?: unknown };
  if (saved._patchstack) {
    check("the saved fallback rules block, so a Worker that starts without Patchstack still refuses attacks", saved.enforcement === "block" && (saved.firewall?.length ?? 0) > 0, `enforcement ${saved.enforcement ?? "not set"}, ${saved.firewall?.length ?? 0} rules (npx @patchstack/connect setup --widget refreshes the file)`);
  } else {
    // The public copy ships Patchstack's starter file, which belongs to no site and does not block on its own.
    console.log("  skip the saved fallback rules: this is Patchstack's starter file, not a site's (npx @patchstack/connect setup writes one)");
  }
  // On the Worker a build begun by a request that was then cancelled never settles for its own
  // .catch, so only the waiter that hit the error can drop it. Node cannot produce that promise,
  // so this one is read, not run.
  const helper = guardSrc.slice(guardSrc.indexOf("export async function getPatchstackProtection"));
  check("a waiter that finds the shared build dead drops it itself, and only if it is still the shared one",
    /catch \(error\) \{\s*lastError = error;\s*if \(_protection === pending\) _protection = undefined;\s*\}/.test(helper) &&
    /^function getProtection\(\): Promise<Protection>/m.test(guardSrc), helper.slice(0, 400));
  check("the middleware hands the guard the request's waitUntil, for its build and for its rule refresh",
    /export async function middleware\(request: NextRequest, event: NextFetchEvent\)/.test(src) &&
    /await getPatchstackProtection\(\(promise\) => event\.waitUntil\(promise\), "middleware"\)/.test(region), region);
}

console.log("A guard build that fails is dropped and tried again, not kept (live 2026-11-23: a cancelled request left one dead)");
{
  // The real helper, with Patchstack's package swapped for a stand-in this test drives. Node
  // cannot make a promise that is dead to one request and alive to another, as the Worker does;
  // a build that rejects stands in for it, and the reset line itself is checked above by its control.
  const dir = mkdtempSync(join(tmpdir(), "guard-build-"));
  try {
    const original = readFileSync(GUARD, "utf8");
    const copy = original
      .replace('import { createProtection } from "@patchstack/connect/protect";', "const createProtection = (o: unknown) => (globalThis as any).__psCreate(o);")
      .replace('import fallbackRules from "./patchstack.rules.json";', "const fallbackRules = {};");
    check("the stand-in replaced both of the helper's imports", copy !== original && !/^import /m.test(copy));
    let calls = 0, kept = 0, lastOptions: { peerAddress?: (r: Request) => unknown } = {};
    const warnings: string[] = [];
    const g = globalThis as { __psCreate?: (o: unknown) => Promise<unknown> };
    const realWarn = console.warn, realLog = console.log;
    const built: string[] = [];
    const load = async (failures: number) => {
      calls = 0; kept = 0; warnings.length = 0;
      g.__psCreate = async (o) => { calls++; lastOptions = (o ?? {}) as typeof lastOptions; if (calls <= failures) throw new Error(`build ${calls} failed`); return { built: calls }; };
      const file = join(dir, `guard-${failures}-${Math.random().toString(36).slice(2)}.ts`);
      writeFileSync(file, copy);
      return (await import(pathToFileURL(file).href)) as { getPatchstackProtection: (k?: (p: Promise<unknown>) => void) => Promise<unknown>; screenPatchstackResponse: (r: Response | Promise<Response>, q: Request, p: unknown) => Promise<Response> };
    };
    console.warn = (...a: unknown[]) => { warnings.push(a.join(" ")); };
    console.log = (...a: unknown[]) => { const line = a.join(" "); if (line.startsWith("[patchstack] guard built")) built.push(line); else realLog(...a); };
    try {
      let m = await load(1);
      const first = await m.getPatchstackProtection(() => { kept++; });
      check("one failed build: the same request builds again and is screened", (first as { built?: number } | null)?.built === 2 && calls === 2, `got ${JSON.stringify(first)}, ${calls} builds`);
      check("and it says nothing, because nothing went unscreened", warnings.length === 0, warnings.join(" | "));
      check("each new build is handed to the request's waitUntil", kept === 2, `${kept} handed over`);
      const again = await m.getPatchstackProtection(() => { kept++; });
      check("the next request reuses the finished build: no third build, nothing more handed over", again === first && calls === 2 && kept === 2, `${calls} builds, ${kept} handed over`);
      check("each build the instance makes is logged once, with its time and its caller, so cold starts are measured live", built.length === 1 && /^\[patchstack\] guard built in \d+ ms \(route; rules from /.test(built[0]), built.join(" | ") || "nothing logged");

      m = await load(2);
      const none = await m.getPatchstackProtection();
      check("two failed builds: the request goes on unscreened (the guard fails open) and that is said", none === null && calls === 2 && warnings.length === 1 && /build 2 failed/.test(warnings[0]), `${JSON.stringify(none)}, ${calls} builds, ${warnings.join(" | ")}`);
      const later = await m.getPatchstackProtection();
      check("the next request builds afresh and is screened", (later as { built?: number } | null)?.built === 3 && calls === 3, `${JSON.stringify(later)}, ${calls} builds`);
      check("control: no waitUntil given (a route handler) still works", later !== null);

      // On a Worker the guard has no socket to read the visitor's address from: it records only what peerAddress gives it.
      const peer = lastOptions.peerAddress;
      const ask = (headers: Record<string, string>) => peer?.(new Request("https://example.test/", { headers }));
      check("the guard is told the visitor's address, from the header Cloudflare sets", ask({ "cf-connecting-ip": "203.0.113.7" }) === "203.0.113.7", `peerAddress ${peer ? "gives " + JSON.stringify(ask({ "cf-connecting-ip": "203.0.113.7" })) : "is not set"}`);
      check("and never from a header a visitor can set", ask({ "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.9" }) === undefined, JSON.stringify(ask({ "x-forwarded-for": "198.51.100.9", "x-real-ip": "198.51.100.9" })));

      // The response screen reads a body to the end before handing it on. A live stream must not wait for that.
      let screened = 0;
      const stub = { screenResponse: async (r: Response) => { screened++; return r; } };
      const forever = () => new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"pct":0}\n')); } });
      const stream = new Response(forever(), { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
      const q = new Request("https://example.test/api/backups/sync-remote", { method: "POST" });
      const back = await Promise.race([m.screenPatchstackResponse(stream, q, stub), new Promise((r) => setTimeout(() => r("waited"), 300))]);
      check("a streamed NDJSON answer (the Sync button's progress) goes back at once, as it is, unscreened", back === stream && screened === 0, back === "waited" ? "it waited" : `${screened} screened`);
      const json = new Response('{"ok":true}', { headers: { "content-type": "application/json" } });
      const after = await m.screenPatchstackResponse(json, q, stub);
      check("control: an ordinary JSON answer is still screened", after === json && screened === 1, `${screened} screened`);
      check("control: with no guard, an answer comes back as it is", (await m.screenPatchstackResponse(json, q, null)) === json);
    } finally { console.warn = realWarn; console.log = realLog; delete g.__psCreate; }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

console.log("Which paths get the Access check and the session check (lib/middleware-scope.ts)");
{
  // The pattern ships in lib/middleware-scope.ts and is used from there, not retyped here.
  const { inAppScope } = (await import(pathToFileURL(SCOPE).href)) as typeof import("../lib/middleware-scope.ts");
  const runsFor = (path: string) => inAppScope(path);
  // What the scope must equal: the matcher the middleware had before Patchstack's guard
  // went in front, as Next itself compiled it. A change to the scope that
  // differs from it on any path below fails, so the checks cannot quietly lose a path.
  const pattern = "/((?!_next/static|_next/image|[^/]*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$).*)";

  // Every file the app really serves by a name like these: all at the top level.
  const FILES = ["/icon-192.png", "/icon-512.png", "/icon-512-maskable.png", "/apple-icon.png", "/favicon.ico", "/icon.svg", "/site.webmanifest"];
  // The same endings, on paths that are routes.
  const ROUTES = ["/api/servers/5.png", "/api/sites/5.png", "/api/sso/requests/x.svg", "/sites/5.png", "/settings/security.ico", "/a/b.webmanifest"];
  // Names that only begin like a real file.
  const LOOKALIKES = ["/favicon.icoXYZ", "/manifest.webmanifest.x"];
  const PLAIN = ["/", "/login", "/api/whoami"];
  // So that list cannot fall behind: every file with such an ending in public/ (at any depth) and at the top of app/.
  const ENDING = /\.(?:svg|png|jpg|jpeg|gif|webp|ico|webmanifest)$/;
  const inPublic = (readdirSync(here("../public"), { recursive: true }) as string[]).map((f) => `/${f.split("\\").join("/")}`);
  const onDisk = [...inPublic, ...readdirSync(here("../app")).map((f) => `/${f}`)].filter((f) => ENDING.test(f)).sort();
  check("that is every such file the app has, and each one is at the top level", JSON.stringify(onDisk) === JSON.stringify([...FILES].sort()), `on disk: ${onDisk.join(" ")}`);
  const wronglyChecked = FILES.filter(runsFor);
  check("the icons and the manifest are let past: installing the app fetches them with no cookies", wronglyChecked.length === 0, `checked: ${wronglyChecked.join(" ")}`);
  for (const path of ROUTES) check(`${path} is checked: a path with a folder in it is no icon, whatever it ends in`, runsFor(path));
  for (const path of LOOKALIKES) check(`${path} is checked: a name that only begins like a real file is not that file`, runsFor(path));
  for (const path of PLAIN) check(`control: ${path} is checked`, runsFor(path));
  check("control: Next's own static files are let past", !runsFor("/_next/static/x.js"));

  // Next does not run the pattern as typed: it wraps it and compiles it. The same paths, through Next's own code.
  let viaNext: ((path: string) => boolean) | null = null, why = "";
  try {
    const next = createRequire(import.meta.url);
    const { getMiddlewareMatchers } = next("next/dist/build/analysis/get-page-static-info");
    const { getMiddlewareRouteMatcher } = next("next/dist/shared/lib/router/utils/middleware-route-matcher");
    const matches = getMiddlewareRouteMatcher(getMiddlewareMatchers([pattern], {}));
    viaNext = (path) => matches(path, { headers: {} }, {});
  } catch (e) { why = (e as Error).message.split("\n")[0]; }
  const all = [...FILES, ...ROUTES, ...LOOKALIKES, ...PLAIN, "/_next/static/x.js", "/_next/image", "/_next/static", "/_next/staticx/a.js", "/sites/5", "/api/sso/requests/5", "/a.png/b", "/.png", "/x.PNG"];
  const differs = viaNext ? all.filter((path) => viaNext!(path) !== runsFor(path)) : all;
  check(`the scope gives the old matcher's answer, as Next compiled it, for all ${all.length} paths`, differs.length === 0, viaNext ? `differs for: ${differs.join(" ")}` : `Next's matcher could not be loaded: ${why}`);
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
