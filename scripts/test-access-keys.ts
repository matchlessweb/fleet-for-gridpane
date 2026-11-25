/**
 * Checks for how lib/sso/access-jwt.ts fetches and keeps Cloudflare's keys, and
 * for the team address it accepts.   npm run accesskeys:test
 *
 *   (no option)  each behavior beside the case that must not pass
 *   --controls   break a copy of the file one way at a time; each break must be caught
 *
 * Why it matters: the middleware asks this file about EVERY request, so a short
 * failure at Cloudflare, a slow answer, or a stranger's forged token must not
 * take the app down or send it back to Cloudflare on every request.
 *
 * KEYS_LIB points the checks at another copy (the controls use it). Touches
 * nothing outside this process: the keys are made here, "Cloudflare" is a
 * function, and time is a number the checks pass in.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const LIB = process.env.KEYS_LIB || fileURLToPath(new URL("../lib/sso/access-jwt.ts", import.meta.url));

type Break = [name: string, edit: (s: string) => string];
const swap = (from: string, to: string) => (s: string) => {
  const out = s.replace(from, to);
  if (out === s) throw new Error(`a control found nothing to change: ${from.slice(0, 60)}`);
  return out;
};
const BREAKS: Break[] = [
  ["the keys are fetched again on every request", swap("if (!lookAgain && entry.keys && now - entry.at < KEY_CACHE_SECONDS) return { keys: entry.keys, answered: false };", "")],
  ["keys held from before count as fetched just now", swap("if (!lookAgain && entry.keys && now - entry.at < KEY_CACHE_SECONDS) return { keys: entry.keys, answered: false };", "if (!lookAgain && entry.keys && now - entry.at < KEY_CACHE_SECONDS) return { keys: entry.keys, answered: true };")],
  ["the keys are never fetched again", swap("const KEY_CACHE_SECONDS = 600;", "const KEY_CACHE_SECONDS = Infinity;")],
  ["a failed refresh throws away the keys held", swap("    entry.failedAt = now;\n    return { keys: held, answered: false };", "    entry.failedAt = now;\n    return { keys: null, answered: false };")],
  ["the keys held are used for ever", swap("const KEY_STALE_SECONDS = 24 * 3600;", "const KEY_STALE_SECONDS = Infinity;")],
  ["the keys held are not used past ten minutes", swap("const KEY_STALE_SECONDS = 24 * 3600;", "const KEY_STALE_SECONDS = KEY_CACHE_SECONDS;")],
  ["with keys held, a failed fetch is tried again on every request", swap("  if (held && now - entry.failedAt < KEY_RETRY_SECONDS) return { keys: held, answered: false };\n", "")],
  ["inside the retry time, the keys held count as fetched just now", swap("if (held && now - entry.failedAt < KEY_RETRY_SECONDS) return { keys: held, answered: false };", "if (held && now - entry.failedAt < KEY_RETRY_SECONDS) return { keys: held, answered: true };")],
  ["with no keys held, every request starts a fetch even after one has failed (no limit at all)", swap("  if (!held && now - entry.failedAt < KEY_RETRY_SECONDS && entry.startedAt === now) return { keys: null, answered: false };\n", "")],
  ["with no keys held, nothing is fetched for ten seconds after a failure", swap("if (!held && now - entry.failedAt < KEY_RETRY_SECONDS && entry.startedAt === now)", "if (!held && now - entry.failedAt < KEY_RETRY_SECONDS)")],
  ["the one-a-second limit holds even when no fetch has failed (a healthy start refuses requests that arrive together)", swap("if (!held && now - entry.failedAt < KEY_RETRY_SECONDS && entry.startedAt === now)", "if (!held && entry.startedAt === now)")],
  ["the one-a-second limit counts from a mark that is wiped when a fetch ends", swap("&& entry.startedAt === now) return { keys: null", "&& entry.askedAt === now) return { keys: null")],
  ["the second a fetch began in is never noted", swap("  entry.startedAt = now;\n", "")],
  ["an older answer that lands late replaces newer keys", swap("const newer = now < entry.at ? entry.keys : null;", "const newer = null;")],
  ["an older answer that lands late is not kept, but its own request is still checked with it", swap("return { keys: newer ?? keys, answered: true };", "return { keys, answered: true };")],
  ["a fetch that fails after another request's was answered refuses its own request", swap("    if (entry.keys && (entry.keys !== keysBefore || entry.at !== fetchedBefore)) return { keys: entry.keys, answered: false };\n", "")],
  ["a fetch that fails after another request's was answered is still recorded as a failure", swap("if (entry.keys && (entry.keys !== keysBefore || entry.at !== fetchedBefore)) return { keys: entry.keys, answered: false };", "if (entry.keys && (entry.keys !== keysBefore || entry.at !== fetchedBefore)) { entry.failedAt = now; return { keys: entry.keys, answered: false }; }")],
  ["keys stored meanwhile are only noticed when the list itself is a new one", swap("(entry.keys !== keysBefore || entry.at !== fetchedBefore)", "(entry.keys !== keysBefore)")],
  ["a fetch that is answered leaves an earlier failure in place", swap("    entry.failedAt = -Infinity;\n", "")],
  ["a failed fetch is not tried again for an hour", swap("const KEY_RETRY_SECONDS = 10;", "const KEY_RETRY_SECONDS = 3600;")],
  ["every unknown key sends the app back to Cloudflare", swap("  if (lookAgain && now - entry.lookedAgainAt < KEY_LOOK_AGAIN_SECONDS) return { keys: held, answered: false };\n", "")],
  ["a second look is never allowed again", swap("const KEY_LOOK_AGAIN_SECONDS = 60;", "const KEY_LOOK_AGAIN_SECONDS = Infinity;")],
  ["a second look that got no answer uses up the minute", swap("    if (lookAgain) entry.lookedAgainAt = lookedAgainBefore;\n", "")],
  ["every request asks while a fetch is on its way", swap("  if (held && now - entry.askedAt < KEY_ASKING_SECONDS) return { keys: held, answered: false };\n", "")],
  ["a fetch that has ended still counts as on its way", swap("    if (entry.asking === mark) entry.askedAt = -Infinity;\n", "")],
  ["a fetch that ends wipes the mark of another that is still on its way", swap("if (entry.asking === mark) entry.askedAt = -Infinity;", "entry.askedAt = -Infinity;")],
  ["a fetch that never ends stops the asking for ever", swap("const KEY_ASKING_SECONDS = 5;", "const KEY_ASKING_SECONDS = Infinity;")],
  ["with no keys held, a request that arrives second is refused", swap("if (held && now - entry.askedAt < KEY_ASKING_SECONDS)", "if (now - entry.askedAt < KEY_ASKING_SECONDS)")],
  ["a key not among the keys fetched in this very call is fetched for a second time", swap("if (!jwk && !first.answered) {", "if (!jwk) {")],
  ["no second look is made for a key not held", swap("    const again = await keysFor(teamDomain, fetchKeys, now, true);\n", "    const again: KeysAnswer = { keys, answered: false };\n")],
  ["a look that was not made, or got no answer, is answered 'no such key' (403)", swap('    if (!jwk && !again.answered) return { ok: false, reason: "keys-unavailable" };\n', "")],
  ["a look that was not made, or got no answer, lets the request through", swap('if (!jwk && !again.answered) return { ok: false, reason: "keys-unavailable" };', 'if (!jwk && !again.answered) return { ok: true, email: "person@example.com", sub: "user-1", expiresAt: now + 600 };')],
  ["a look that was not made counts as one Cloudflare answered", swap("if (lookAgain && now - entry.lookedAgainAt < KEY_LOOK_AGAIN_SECONDS) return { keys: held, answered: false };", "if (lookAgain && now - entry.lookedAgainAt < KEY_LOOK_AGAIN_SECONDS) return { keys: held, answered: true };")],
  ["a look that got no answer counts as one Cloudflare answered", swap("    entry.failedAt = now;\n    return { keys: held, answered: false };", "    entry.failedAt = now;\n    return { keys: held, answered: true };")],
  ["a look skipped because a fetch is on its way counts as one Cloudflare answered", swap("if (held && now - entry.askedAt < KEY_ASKING_SECONDS) return { keys: held, answered: false };", "if (held && now - entry.askedAt < KEY_ASKING_SECONDS) return { keys: held, answered: true };")],
  ["a look Cloudflare answered counts as not made", swap("    return { keys: newer ?? keys, answered: true };", "    return { keys: newer ?? keys, answered: false };")],
  ["an answer with no keys replaces the keys held", swap("if (!Array.isArray(keys) || keys.length === 0) throw", "if (!Array.isArray(keys)) throw")],
  ["an answer that is not a list is kept as the keys", swap("if (!Array.isArray(keys) || keys.length === 0) throw", "if (keys.length === 0) throw")],
  ["the fetch has no timeout", swap(", signal: AbortSignal.timeout(KEY_FETCH_TIMEOUT_MS)", "")],
  ["the fetch waits a minute", swap("const KEY_FETCH_TIMEOUT_MS = 3000;", "const KEY_FETCH_TIMEOUT_MS = 60000;")],
  ["an answer that is not a 200 is read for keys", swap("  if (!res.ok) throw new Error(`certs answered ${res.status}`);\n", "")],
  ["an address pasted with https:// is refused", swap('.replace(/^https:\\/\\//, "")', "")],
  ["an address with a / at the end is refused", swap('.replace(/\\/+$/, "")', "")],
  ["an http:// address is accepted", swap(".replace(/^https:\\/\\//,", ".replace(/^https?:\\/\\//,")],
  ["an address with a path in it is accepted", swap("return /^[a-z0-9-]+(\\.[a-z0-9-]+)+$/.test(name) ? name : null;", "return name ? name.split(\"/\")[0] : null;")],
  ["the address is used as typed, capitals and all", swap(".trim().toLowerCase().replace(", ".trim().replace(")],
  ["the token's issuer is compared with the address as typed", swap("if (claims.iss !== `https://${teamDomain}`)", "if (claims.iss !== `https://${opts.teamDomain}`)")],
];

if (process.argv.includes("--controls")) {
  const dir = mkdtempSync(join(tmpdir(), "access-keys-controls-"));
  let caught = 0;
  try {
    const source = readFileSync(LIB, "utf8");
    if (/from "\.\.?\//.test(source)) throw new Error("the file now imports a neighbor: a copy in a temp folder would not load, and a copy that will not load is not a catch");
    for (const [name, edit] of BREAKS) {
      writeFileSync(join(dir, "access-jwt.ts"), edit(source));
      const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", fileURLToPath(import.meta.url)], { env: { ...process.env, KEYS_LIB: join(dir, "access-jwt.ts") }, encoding: "utf8" });
      const m = /(\d+) checks, (\d+) failed/.exec(r.stdout || "");
      // A run that fell over is not a catch: only a run that finished and counted failures is.
      // Nor is a copy that fails every check: it did not run the checks, it broke before them.
      const ok = !!m && Number(m[2]) > 0 && Number(m[2]) < Number(m[1]);
      if (ok) caught++;
      console.log(`  ${ok ? "caught" : "MISSED"}  ${name}  (${m ? `${m[2]} failing` : "the run did not finish: " + (r.stderr || "").trim().split("\n").pop()})`);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
  console.log(`\n${BREAKS.length} broken copies: ${caught} caught, ${BREAKS.length - caught} missed`);
  process.exit(caught === BREAKS.length ? 0 : 1);
}

const { verifyAccessJwt, clearAccessKeyCache, normalizeTeamDomain } = (await import(pathToFileURL(LIB).href)) as typeof import("../lib/sso/access-jwt.ts");
type KeyFetcher = import("../lib/sso/access-jwt.ts").KeyFetcher;

let ran = 0, failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const TEAM = "team.example.com", AUD = "a".repeat(64), NOW = 1_800_000_000, DAY = 24 * 3600;
const CERTS = `https://${TEAM}/cdn-cgi/access/certs`;
const b64u = (v: Uint8Array | string) => Buffer.from(typeof v === "string" ? new TextEncoder().encode(v) : v).toString("base64url");
async function makeKey(kid: string) {
  const pair = await crypto.subtle.generateKey({ name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return { kid, privateKey: pair.privateKey, jwk: { kid, kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256" } };
}
type Key = Awaited<ReturnType<typeof makeKey>>;
async function sign(key: Key, at: number, over: Record<string, unknown> = {}) {
  const claims = { iss: `https://${TEAM}`, aud: [AUD], email: "person@example.com", sub: "user-1", exp: at + 600, iat: at - 10, nbf: at - 10, ...over };
  const h = b64u(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "JWT" })), p = b64u(JSON.stringify(claims));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}
const first = await makeKey("key-1"), second = await makeKey("key-2"), nobody = await makeKey("key-9");

// "Cloudflare": what it serves, whether it answers, and how often it was asked.
let asked = 0, askedFor: string[] = [], served: unknown = [first.jwk], up = true;
// A slow answer: while `hold` is set, every fetch waits for it.
let hold: Promise<void> | null = null, release = () => {};
const slow = () => { hold = new Promise<void>((done) => { release = () => { hold = null; done(); }; }); };
const cloudflare: KeyFetcher = async (url) => { asked++; askedFor.push(url); if (hold) await hold; if (!up) throw new Error("no answer"); return served as never; };
const fresh = () => { release(); clearAccessKeyCache(); asked = 0; askedFor = []; served = [first.jwk]; up = true; };
/** Wait, a few milliseconds at a time and for two seconds at most, until something is so. */
/** A request that must answer by itself: if it is still waiting after two seconds, that is its answer. */
const soon = (request: Promise<string>) => Promise.race([request, new Promise<string>((r) => setTimeout(() => r("it never answered"), 2000))]);
const until = async (so: () => boolean) => { for (let i = 0; i < 400 && !so(); i++) await new Promise((r) => setTimeout(r, 5)); };
/** One request at a moment: "ok", or why it was refused. */
const at = async (now: number, key: Key = first, teamDomain: string = TEAM) => {
  // The verifier must answer, never throw: the middleware has no other answer to give.
  try {
    const r = await verifyAccessJwt(await sign(key, now), { teamDomain, audience: AUD, now, fetchKeys: cloudflare });
    return r.ok ? "ok" : r.reason;
  } catch (e) { return `it threw: ${(e as Error).message}`; }
};

