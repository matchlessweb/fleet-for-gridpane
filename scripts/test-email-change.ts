/**
 * Checks for lib/account/email-change.ts.   npm run account:test
 *
 * Every "this is allowed" sits beside controls that must not be. With
 * --controls the same checks are run against broken copies of the file, one
 * mistake each, and every copy has to fail: a test that cannot fail proves
 * nothing.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { KeyFetcher } from "../lib/sso/access-jwt.ts";

type Lib = typeof import("../lib/account/email-change.ts");
const SOURCE = new URL("../lib/account/email-change.ts", import.meta.url);

const TEAM = "team.example.com";
const AUD = "a".repeat(64);
const NOW = 1_800_000_000;
const USER = "11111111-2222-3333-4444-555555555555";
const HASH = "ab12".repeat(14); // 56 characters, the shape the database mails

const b64u = (bytes: Uint8Array | string) => Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");
async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } };
}
type Key = Awaited<ReturnType<typeof makeKey>>;
async function sign(key: Key, claims: Record<string, unknown>) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const team = await makeKey("key-1");
const stranger = await makeKey("key-1");
const fetchKeys: KeyFetcher = async () => [team.jwk] as never;
const accessToken = await sign(team, { iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", sub: "s", exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, type: "app" });
const forged = await sign(stranger, { iss: `https://${TEAM}`, aud: [AUD], email: "owner@example.com", sub: "s", exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, type: "app" });

const aal = (methods: { method: string; timestamp: number }[]) => ({ currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: methods });

/** A stand-in database: records what it was asked and answers from a script. */
function fakeServer(answers: Record<string, { status: number; json: unknown } | "throw">) {
  const calls: { method: string; path: string; auth: string | null; body: unknown }[] = [];
  return {
    calls,
    server: {
      url: "https://db.example.com",
      anonKey: "anon",
      fetch: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
        const path = new URL(url).pathname;
        calls.push({ method: init.method, path: path + new URL(url).search, auth: init.headers.Authorization ?? null, body: init.body ? JSON.parse(init.body) : null });
        const a = answers[`${init.method} ${path}`];
        if (a === "throw" || !a) throw new Error("network");
        return { ok: a.status >= 200 && a.status < 300, status: a.status, json: async () => a.json };
      },
    },
  };
}

