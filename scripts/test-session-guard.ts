/**
 * Checks for lib/auth-assurance.ts: which sessions may use the app, and what a
 * route that acts with the service's key asks of its caller.   npm run access:test
 *   --controls   break a copy of the file one way at a time; each break must be caught
 * Every "this is allowed" sits beside the same request with one thing wrong.
 * GUARD_LIB points the checks at another copy of the file (the controls use it).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = process.env.GUARD_LIB || fileURLToPath(new URL("../lib/auth-assurance.ts", import.meta.url));

const BREAKS: [string, (s: string) => string][] = [
  ["no answer about the session counts as a yes", (s) => s.replace("if (!aal) return false;", "if (!aal) return true;")],
  ["any assurance level is enough", (s) => s.replace('aal.currentLevel === "aal2" ||', 'aal.currentLevel !== null ||')],
  ["a password counts as a passkey", (s) => s.replace('entry.method : null) === "passkey"', 'entry.method : null) === "password"')],
  ["an account with no second factor is let in again", (s) => s.replace('return aal.currentLevel === "aal2" || hasPasskey', 'return aal.nextLevel !== "aal2" || aal.currentLevel === "aal2" || hasPasskey')],
  ["a route lets a signed-in session through without asking if it is strong", (s) => s.replace("if (!c.signedIn || !mayUseApp(c.aal, c.factors))", "if (!c.signedIn)")],
  ["a route lets a signed-out caller through", (s) => s.replace("if (!c.signedIn || !mayUseApp(c.aal, c.factors))", "if (c.signedIn && !mayUseApp(c.aal, c.factors))")],
  ["a route asks only for a strong session, not for the authenticator app", (s) => s.replace("if (!c.signedIn || !mayUseApp(c.aal, c.factors))", "if (!c.signedIn || !sessionIsStrong(c.aal))")],
  ["an account with no authenticator app may use the app", (s) => s.replace("return sessionIsStrong(aal) && hasAuthenticator(factors);", "return sessionIsStrong(aal);")],
  ["an account with the app may use it on a password alone", (s) => s.replace("return sessionIsStrong(aal) && hasAuthenticator(factors);", "return sessionIsStrong(aal) || hasAuthenticator(factors);")],
  ["an authenticator app whose set-up was never confirmed counts", (s) => s.replace('f.factor_type === "totp" && f.status === "verified"', 'f.factor_type === "totp"')],
  ["any confirmed factor counts as an authenticator app", (s) => s.replace('f.factor_type === "totp" && f.status === "verified"', 'f.status === "verified"')],
  ["a typed address may ask for a change", (s) => s.replace('if (source.secFetchSite && source.secFetchSite !== "same-origin") return false;', 'if (source.secFetchSite && source.secFetchSite !== "same-origin" && source.secFetchSite !== "none") return false;')],
  ["a sibling address on the same domain may ask for a change", (s) => s.replace('if (source.secFetchSite && source.secFetchSite !== "same-origin") return false;', 'if (source.secFetchSite && source.secFetchSite === "cross-site") return false;')],
  ["a change needs no Origin", (s) => s.replace("if (!source.origin || !source.host) return false;", "if (!source.origin || !source.host) return true;")],
  ["any Origin will do", (s) => s.replace("return new URL(source.origin).host === source.host;", "return !!new URL(source.origin).host;")],
  ["a request another site's page made passes the one test", (s) => s.replace('if (source.secFetchSite && source.secFetchSite !== "same-origin") return false;', "")],
  ["a route no longer asks the one test before a change", (s) => s.replace("return fromOwnPages(c) ? null : elsewhere;", "return null;")],
  ["a link on another site may start a read", (s) => s.replace('if (reading) return c.secFetchSite && c.secFetchSite !== "same-origin" && c.secFetchSite !== "none" ? elsewhere : null;', "if (reading) return null;")],
  ["a read from a typed address is refused", (s) => s.replace(' && c.secFetchSite !== "none" ? elsewhere : null;', " ? elsewhere : null;")],
];

if (process.argv.includes("--controls")) {
  const src = readFileSync(LIB, "utf8"), dir = mkdtempSync(join(tmpdir(), "guard-controls-"));
  let caught = 0;
  for (const [name, edit] of BREAKS) {
    const broken = edit(src);
    if (broken === src) { console.log(`  MISSED  ${name}  (the break changed nothing: fix this control)`); continue; }
    const file = join(dir, "auth-assurance.ts"); writeFileSync(file, broken);
    let out = "", rc = 0;
    try { out = execFileSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, GUARD_LIB: file }, encoding: "utf8" }); } catch (e) { rc = (e as { status: number }).status; out = String((e as { stdout: string }).stdout || ""); }
    const fails = (out.match(/^  FAIL/gm) || []).length;
    if (rc !== 0 && fails > 0) { caught++; console.log(`  caught  ${name}  (${fails} failing)`); } else console.log(`  MISSED  ${name}  (exit ${rc})`);
  }
  console.log(`${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const { sessionIsStrong, hasAuthenticator, mayUseApp, fromOwnPages, judgeCaller } = (await import(pathToFileURL(LIB).href)) as typeof import("../lib/auth-assurance.ts");

let ran = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const pw = { method: "password", timestamp: 1 }, key = { method: "passkey", timestamp: 1 }, totp = { method: "totp", timestamp: 2 };
const s = (currentLevel: string | null, methods?: unknown, nextLevel: string | null = currentLevel) => ({ currentLevel, nextLevel, currentAuthenticationMethods: methods as never });

console.log("which sessions may use the app");
check("a password plus a code from the app (level 2)", sessionIsStrong(s("aal2", [pw, totp])), true);
check("a passkey sign-in", sessionIsStrong(s("aal1", [key])), true);
check("a passkey sign-in on an account that also has an authenticator app", sessionIsStrong(s("aal1", [key], "aal2")), true);
check("a passkey, methods listed as plain words", sessionIsStrong(s("aal1", ["passkey"])), true);
check("a password only, authenticator app set up: the code is still owed", sessionIsStrong(s("aal1", [pw], "aal2")), false);
check("a password only, no second factor on the account: not let in either", sessionIsStrong(s("aal1", [pw], "aal1")), false);
check("an emailed link or code", sessionIsStrong(s("aal1", [{ method: "otp", timestamp: 1 }])), false);
check("a method that only resembles a passkey", sessionIsStrong(s("aal1", [{ method: "passkey2", timestamp: 1 }, "PASSKEY"])), false);
check("no answer about the session", sessionIsStrong(null), false);
check("no level and no methods", sessionIsStrong(s(null)), false);
check("methods that are not a list", sessionIsStrong(s("aal1", "passkey")), false);
check("a list of things that are not methods", sessionIsStrong(s("aal1", [null, 5, {}, { method: null }])), false);

console.log("which accounts may use the app: a strong session, on an account that has an authenticator app");
const app = { factor_type: "totp", status: "verified" }, half = { factor_type: "totp", status: "unverified" };
check("an authenticator app that was set up and confirmed", hasAuthenticator([app]), true);
check("one confirmed among others that are not", hasAuthenticator([half, { factor_type: "phone", status: "verified" }, app]), true);
check("an authenticator app whose set-up was never confirmed", hasAuthenticator([half]), false);
check("a confirmed factor that is not an authenticator app", hasAuthenticator([{ factor_type: "phone", status: "verified" }, { factor_type: "webauthn", status: "verified" }]), false);
check("no factors, and no answer about them", [hasAuthenticator([]), hasAuthenticator(null), hasAuthenticator(undefined)], [false, false, false]);
check("factors that are not a list, or not factors", [hasAuthenticator("totp" as never), hasAuthenticator([null, 5, {}, { factor_type: "totp" }, { status: "verified" }] as never)], [false, false]);
check("a code from the app, on an account with the app", mayUseApp(s("aal2", [pw, totp]), [app]), true);
check("a passkey sign-in, on an account with the app", mayUseApp(s("aal1", [key], "aal2"), [app]), true);
check("a passkey sign-in, on an account with no authenticator app: it has to set one up first", mayUseApp(s("aal1", [key]), []), false);
check("a passkey sign-in, on an account whose app was never confirmed", mayUseApp(s("aal1", [key]), [half]), false);
check("a password alone, on an account with the app: the code is still owed", mayUseApp(s("aal1", [pw], "aal2"), [app]), false);
check("a password alone, on an account with nothing set up", mayUseApp(s("aal1", [pw]), []), false);
check("a strong session, and no answer about the account's factors", [mayUseApp(s("aal2", [pw, totp]), null), mayUseApp(s("aal2", [pw, totp]), undefined)], [false, false]);
check("no answer about the session, on an account with the app", mayUseApp(null, [app]), false);

console.log("what a route asks of its caller");
const HOST = "fleet.example.com";
const strong = s("aal2", [pw, totp]), weak = s("aal1", [pw]);
const ask = (over: Record<string, unknown> = {}) => judgeCaller({ method: "PATCH", secFetchSite: "same-origin", origin: `https://${HOST}`, host: HOST, signedIn: true, aal: strong, factors: [app], ...over } as never)?.status ?? "through";
check("a strong session, from this site's own page", ask(), "through");
check("the same from a passkey session", ask({ aal: s("aal1", [key]) }), "through");
check("a passkey session on an account with no authenticator app", ask({ aal: s("aal1", [key]), factors: [] }), 401);
check("a strong session when the account's factors are not known", ask({ factors: undefined }), 401);
check("signed out", ask({ signedIn: false, aal: null }), 401);
check("signed out, however strong the claim that came with it", ask({ signedIn: false }), 401);
check("a password-only session", ask({ aal: weak }), 401);
check("a session nothing is known about", ask({ aal: null }), 401);
check("a change asked for by another site's page", ask({ secFetchSite: "cross-site", origin: "https://elsewhere.example" }), 403);
check("a change from a sibling address on the same domain", ask({ secFetchSite: "same-site", origin: "https://other.example.com" }), 403);
check("a change from a typed address", ask({ secFetchSite: "none" }), 403);
check("a change with no Origin", ask({ origin: null }), 403);
check("a change with no Host", ask({ host: null }), 403);
check("a change whose Origin is another site, from a browser too old to say where it came from", ask({ secFetchSite: null, origin: "https://elsewhere.example" }), 403);
check("a change whose Origin is not an address", ask({ origin: "null" }), 403);
check("a change from this site, from a browser too old to say where it came from", ask({ secFetchSite: null }), "through");
check("a POST is held to the same", [ask({ method: "POST" }), ask({ method: "POST", secFetchSite: "cross-site" })], ["through", 403]);
check("a DELETE is held to the same", ask({ method: "DELETE", origin: null }), 403);
check("a read from this site's own page (a browser sends no Origin with it)", ask({ method: "GET", origin: null }), "through");
check("a read from a typed address", ask({ method: "GET", secFetchSite: "none", origin: null }), "through");
check("a read started by a link on another site", ask({ method: "GET", secFetchSite: "cross-site", origin: null }), 403);
check("a read by a password-only session", ask({ method: "GET", origin: null, aal: weak }), 401);
check("a refusal for a weak session comes before any word about where it came from", ask({ aal: weak, secFetchSite: "cross-site" }), 401);

console.log("the one test for a request that changes something (the sign-on and account routes ask it too)");
const own = (over: Record<string, unknown> = {}) => fromOwnPages({ secFetchSite: "same-origin", origin: `https://${HOST}`, host: HOST, ...over } as never);
check("this site's own page", own(), true);
check("this site's own page, from a browser too old to say where it came from", own({ secFetchSite: null }), true);
check("another site's page", own({ secFetchSite: "cross-site", origin: "https://elsewhere.example" }), false);
check("a sibling address on the same domain", own({ secFetchSite: "same-site", origin: "https://other.example.com" }), false);
check("a typed address", own({ secFetchSite: "none" }), false);
check("no Origin, no Host, an Origin that is not an address", [own({ origin: null }), own({ host: null }), own({ origin: "null" })], [false, false, false]);
check("an Origin on another port", own({ origin: `https://${HOST}:8443` }), false);
// The routes under app/api/sso and app/api/account reach it through fromFleetItself: that must hold no test of its own.
const route = readFileSync(fileURLToPath(new URL("../lib/sso/route.ts", import.meta.url)), "utf8");
const body = route.slice(route.indexOf("export function fromFleetItself"), route.indexOf("export const NOT_FLEET"));
check("fromFleetItself in lib/sso/route.ts hands the three headers to this one test and decides nothing itself",
  [/return fromOwnPages\(\{/.test(body), ["sec-fetch-site", "origin", "host"].every((h) => body.includes(`request.headers.get("${h}")`)), /new URL|===|!==|\bif\b/.test(body)], [true, true, false]);

console.log(`session guard: ${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