console.log("The keys are fetched once and kept for ten minutes");
{
  fresh();
  check("the first request fetches them and is let through", [await at(NOW), asked], ["ok", 1]);
  check("they are asked for at the team's own address", askedFor, [CERTS]);
  check("nine minutes on, no second fetch", [await at(NOW + 540), asked], ["ok", 1]);
  check("past ten minutes they are fetched again", [await at(NOW + 601), asked], ["ok", 2]);
}

console.log("Cloudflare stops answering after the keys were fetched (a short failure must not take the app down)");
{
  fresh(); await at(NOW);
  up = false;
  check("the refresh is tried, fails, and the request is still let through on the keys held", [await at(NOW + 601), asked], ["ok", 2]);
  check("a moment later the request is let through without asking again", [await at(NOW + 605), asked], ["ok", 2]);
  check("ten seconds after the failure it asks once more, and still lets the request through", [await at(NOW + 611), asked], ["ok", 3]);
  check("hours later, still failing, still let through", await at(NOW + 6 * 3600), "ok");
  check("control: a token signed by another key is refused all the same", await at(NOW + 6 * 3600 + 1, { ...nobody, kid: "key-1" }), "bad-signature");
  check("just short of a day after the keys were fetched they still count", await at(NOW + DAY - 1), "ok");
  check("control: a day after they were fetched they no longer do, and the request is refused", await at(NOW + DAY + 30), "keys-unavailable");
  const tooOld = asked;
  check("with nothing left to check with, the next request a second later asks Cloudflare again: it does not wait out the ten seconds", [await at(NOW + DAY + 31), asked - tooOld], ["keys-unavailable", 1]);
  up = true;
  const before = asked;
  check("when Cloudflare answers again the keys are fetched and the request is let through", [await at(NOW + DAY + 60), asked - before], ["ok", 1]);
}