async function suite(lib: Lib, quiet: boolean) {
  let ran = 0;
  let failed = 0;
  const say = (s: string) => { if (!quiet) console.log(s); };
  const check = (name: string, got: unknown, want: unknown) => {
    ran++;
    const ok = JSON.stringify(got) === JSON.stringify(want);
    if (!ok) failed++;
    say(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
  };

  say("Addresses:");
  check("a plain address", lib.cleanEmail("owner@example.com"), "owner@example.com");
  check("spaces and capitals are tidied", lib.cleanEmail("  Owner.Name+fleet@Mail.Example.CO.UK "), "owner.name+fleet@mail.example.co.uk");
  for (const [why, bad] of [["no @ at all", "owner.example.com"], ["nothing before the @", "@example.com"], ["no domain dot", "owner@example"], ["a space", "own er@example.com"], ["two @", "a@b@example.com"], ["leading dot", ".a@example.com"], ["empty label", "a@example..com"], ["a number for the ending", "a@example.c0m"], ["not text", 42], ["too long", `${"a".repeat(250)}@example.com`], ["a header smuggled in", "a@example.com\nbcc: x@example.com"]] as const) {
    check(`control: ${why}`, lib.cleanEmail(bad), null);
  }

  say("Who may start a change:");
  const base = { user: { id: USER, email: "Old@Example.com" }, aal: aal([{ method: "passkey", timestamp: NOW - 120 }]), factors: [{ factor_type: "totp", status: "verified" }] as { factor_type: string; status: string }[] | null, accessJwt: null as string | null, env: {}, newEmail: "New@Example.com", now: NOW, fetchKeys };
  const gate = async (over: Record<string, unknown>) => {
    const r = await lib.checkEmailChange({ ...base, ...over } as never);
    return r.ok ? `ok ${r.next}` : `${r.reply.status} ${r.reply.body.reason}${r.reply.body.stepUp ? " (ask for the passkey)" : ""}`;
  };
  check("a passkey two minutes ago, no Cloudflare Access in use", await lib.checkEmailChange(base), { ok: true, userId: USER, current: "old@example.com", next: "new@example.com", method: "passkey", factorAgeSeconds: 120 });
  check("a password plus a code counts too", await gate({ aal: aal([{ method: "password", timestamp: NOW - 300 }, { method: "totp", timestamp: NOW - 290 }]) }), "ok new@example.com");
  check("control: signed out", await gate({ user: null }), "401 signed-out");
  check("control: not an address", await gate({ newEmail: "new@example" }), "400 bad-address");
  check("control: the address the account already has", await gate({ newEmail: " OLD@example.com " }), "400 same-address");
  check("control: a password-only session", await gate({ aal: aal([{ method: "password", timestamp: NOW - 5 }]) }), "403 no-strong-factor (ask for the passkey)");
  check("control: a passkey eleven minutes ago", await gate({ aal: aal([{ method: "passkey", timestamp: NOW - 11 * 60 }]) }), "403 strong-factor-too-old (ask for the passkey)");
  check("ten minutes exactly is still fresh", await gate({ aal: aal([{ method: "passkey", timestamp: NOW - 600 }]) }), "ok new@example.com");
  check("control: no session detail at all", await gate({ aal: null }), "403 no-strong-factor (ask for the passkey)");
  check("control: a passkey, on an account with no authenticator app", await gate({ factors: [] }), "403 no-authenticator");
  check("control: an authenticator app started and never confirmed", await gate({ factors: [{ factor_type: "totp", status: "unverified" }] }), "403 no-authenticator");
  check("control: a security key is not an authenticator app", await gate({ factors: [{ factor_type: "webauthn", status: "verified" }] }), "403 no-authenticator");
  check("control: no list of factors at all", await gate({ factors: null }), "403 no-authenticator");
  check("an authenticator app among other factors counts", await gate({ factors: [{ factor_type: "webauthn", status: "verified" }, { factor_type: "totp", status: "verified" }] }), "ok new@example.com");
  check("it is not something a passkey prompt can fix, so the page is not told to ask for one", await (async () => { const r = await lib.checkEmailChange({ ...base, factors: [] }); return r.ok ? "let through" : r.reply.body.stepUp; })(), false);
  const env = { CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
  check("with Cloudflare Access in use, a real Access token passes", await gate({ env, accessJwt: accessToken }), "ok new@example.com");
  check("control: Access in use, no token on the request", await gate({ env }), "403 access-missing");
  check("control: Access in use, a forged token", await gate({ env, accessJwt: forged }), "403 access-bad-signature");
  check("control: only half the Access settings", await gate({ env: { CF_ACCESS_TEAM_DOMAIN: TEAM }, accessJwt: accessToken }), "503 access-not-configured");
  check("a bad address is refused before anything else is read", await gate({ newEmail: "nope", env, accessJwt: "garbage" }), "400 bad-address");

  say("Starting the change:");
  const sent = fakeServer({ "PUT /auth/v1/user": { status: 200, json: { id: USER, email: "old@example.com", new_email: "new@example.com" } } });
  check("the link is mailed, the account keeps its address", await lib.startEmailChange(sent.server, "user-token", "new@example.com", "https://fleet.example.com/settings/profile"), { status: 200, body: { state: "sent", ok: true, email: "new@example.com" } });
  check("it was asked as the user, with only the new address", sent.calls, [{ method: "PUT", path: "/auth/v1/user?redirect_to=https%3A%2F%2Ffleet.example.com%2Fsettings%2Fprofile", auth: "Bearer user-token", body: { email: "new@example.com" } }]);
  const start = async (status: number, json: unknown) => { const r = await lib.startEmailChange(fakeServer({ "PUT /auth/v1/user": { status, json } }).server, "t", "new@example.com", "https://f.example.com/"); return `${r.status} ${r.body.state} ${r.body.reason ?? ""}`.trim(); };
  check("an account with no address yet is changed at once", await start(200, { id: USER, email: "new@example.com" }), "200 changed");
  check("control: the address belongs to someone else", await start(422, { code: 422, error_code: "email_exists", msg: "x" }), "409 refused address-taken");
  check("control: a link was sent a moment ago", await start(429, { code: 429, error_code: "over_email_send_rate_limit", msg: "x" }), "429 refused too-many");
  check("control: the database wants an authenticator code", await start(401, { code: 401, error_code: "insufficient_aal", msg: "x" }), "409 refused needs-code");
  const wantsCode = await lib.startEmailChange(fakeServer({ "PUT /auth/v1/user": { status: 401, json: { code: 401, error_code: "insufficient_aal", msg: "x" } } }).server, "t", "new@example.com", "https://f.example.com/", "old@example.com");
  check("and the reply tells the page to ask for the code, without telling anyone to sign out", [wantsCode.body.needsCode, wantsCode.body.stepUp, /sign out/i.test(String(wantsCode.body.message))], [true, false, false]);

  say("A refusal says which address it is about:");
  const refusal = async (json: unknown, current: string, next = "new@example.com") => { const r = await lib.startEmailChange(fakeServer({ "PUT /auth/v1/user": { status: 400, json } }).server, "t", next, "https://f.example.com/", current); return { line: `${r.status} ${r.body.reason}`, message: String(r.body.message) }; };
  const aboutCurrent = await refusal({ code: 400, error_code: "email_address_invalid", msg: 'Email address "admin@example.com" is invalid' }, "admin@example.com", "owner@not-reserved.dev");
  check("the database names the current address: Fleet says it is the current one", aboutCurrent.line, "409 current-address-unusable");
  check("and the message names it and points at the server-side step", [aboutCurrent.message.includes("admin@example.com"), aboutCurrent.message.includes("docs/sign-in-email.md"), aboutCurrent.message.includes("owner@not-reserved.dev")], [true, true, false]);
  const aboutNew = await refusal({ code: 400, error_code: "email_address_invalid", msg: 'Email address "owner@not-reserved.dev" is invalid' }, "admin@example.com", "owner@not-reserved.dev");
  check("control: the database names the new address: it is the new one, whatever the current one is", aboutNew.line, "400 bad-address");
  check("and the message names the new address", [aboutNew.message.includes("owner@not-reserved.dev"), aboutNew.message.includes("admin@example.com")], [true, false]);
  check("no address named, the current one on a domain that never gets mail: the current one", (await refusal({ code: 400, error_code: "email_address_invalid", msg: "Email address is invalid" }, "admin@example.com", "owner@not-reserved.dev")).line, "409 current-address-unusable");
  check("control: no address named and both on such a domain: Fleet does not guess", (await refusal({ code: 400, error_code: "email_address_invalid", msg: "Email address is invalid" }, "admin@example.com", "new@example.com")).line, "400 bad-address");
  check("control: no address named and the current one is ordinary: Fleet does not guess", (await refusal({ code: 400, error_code: "email_address_invalid", msg: "Email address is invalid" }, "owner@not-reserved.dev", "other@not-reserved.dev")).line, "400 bad-address");
  check("control: a different kind of refusal with no address named is never blamed on the current one", (await refusal({ code: 400, error_code: "validation_failed", msg: "Unable to validate" }, "admin@example.com", "owner@not-reserved.dev")).line, "400 bad-address");
  check("control: the current address named inside a longer one is not the current address", lib.addressAtFault({ msg: 'email address "bob.old@example.com" is invalid' }, "old@example.com", "new@example.com"), null);
  check("control: nor at the head of a longer one", lib.addressAtFault({ msg: 'email address "old@example.com.example" is invalid' }, "old@example.com", "new@example.com"), null);
  check("an address at the end of a sentence still counts", lib.addressAtFault({ msg: "cannot send to old@example.com." }, "old@example.com", "new@example.com"), "current");
  check("control: no current address on record: nothing to blame", lib.addressAtFault({ msg: "Email address is invalid" }, "", "owner@not-reserved.dev", true), null);
  check("control: no email sender is set up", await start(400, { code: 400, error_code: "email_address_not_authorized", msg: "x" }), "409 refused no-sender");
  check("control: the session ran out", await start(401, { code: 401, error_code: "bad_jwt", msg: "x" }), "401 failed signed-out");
  check("control: any other refusal says nothing was changed", await start(500, { code: 500, error_code: "unexpected_failure" }), "502 failed database");
  check("control: the database cannot be reached", await (async () => { const r = await lib.startEmailChange(fakeServer({ "PUT /auth/v1/user": "throw" }).server, "t", "new@example.com", "https://f.example.com/"); return `${r.status} ${r.body.reason}`; })(), "502 unreachable");

  say("Confirming the link:");
  const done = fakeServer({ "POST /auth/v1/verify": { status: 200, json: { access_token: "fresh-session", refresh_token: "r", user: { id: USER, email: "New@example.com" } } }, "POST /auth/v1/logout": { status: 204, json: null } });
  check("the address is changed", await lib.confirmEmailChange(done.server, HASH, USER), { status: 200, body: { state: "changed", ok: true, email: "new@example.com" } });
  check("the database got only the link and its kind, and the session it made was closed at once", done.calls, [
    { method: "POST", path: "/auth/v1/verify", auth: null, body: { type: "email_change", token_hash: HASH } },
    { method: "POST", path: "/auth/v1/logout?scope=local", auth: "Bearer fresh-session", body: null },
  ]);
  check("the answer never carries the session", JSON.stringify(await lib.confirmEmailChange(fakeServer({ "POST /auth/v1/verify": { status: 200, json: { access_token: "fresh-session", refresh_token: "fresh-refresh", user: { id: USER, email: "new@example.com" } } }, "POST /auth/v1/logout": { status: 204, json: null } }).server, HASH, USER)).includes("fresh"), false);
  const half = fakeServer({ "POST /auth/v1/verify": { status: 200, json: { msg: "Confirmation link accepted. Please proceed to confirm link sent to the other email", code: "200" } } });
  check("the first of two addresses: one step left", (await lib.confirmEmailChange(half.server, HASH, USER)).body.state, "half");
  check("nothing to close after the first of two", half.calls.length, 1);
  const other = fakeServer({ "POST /auth/v1/verify": { status: 200, json: { access_token: "fresh-session", user: { id: "99999999-2222-3333-4444-555555555555", email: "x@example.com" } } }, "POST /auth/v1/logout": { status: 204, json: null } });
  check("control: a link for a different account is not reported as yours", await (async () => { const r = await lib.confirmEmailChange(other.server, HASH, USER); return `${r.status} ${r.body.reason} ${"email" in r.body}`; })(), "409 other-account false");
  check("and its session is closed as well", other.calls[1]?.path, "/auth/v1/logout?scope=local");
  const confirm = async (status: number, json: unknown, hash: unknown = HASH) => { const f = fakeServer({ "POST /auth/v1/verify": { status, json } }); const r = await lib.confirmEmailChange(f.server, hash, USER); return `${r.status} ${r.body.reason} calls:${f.calls.length}`; };
  check("control: an expired or used link", await confirm(403, { code: 403, error_code: "otp_expired", msg: "Email link is invalid or has expired" }), "409 link-used calls:1");
  check("control: the database is down", await confirm(500, {}), "502 database calls:1");
  check("control: no link at all is never sent to the database", await confirm(200, {}, ""), "400 bad-link calls:0");
  check("control: a link with odd characters is never sent to the database", await confirm(200, {}, `${HASH}&type=recovery`), "400 bad-link calls:0");
  check("control: not text", await confirm(200, {}, { $ne: 1 }), "400 bad-link calls:0");
  check("control: the database cannot be reached", await (async () => { const r = await lib.confirmEmailChange(fakeServer({ "POST /auth/v1/verify": "throw" }).server, HASH, USER); return `${r.status} ${r.body.reason}`; })(), "502 unreachable");

  return { ran, failed };
}

/** One mistake each. Every one must make at least one check fail. */
const MISTAKES: [string, string, string][] = [
  ["any text is taken as an address", "if (at < 1 || email.indexOf(\"@\") !== at) return null;", ""],
  ["a line break in an address is let through", "/^[a-z0-9!#$%&*+/=?^_`{|}~.\\x27-]+$/.test(local)", "/^[^@]+$/.test(local)"],
  ["a signed-out caller is let through", "if (!input.user?.id) return", "if (false) return"],
  ["the passkey is never asked for", "if (!factor.ok) {", "if (false) {"],
  ["an hour-old passkey still counts", "EMAIL_CHANGE_FACTOR_MAX_AGE_SECONDS = 10 * 60", "EMAIL_CHANGE_FACTOR_MAX_AGE_SECONDS = 60 * 60"],
  ["an account with no authenticator app may change its email", "if (!hasAuthenticator(input.factors)) {", "if (false) {"],
  ["Cloudflare Access is never checked", "if (usesAccess(input.env)) {", "if (false) {"],
  ["half-set Access settings are waved through", "if (access.reason === \"not-configured\") return { ok: false, reply: refused(503,", "if (false) return { ok: false, reply: refused(503,"],
  ["the same address is accepted", "if (next === current) return", "if (false) return"],
  ["a mailed link is reported as already changed", "state: now === next ? \"changed\" : \"sent\"", "state: \"changed\""],
  ["a taken address reads as a plain failure", "case \"email_exists\":", "case \"never\":"],
  ["the change is asked with the wrong key", "Authorization: `Bearer ${accessToken}`, \"Content-Type\"", "Authorization: `Bearer ${server.anonKey}`, \"Content-Type\""],
  ["the new session is left open", ".fetch(`${server.url}/auth/v1/logout?scope=local`", ".fetch(`${server.url}/auth/v1/health`"],
  ["the new session is handed back", "body: { state: \"changed\", ok: true, email: typeof user.email", "body: { state: \"changed\", ok: true, session, email: typeof user.email"],
  ["another account’s link is reported as yours", "if (user.id !== callerId) return", "if (false) return"],
  ["the first of two addresses reads as done", "if (!session) {", "if (false) {"],
  ["a refusal about the current address is blamed on the new one", "if (fault === \"current\") return refused(409", "if (false) return refused(409"],
  ["an address is matched inside a longer one", "if (/[a-z0-9._%+-]/.test(before)) continue;", ""],
  ["an address is matched at the head of a longer one", "if (/[a-z0-9-]/.test(after) || (after === \".\" && /[a-z0-9]/.test(afterNext))) continue;", ""],
  ["a vague refusal always blames a placeholder current address", " && !NEVER_DELIVERED.test(domainOf(next))", ""],
  ["a vague refusal of another kind is blamed on the current address", "errorCode(json) === \"email_address_invalid\");", "true);"],
  ["a placeholder current address is never suspected", "if (guess && current && NEVER_DELIVERED", "if (false && guess && current && NEVER_DELIVERED"],
  ["the authenticator reply does not ask the page for a code", "needsCode: true", "needsCode: false"],
  ["the authenticator reply still tells people to sign out", "so the database wants its code before an email change.\", stepUp: false", "so the database wants its code before an email change. Sign out, sign in with your password and code.\", stepUp: false"],
  ["any text is sent to the database as a link", "/^[A-Za-z0-9_-]{16,200}$/.test(raw)", "raw.length >= 0"],
  ["an expired link reads as a database fault", "if (errorCode(json) === \"otp_expired\" || res.status === 403) return", "if (false) return"],
];

const real = await import(SOURCE.href);
if (!process.argv.includes("--controls")) {
  const { ran, failed } = await suite(real, false);
  console.log(`\n${ran} checks, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

const text = readFileSync(SOURCE, "utf8")
  .replace("\"../sso/access-jwt.ts\"", JSON.stringify(new URL("../lib/sso/access-jwt.ts", import.meta.url).href))
  .replace("\"../sso/gate.ts\"", JSON.stringify(new URL("../lib/sso/gate.ts", import.meta.url).href))
  .replace("\"../access-gate.ts\"", JSON.stringify(new URL("../lib/access-gate.ts", import.meta.url).href))
  .replace("\"../auth-assurance.ts\"", JSON.stringify(new URL("../lib/auth-assurance.ts", import.meta.url).href));
// A copy that will not load proves nothing about the checks: it is a miss, never a catch.
if (/from "\.\.?\//.test(text)) { console.log("STOP: the copy still imports a file by a path next to it, so no copy would load. Add it to the list above."); process.exit(1); }
const dir = mkdtempSync(join(tmpdir(), "fleet-email-change-"));
let caught = 0;
let missed = 0;
console.log("Unbroken file first:");
const clean = await suite(real, true);
console.log(`  ${clean.failed === 0 ? "passes" : "FAILS"}  (${clean.ran} checks, ${clean.failed} failed)`);
console.log("Broken copies:");
for (const [i, [label, from, to]] of MISTAKES.entries()) {
  if (!text.includes(from)) { missed++; console.log(`  STALE   ${label}  (the line to break is no longer in the file)`); continue; }
  const file = join(dir, `broken-${i}.ts`);
  writeFileSync(file, text.replace(from, to));
  let result: { ran: number; failed: number };
  let copy: Lib;
  try { copy = await import(pathToFileURL(file).href); } catch (e) { missed++; console.log(`  MISSED  ${label}  (the broken copy would not load: ${String((e as Error).message).slice(0, 80)})`); continue; }
  try { result = await suite(copy, true); } catch { result = { ran: 0, failed: 1 }; }
  if (result.failed > 0) caught++; else missed++;
  console.log(`  ${result.failed > 0 ? "caught" : "MISSED"}  ${label}  (${result.failed} checks failed)`);
}
rmSync(dir, { recursive: true, force: true });
console.log(`\n${MISTAKES.length} broken copies: ${caught} caught, ${missed} missed`);
process.exit(clean.failed === 0 && missed === 0 ? 0 : 1);
