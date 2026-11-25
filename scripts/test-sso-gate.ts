/**
 * Checks for lib/sso/access-jwt.ts and lib/sso/gate.ts.   npm run sso:test
 * Every "this is allowed" sits beside controls that must not be: the same
 * request with one thing wrong.
 */
import { clearAccessKeyCache, verifyAccessJwt, type KeyFetcher } from "../lib/sso/access-jwt.ts";
import { forPage } from "../lib/sso/service.ts";
import { allowedUserIds, checkSsoCaller, strongFactor, STRONG_FACTOR_MAX_AGE_SECONDS } from "../lib/sso/gate.ts";

let ran = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const TEAM = "team.example.com";
const AUD = "a".repeat(64);
const NOW = 1_800_000_000;
const USER = "11111111-2222-3333-4444-555555555555";

const b64u = (bytes: Uint8Array | string) =>
  Buffer.from(typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes).toString("base64url");

async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } };
}
type Key = Awaited<ReturnType<typeof makeKey>>;

async function sign(key: Key, claims: Record<string, unknown>, header: Record<string, unknown> = {}) {
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT", ...header }));
  const p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

const good = { iss: `https://${TEAM}`, aud: [AUD], email: "Owner@Example.com", sub: "user-sub-1", exp: NOW + 600, iat: NOW - 10, nbf: NOW - 10, type: "app" };

const team = await makeKey("key-1");
const stranger = await makeKey("key-1"); // same key id, a different key: what a forger would have
const rotated = await makeKey("key-2");

let fetches = 0;
const fetchKeys: KeyFetcher = async () => { fetches++; return [team.jwk]; };
const opts = { teamDomain: TEAM, audience: AUD, now: NOW, fetchKeys };
const reason = async (token: string | null, o: Partial<typeof opts> = {}) => {
  const r = await verifyAccessJwt(token, { ...opts, ...o });
  return r.ok ? "ok" : r.reason;
};

console.log("Cloudflare Access token:");
const token = await sign(team, good);
check("a real token is accepted, email lowercased", await verifyAccessJwt(token, opts), { ok: true, email: "owner@example.com", sub: "user-sub-1", expiresAt: NOW + 600 });
check("control: no token", await reason(null), "missing");
check("control: not three parts", await reason("abc.def"), "malformed");
check("control: signed by a different key with the same id", await reason(await sign(stranger, good)), "bad-signature");
check("control: claims changed after signing", await reason((() => { const [h, , s] = token.split("."); return `${h}.${b64u(JSON.stringify({ ...good, email: "attacker@example.com" }))}.${s}`; })()), "bad-signature");
check("control: algorithm 'none'", await reason(`${b64u(JSON.stringify({ alg: "none", kid: "key-1" }))}.${b64u(JSON.stringify(good))}.${b64u("x")}`), "wrong-algorithm");
check("control: HS256 (a shared-secret algorithm) is refused", await reason(await sign(team, good, { alg: "HS256" })), "wrong-algorithm");
check("control: issued for another application", await reason(await sign(team, { ...good, aud: ["b".repeat(64)] })), "wrong-audience");
check("an audience given as plain text also works", await reason(await sign(team, { ...good, aud: AUD })), "ok");
check("control: issued by another team", await reason(await sign(team, { ...good, iss: "https://other.example.com" })), "wrong-issuer");
check("control: expired two minutes ago", await reason(await sign(team, { ...good, exp: NOW - 120 })), "expired");
check("a token that expired 30 seconds ago is inside the clock allowance", await reason(await sign(team, { ...good, exp: NOW - 30 })), "ok");
check("control: not valid for another ten minutes", await reason(await sign(team, { ...good, nbf: NOW + 600 })), "not-yet-valid");
check("control: a service token (no email) is not a person", await reason(await sign(team, { ...good, email: undefined, common_name: "svc" })), "not-a-person");
check("control: no team domain set", await reason(token, { teamDomain: "" }), "not-configured");
check("control: no audience set", await reason(token, { audience: "" }), "not-configured");
check("control: team domain with a path in it", await reason(token, { teamDomain: "team.example.com/evil" }), "not-configured");

console.log("Cloudflare's keys:");
clearAccessKeyCache(); fetches = 0;
await verifyAccessJwt(token, opts); await verifyAccessJwt(token, opts);
check("the keys are fetched once and remembered", fetches, 1);
check("after ten minutes they are fetched again", (await verifyAccessJwt(token, { ...opts, now: NOW + 601 }), fetches), 2);
clearAccessKeyCache(); fetches = 0;
let served = [team.jwk];
const rotating: KeyFetcher = async () => { fetches++; return served; };
await verifyAccessJwt(token, { ...opts, fetchKeys: rotating });
served = [team.jwk, rotated.jwk];
check("a token signed with a newly published key is accepted after one more look", await reason(await sign(rotated, good), { fetchKeys: rotating }), "ok");
check("which took exactly one extra fetch", fetches, 2);
const nobody = await sign(await makeKey("nobody"), good);
check("control: a key id not held, straight after that look, is not looked up again: 'could not check', not 'no such key'", [await reason(nobody, { fetchKeys: rotating }), fetches], ["keys-unavailable", 2]);
check("control: a minute on Cloudflare is asked, and its answer is 'no such key'", [await reason(nobody, { fetchKeys: rotating, now: NOW + 61 }), fetches], ["unknown-key", 3]);
clearAccessKeyCache();
check("control: Cloudflare's keys cannot be fetched", await reason(token, { fetchKeys: async () => { throw new Error("down"); } }), "keys-unavailable");
clearAccessKeyCache();

console.log("Strong factor:");
const aal = (methods: unknown[], currentLevel = "aal1") => ({ currentLevel, nextLevel: "aal2", currentAuthenticationMethods: methods as never });
check("a passkey used an hour ago", strongFactor(aal([{ method: "passkey", timestamp: NOW - 3600 }]), NOW), { ok: true, method: "passkey", ageSeconds: 3600 });
check("a password plus a code", strongFactor(aal([{ method: "password", timestamp: NOW - 50 }, { method: "totp", timestamp: NOW - 40 }], "aal2"), NOW), { ok: true, method: "totp", ageSeconds: 40 });
check("control: a password alone", strongFactor(aal([{ method: "password", timestamp: NOW - 50 }]), NOW), { ok: false, reason: "no-strong-factor" });
check("control: a magic link", strongFactor(aal([{ method: "otp", timestamp: NOW - 50 }]), NOW), { ok: false, reason: "no-strong-factor" });
check("control: no session details at all", strongFactor(null, NOW), { ok: false, reason: "no-strong-factor" });
check("control: an account with no second factor enrolled (the rest of the app turns this away too)", strongFactor({ currentLevel: "aal1", nextLevel: "aal1", currentAuthenticationMethods: [{ method: "password", timestamp: NOW - 5 }] }, NOW), { ok: false, reason: "no-strong-factor" });
check("exactly 12 hours old still counts", strongFactor(aal([{ method: "passkey", timestamp: NOW - STRONG_FACTOR_MAX_AGE_SECONDS }]), NOW).ok, true);
check("control: one second past 12 hours", strongFactor(aal([{ method: "passkey", timestamp: NOW - STRONG_FACTOR_MAX_AGE_SECONDS - 1 }]), NOW), { ok: false, reason: "strong-factor-too-old", ageSeconds: STRONG_FACTOR_MAX_AGE_SECONDS + 1 });
check("a refreshed token does not make an old passkey new", strongFactor(aal([{ method: "passkey", timestamp: NOW - 50_000 }, { method: "token_refresh", timestamp: NOW - 5 }]), NOW).ok, false);
check("the newest strong sign-in is the one that counts", strongFactor(aal([{ method: "passkey", timestamp: NOW - 50_000 }, { method: "passkey", timestamp: NOW - 100 }]), NOW), { ok: true, method: "passkey", ageSeconds: 100 });
check("control: a strong method with no time on it", strongFactor(aal(["passkey"]), NOW), { ok: false, reason: "strong-factor-too-old" });
check("control: a sign-in dated an hour in the future", strongFactor(aal([{ method: "passkey", timestamp: NOW + 3600 }]), NOW).ok, false);
check("a time given in milliseconds is read correctly", strongFactor(aal([{ method: "passkey", timestamp: (NOW - 120) * 1000 }]), NOW), { ok: true, method: "passkey", ageSeconds: 120 });

console.log("Allow-list:");
check("commas, spaces and capitals", [...allowedUserIds(` ${USER.toUpperCase()},\n aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee `)], [USER, "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"]);
check("control: unset means nobody", allowedUserIds(undefined).size, 0);
check("control: a star or an email is not an id", allowedUserIds("*, owner@example.com").size, 0);

console.log("The whole gate:");
const env = { SSO_ALLOWED_USER_IDS: USER, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: AUD };
const strong = aal([{ method: "passkey", timestamp: NOW - 600 }]);
const call = { user: { id: USER, email: "Owner@Example.com" }, aal: strong, factors: [{ factor_type: "totp", status: "verified" }], accessJwt: token, env, now: NOW, fetchKeys };
const gate = async (over: Record<string, unknown>) => { const r = await checkSsoCaller({ ...call, ...over } as never); return r.ok ? "ok" : `${r.status} ${r.reason}${r.stepUp ? " (ask for the passkey)" : ""}`; };
check("everything in order", await checkSsoCaller(call), { ok: true, userId: USER, userEmail: "owner@example.com", accessEmail: "owner@example.com", method: "passkey", factorAgeSeconds: 600 });
check("control: signed out", await gate({ user: null }), "401 signed-out");
check("control: allow-list not set", await gate({ env: { ...env, SSO_ALLOWED_USER_IDS: "" } }), "503 not-configured");
check("control: a different signed-in user", await gate({ user: { id: "99999999-2222-3333-4444-555555555555" } }), "403 not-allowed");
check("control: no Access token on the request", await gate({ accessJwt: null }), "403 access-missing");
check("control: a forged Access token", await gate({ accessJwt: await sign(stranger, good) }), "403 access-bad-signature");
check("control: Access settings missing", await gate({ env: { ...env, CF_ACCESS_AUD: "" } }), "503 access-not-configured");
check("control: a passkey, on an account with no authenticator app", await gate({ factors: [] }), "403 no-authenticator");
check("control: an authenticator app started and never confirmed", await gate({ factors: [{ factor_type: "totp", status: "unverified" }] }), "403 no-authenticator");
check("control: a security key is not an authenticator app", await gate({ factors: [{ factor_type: "webauthn", status: "verified" }] }), "403 no-authenticator");
check("control: no list of factors at all", await gate({ factors: undefined }), "403 no-authenticator");
check("an authenticator app among other factors counts", await gate({ factors: [{ factor_type: "phone", status: "verified" }, { factor_type: "totp", status: "verified" }] }), "ok");
check("control: password-only session", await gate({ aal: aal([{ method: "password", timestamp: NOW - 5 }]) }), "403 no-strong-factor (ask for the passkey)");
check("control: passkey used 13 hours ago", await gate({ aal: aal([{ method: "passkey", timestamp: NOW - 13 * 3600 }]) }), "403 strong-factor-too-old (ask for the passkey)");
const unknownKid = await sign(await makeKey("key-7"), good);
check("control: an Access token naming a key Cloudflare does not publish", await gate({ accessJwt: unknownKid }), "403 access-unknown-key");
check("control: the same again within the minute is not looked up: 503 'try again', and still refused", await gate({ accessJwt: unknownKid }), "503 access-keys-unavailable");
const again = await checkSsoCaller({ ...call, accessJwt: unknownKid } as never);
check("and the message says to try again in a moment", again.ok ? "ok" : again.message, "Could not check with Cloudflare Access just now. Try again in a moment.");
check("a user not on the list is refused before the Access token is even read", await gate({ user: { id: "99999999-2222-3333-4444-555555555555" }, accessJwt: "garbage" }), "403 not-allowed");

console.log("What Fleet's own page gets back:");
const page = (status: number, body: Record<string, unknown>) => { const r = forPage({ status, body }); return `${r.status} ${JSON.stringify(r.body)}`; };
check("'confirm with your passkey' is a normal answer, body untouched", page(403, { state: "refused", stepUp: true, message: "m" }), '200 {"state":"refused","stepUp":true,"message":"m"}');
check("'not turned on for this site' is a normal answer", page(409, { state: "refused", reason: "not-enabled" }), '200 {"state":"refused","reason":"not-enabled"}');
check("'too many sign-ins' is a normal answer", page(429, { state: "refused", reason: "rate" }), '200 {"state":"refused","reason":"rate"}');
check("control: not on the list stays 403", page(403, { state: "refused", stepUp: false }), '403 {"state":"refused","stepUp":false}');
check("control: signed out stays 401", page(401, { state: "refused", stepUp: false }), '401 {"state":"refused","stepUp":false}');
check("control: a malformed request stays 400", page(400, { state: "refused" }), '400 {"state":"refused"}');
check("control: a database that cannot be reached stays 503", page(503, { state: "refused" }), '503 {"state":"refused"}');
check("control: a link Fleet could not open stays 502", page(502, { state: "failed" }), '502 {"state":"failed"}');
check("a success is passed through", page(200, { state: "waiting", id: "x" }), '200 {"state":"waiting","id":"x"}');

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