console.log("Cloudflare is not answering and no keys are held");
{
  fresh(); up = false;
  check("the request is refused: there is nothing to check it with", [await at(NOW), asked], ["keys-unavailable", 1]);
  const same: string[] = [];
  for (let i = 0; i < 200; i++) same.push(await soon(at(NOW)));
  check("two hundred more requests in the same second are refused too", same.filter((r) => r === "keys-unavailable").length, 200);
  check("and not one of them asked Cloudflare: after a failure, one fetch is started a second, and this second has had its one", asked, 1);
  check("in the next second, one request asks again", [await soon(at(NOW + 1)), asked], ["keys-unavailable", 2]);
  for (let i = 0; i < 200; i++) await at(NOW + 1);
  check("and the two hundred after it in that second do not", asked, 2);
  up = true;
  check("Cloudflare is back, but in the second of that last failure it is still not asked", [await soon(at(NOW + 1)), asked], ["keys-unavailable", 2]);
  check("in the next second it is asked, and the request is let through: nobody is locked out for more than about a second", [await soon(at(NOW + 2)), asked], ["ok", 3]);
  check("control: with keys held again, the next request does not ask", [await at(NOW + 3), asked], ["ok", 3]);
}

console.log("A Worker that has just started, and Cloudflare fails once (the login page is refused for about a second, not ten)");
{
  fresh(); up = false;
  check("the first request is refused", [await at(NOW), asked], ["keys-unavailable", 1]);
  up = true;
  check("a second request in the same second is refused, and no new fetch is made", [await soon(at(NOW)), asked], ["keys-unavailable", 1]);
  check("in the next second it asks again and is let through", [await soon(at(NOW + 1)), asked], ["ok", 2]);
  served = [first.jwk, second.jwk];
  check("and once Cloudflare has answered, the failure before it is forgotten: a new key is looked for straight away", [await at(NOW + 2, second), asked], ["ok", 3]);
  fresh(); await at(NOW); up = false; await at(NOW + 601);
  const held = asked;
  check("control: with keys held, a failed fetch is still not repeated for ten seconds", [await at(NOW + 602), await at(NOW + 610), asked - held], ["ok", "ok", 0]);
}

console.log("A Worker that has just started while Cloudflare fails slowly: 100 requests a second for ten seconds, every fetch giving up after three");
{
  fresh();
  // A "Cloudflare" that keeps each fetch waiting until the check ends it. `clock` is the second the check is in.
  type Waiting = { began: number; end: (answered: boolean) => void };
  let waiting: Waiting[] = [], clock = 0, healthy = false;
  const slowCloudflare: KeyFetcher = () => {
    asked++;
    if (healthy) return Promise.resolve(served as never);
    return new Promise((answer, fail) => { waiting.push({ began: clock, end: (ok) => (ok ? answer(served as never) : fail(new Error("no answer"))) }); });
  };
  /** The fetches that began at or before a second give up, and the requests behind them get their answer. */
  const giveUp = async (upTo: number) => {
    for (const w of waiting.filter((x) => x.began <= upTo)) w.end(false);
    waiting = waiting.filter((x) => x.began > upTo);
    await new Promise((r) => setTimeout(r, 0));
  };
  // The verifier reaches the fetch before it first waits, so the count is exact as soon as the hundred are sent.
  const send = (token: string, now: number) => verifyAccessJwt(token, { teamDomain: TEAM, audience: AUD, now, fetchKeys: slowCloudflare }).then((r) => (r.ok ? "ok" : r.reason), (e) => `it threw: ${(e as Error).message}`);
  const requests: Promise<string>[] = [], started: number[] = [];
  for (clock = 0; clock < 10; clock++) {
    await giveUp(clock - 3);
    const token = await sign(first, NOW + clock), before = asked;
    for (let i = 0; i < 100; i++) requests.push(send(token, NOW + clock));
    started.push(asked - before);
  }
  check("fetches started in each second: every request asks until the first failure is seen, three seconds in, and one a second after that", started, [100, 100, 100, 1, 1, 1, 1, 1, 1, 1]);
  check("307 fetches for the 1,000 requests, not 1,000: the first three seconds' worth, and seven more", asked, 307);
  clock = 10;
  await giveUp(7);
  healthy = true;
  const back = asked, token = await sign(first, NOW + 10);
  check("Cloudflare is healthy again: the next second's one fetch is answered, and its request is let through", [await soon(send(token, NOW + 10)), asked - back], ["ok", 1]);
  const after = await Promise.all(Array.from({ length: 100 }, () => send(token, NOW + 10)));
  check("and every request from then on is let through, with no more fetches", [after.filter((r) => r === "ok").length, asked - back], [100, 1]);
  await giveUp(10);
  const all = await Promise.all(requests.map(soon));
  check("of the 1,000, 998 were refused with 'could not check', and the two whose fetch gave up after Cloudflare was back were let through on the keys held by then", [all.filter((r) => r === "keys-unavailable").length, all.filter((r) => r === "ok").length], [998, 2]);
}

console.log("Two requests fetch at once: one is answered, the other fails");
{
  fresh(); slow();
  const waiting = at(NOW); // its fetch waits
  await until(() => asked >= 1);
  const failIt = release;
  hold = null; // the next fetch is answered at once
  check("with no keys held, a second request asks as well and is let through", [await soon(at(NOW)), asked], ["ok", 2]);
  up = false; failIt();
  check("the first one's own fetch then fails, and it is let through on the keys the other one stored", await soon(waiting), "ok");
  up = true; served = [first.jwk, second.jwk];
  check("and no failure is recorded: a new key is looked for straight away, not after the retry time", [await at(NOW + 1, second), asked], ["ok", 3]);

  fresh(); await at(NOW);
  slow();
  const stuck = at(NOW + 601); // a refresh that hangs
  await until(() => asked >= 2);
  const failStuck = release;
  hold = null;
  check("with keys held: a later request, allowed to ask because the refresh is taking too long, is answered", [await soon(at(NOW + 607)), asked], ["ok", 3]);
  up = false; failStuck();
  check("the refresh then fails, and its request is still let through", await soon(stuck), "ok");
  up = true; served = [first.jwk, second.jwk];
  check("and its failure is not recorded either, though Cloudflare sent the very same list as before", [await at(NOW + 608, second), asked], ["ok", 4]);

  fresh(); slow();
  const answered = at(NOW);
  await until(() => asked >= 1);
  const answerIt = release;
  hold = null; up = false;
  check("the other way round: one request's fetch fails while another's is still waiting", [await soon(at(NOW)), asked], ["keys-unavailable", 2]);
  up = true; answerIt();
  check("the one still waiting is answered and let through", await soon(answered), "ok");
  served = [first.jwk, second.jwk];
  check("and the failure before that answer does not hold back a second look", [await at(NOW + 1, second), asked], ["ok", 3]);
}

console.log("Two fetches overlap, and the older one's answer lands last");
{
  fresh(); await at(NOW);
  slow();
  const older = at(NOW + 601, second); // a refresh that is slow to answer, for a token signed with a key not yet held
  await until(() => asked >= 2);
  const landOlder = release;
  hold = null; served = [first.jwk, second.jwk];
  check("a later request, allowed to ask because the refresh is taking too long, fetches the newer keys", [await soon(at(NOW + 607)), asked], ["ok", 3]);
  served = [first.jwk]; // what Cloudflare said to the older fetch, before it began signing with the new key
  landOlder();
  check("the older answer lands last, and its own request is checked with the newer keys", await soon(older), "ok");
  check("the newer keys are the ones still held: the new key needs no fetch", [await at(NOW + 608, second), asked], ["ok", 3]);
}

console.log("An answer with no keys in it");
{
  fresh(); served = [];
  check("with no keys held it counts as no answer", await at(NOW), "keys-unavailable");
  fresh(); await at(NOW); served = [];
  check("it does not replace keys that work", [await at(NOW + 601), asked], ["ok", 2]);
  fresh(); await at(NOW); served = { keys: "none" };
  check("nor does an answer that is not a list", await at(NOW + 601), "ok");
}

console.log("A token naming a key that is not held (anyone can send one)");
{
  fresh(); await at(NOW);
  check("the first one sends the app to Cloudflare once more, and is refused: Cloudflare does not publish that key", [await at(NOW + 1, nobody), asked], ["unknown-key", 2]);
  const more: string[] = [];
  for (let i = 0; i < 50; i++) more.push(await at(NOW + 2 + (i % 5), nobody));
  check("fifty more in the same minute do not send it to Cloudflare again", asked, 2);
  check("every one of the fifty is refused", more.filter((r) => r === "ok").length, 0);
  check("and told 'could not check, try again', not 'no such key': Cloudflare was not asked about them", more.filter((r) => r === "keys-unavailable").length, 50);
  check("control: a real token is still let through meanwhile", [await at(NOW + 8), asked], ["ok", 2]);
  check("a minute after that look, one more is allowed, and Cloudflare's own answer is 'no such key'", [await at(NOW + 61, nobody), asked], ["unknown-key", 3]);
  const onlyOne = await at(NOW + 62, nobody);
  check("and only one: the next is not looked up, and is refused", [onlyOne, onlyOne === "ok", asked], ["keys-unavailable", false, 3]);
  fresh();
  check("on a Worker that has just started, the keys fetched for that very request are Cloudflare's answer: one fetch, not two, and 'no such key'", [await at(NOW, nobody), asked], ["unknown-key", 1]);
  fresh(); await at(NOW);
  check("the same when the keys were due for a refresh: the refresh is the answer, and no second fetch follows it", [await at(NOW + 601, nobody), asked], ["unknown-key", 2]);
  served = [first.jwk, second.jwk];
  check("control: a key not among keys held from before still gets its second look", [await at(NOW + 602, second), asked], ["ok", 3]);
}

console.log("Cloudflare starts signing with a new key");
{
  fresh(); await at(NOW);
  served = [first.jwk, second.jwk];
  check("a token signed with the new key is let through after one more look", [await at(NOW + 5, second), asked], ["ok", 2]);
  check("the next one needs no fetch", [await at(NOW + 6, second), asked], ["ok", 2]);
  fresh(); await at(NOW);
  await at(NOW + 1, nobody); // a stranger uses up this minute's second look
  served = [first.jwk, second.jwk];
  const waiting = await at(NOW + 5, second);
  check("right after a stranger's forged token, the new key waits for the next look: it is told 'try again in a moment', not 'this did not come through Access'", [waiting, asked], ["keys-unavailable", 2]);
  check("control: waiting is still a refusal", waiting === "ok", false);
  check("the next look comes within the minute, and the new key is let through", [await at(NOW + 61, second), asked], ["ok", 3]);
  fresh(); await at(NOW);
  up = false;
  const unheard = await at(NOW + 5, second);
  check("when that look gets no answer, the reply is 'could not check', not 'no such key': Cloudflare was not heard from", [unheard, asked], ["keys-unavailable", 2]);
  check("control: and it is a refusal", unheard === "ok", false);
  check("and a token signed with a key that is held is still let through", await at(NOW + 6), "ok");
}

console.log("A second look that got no answer has not been had");
{
  fresh(); await at(NOW);
  served = [first.jwk, second.jwk]; up = false;
  check("the look fails, and the token is refused: could not check", [await at(NOW + 5, second), asked], ["keys-unavailable", 2]);
  for (let i = 0; i < 30; i++) await at(NOW + 6 + (i % 4), nobody);
  check("thirty forged tokens in the next seconds do not send it back to Cloudflare", asked, 2);
  up = true;
  check("control: inside the retry time it does not ask again, and the token is still refused", [await at(NOW + 14, second), asked], ["keys-unavailable", 2]);
  check("after the retry time, not a full minute, it looks again and the new key is let through", [await at(NOW + 16, second), asked], ["ok", 3]);
}

console.log("Many requests at once while Cloudflare is slow to answer");
{
  fresh(); await at(NOW);
  slow();
  let done = 0;
  const many = Array.from({ length: 20 }, () => at(NOW + 601).then((r) => { done++; return r; }));
  await until(() => done >= 19);
  check("twenty at once with the keys due for a refresh: Cloudflare is asked once, and nineteen do not wait for it", [asked, done], [2, 19]);
  release();
  check("all twenty are let through", (await Promise.all(many)).filter((r) => r === "ok").length, 20);
  served = [first.jwk, second.jwk];
  check("once that fetch has ended, a new key is looked for straight away", [await at(NOW + 602, second), asked], ["ok", 3]);

  fresh(); await at(NOW);
  slow();
  const refresh = at(NOW + 601);
  await until(() => asked >= 2);
  served = [first.jwk, second.jwk];
  const meanwhile = await soon(at(NOW + 602, second));
  check("while a refresh is on its way, a token signed with a key not held is told to try again, and no second fetch is made", [meanwhile, asked], ["keys-unavailable", 2]);
  release(); await refresh;
  check("once the refresh is in, the same token is let through", [await at(NOW + 603, second), asked], ["ok", 2]);

  fresh(); await at(NOW);
  slow();
  const stuck = at(NOW + 601);
  await until(() => asked >= 2);
  check("a fetch that never ends: a request two seconds later does not ask as well", [await soon(at(NOW + 603)), asked], ["ok", 2]);
  const later = at(NOW + 607);
  await until(() => asked >= 3);
  check("but after a few seconds one more is allowed to ask", asked, 3);
  release(); await Promise.all([stuck, later]);

  fresh(); await at(NOW);
  slow();
  const one = at(NOW + 601);
  await until(() => asked >= 2);
  const endOne = release;
  slow();
  const two = at(NOW + 607); // the first is taking too long, so one more is allowed to ask
  await until(() => asked >= 3);
  const endTwo = release;
  endOne(); await one;
  served = [first.jwk, second.jwk];
  check("two fetches on their way, and the first ends: the second still counts, so a token naming a key not held starts no third", [await soon(at(NOW + 608, second)), asked], ["keys-unavailable", 3]);
  endTwo(); await two;
  check("when the second ends, the new key is in and that token is let through", [await at(NOW + 609, second), asked], ["ok", 3]);

  fresh(); slow();
  const cold = Array.from({ length: 20 }, () => at(NOW));
  await until(() => asked >= 20);
  release();
  check("a healthy start with no keys held yet: twenty requests arriving together each ask, and all twenty are let through", [(await Promise.all(cold.map(soon))).filter((r) => r === "ok").length, asked], [20, 20]);
}

console.log("The fetch itself gives up on a slow answer");
{
  const realFetch = globalThis.fetch, realTimeout = AbortSignal.timeout;
  let waitMs = -1, made: AbortSignal | undefined, got: AbortSignal | null | undefined, url = "", accept = "";
  try {
    // Time is not waited for: the stand-in notes how long the fetch said it would wait, and hands back a signal that has already given up.
    AbortSignal.timeout = (ms: number) => { waitMs = ms; made = AbortSignal.abort(new DOMException("timed out", "TimeoutError")); return made; };
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      url = String(input); got = init?.signal; accept = new Headers(init?.headers).get("accept") || "";
      if (init?.signal?.aborted) throw init.signal.reason;
      return new Response(JSON.stringify({ keys: [first.jwk] }), { status: 200 });
    }) as typeof fetch;
    clearAccessKeyCache();
    const slow = await verifyAccessJwt(await sign(first, NOW), { teamDomain: TEAM, audience: AUD, now: NOW });
    check("a fetch that runs out of time refuses the request instead of hanging", slow.ok ? "ok" : slow.reason, "keys-unavailable");
    check("the fetch was given a time limit, and it is the one the request waited on", [waitMs > 0, made !== undefined && got === made], [true, true]);
    check("the limit is a few seconds, not longer", waitMs >= 1000 && waitMs <= 5000, true);
    check("it asked the team's address for JSON", [url, accept], [CERTS, "application/json"]);
    AbortSignal.timeout = realTimeout;
    clearAccessKeyCache();
    const quick = await verifyAccessJwt(await sign(first, NOW), { teamDomain: TEAM, audience: AUD, now: NOW });
    check("control: the same fetch, answered in time, lets the request through", quick.ok, true);
    globalThis.fetch = (async () => new Response(JSON.stringify({ keys: [first.jwk] }), { status: 502 })) as typeof fetch;
    clearAccessKeyCache();
    const bad = await verifyAccessJwt(await sign(first, NOW), { teamDomain: TEAM, audience: AUD, now: NOW });
    check("control: an error page from Cloudflare is not read for keys", bad.ok ? "ok" : bad.reason, "keys-unavailable");
  } finally { globalThis.fetch = realFetch; AbortSignal.timeout = realTimeout; }
}

console.log("The team address, as people paste it");
{
  for (const typed of [TEAM, `https://${TEAM}`, `https://${TEAM}/`, `${TEAM}/`, `  HTTPS://Team.Example.com//  `]) {
    fresh();
    check(`"${typed}" works, and the keys are asked for at the bare name`, [await at(NOW, first, typed), askedFor], ["ok", [CERTS]]);
    check(`"${typed}" reads as ${TEAM}`, normalizeTeamDomain(typed), TEAM);
  }
  for (const typed of [`http://${TEAM}`, `${TEAM}/evil`, `https://${TEAM}/cdn-cgi/access`, `${TEAM}:8443`, "team example.com", "localhost", "https://", "//", "", "   ", `ftp://${TEAM}`, `https://https://${TEAM}`, `${TEAM}?x=1`, `user@${TEAM}`]) {
    fresh();
    check(`control: "${typed}" is not a team address, and Cloudflare is not asked`, [await at(NOW, first, typed), asked, normalizeTeamDomain(typed)], ["not-configured", 0, null]);
  }
  check("nothing set reads as no address", [normalizeTeamDomain(undefined), normalizeTeamDomain(null)], [null, null]);
  fresh();
  const elsewhere = await verifyAccessJwt(await sign(first, NOW, { iss: "https://other.example.com" }), { teamDomain: `https://${TEAM}/`, audience: AUD, now: NOW, fetchKeys: cloudflare });
  check("control: a token from another team is still refused when the address was pasted with https://", elsewhere.ok ? "ok" : elsewhere.reason, "wrong-issuer");
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
