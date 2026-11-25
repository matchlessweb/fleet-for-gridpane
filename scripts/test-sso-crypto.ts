/**
 * Checks for lib/sso/crypto.ts, against real openssl.   npm run sso:test
 *
 * The server service has no WebCrypto: it verifies and seals with the openssl
 * command. So the proof that the two ends agree is to do the server's half here
 * with the same openssl commands scripts/fleet-sso-agent.py runs.
 *
 * Uses OPENSSL if set, else the first of Homebrew's OpenSSL 3 or `openssl`.
 * macOS's own /usr/bin/openssl is LibreSSL, which cannot do OAEP with SHA-256.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkLoginUrl, isHostname, signRequest, SsoKeyError, unsealLink, type SsoRequestPayload } from "../lib/sso/crypto.ts";

let ran = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}
const threw = async (fn: () => Promise<unknown>) => { try { await fn(); return "no error"; } catch (e) { return e instanceof SsoKeyError ? "key error" : "error"; } };

const OPENSSL = process.env.OPENSSL || ["/opt/homebrew/opt/openssl@3/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"].find(existsSync) || "openssl";
const dir = mkdtempSync(join(tmpdir(), "sso-crypto-"));
const f = (name: string) => join(dir, name);
const ossl = (args: string[], input?: Buffer | string) => execFileSync(OPENSSL, args, { input, stdio: ["pipe", "pipe", "pipe"] });
const osslOk = (args: string[]) => { try { ossl(args); return true; } catch { return false; } };

try {
  console.log(`openssl: ${ossl(["version"]).toString().trim()}`);
  for (const [name, bits] of [["sign", "3072"], ["box", "4096"], ["other", "3072"], ["otherbox", "4096"]] as const) {
    ossl(["genpkey", "-algorithm", "RSA", "-pkeyopt", `rsa_keygen_bits:${bits}`, "-out", f(`${name}.pem`)]);
    ossl(["pkey", "-in", f(`${name}.pem`), "-pubout", "-out", f(`${name}.pub`)]);
  }
  const pem = (name: string) => readFileSync(f(`${name}.pem`), "utf8");

  const ID = "00000000-0000-4000-8000-000000000001";
  const HOST = "example.com";
  const payload: SsoRequestPayload = { v: 1, id: ID, sid: 10001, host: HOST, iat: 1_800_000_000, exp: 1_800_000_060 };

  // The server's half, as the agent does it.
  const serverVerify = (signed: string, pub = "sign") => {
    const parts = signed.split(".");
    if (parts.length !== 3 || parts[0] !== "v1") return false;
    writeFileSync(f("data"), `${parts[0]}.${parts[1]}`);
    writeFileSync(f("sig"), Buffer.from(parts[2], "base64url"));
    return osslOk(["dgst", "-sha256", "-verify", f(`${pub}.pub`), "-signature", f("sig"), f("data")]);
  };
  const serverSeal = (text: string, pub = "box") =>
    ossl(["pkeyutl", "-encrypt", "-pubin", "-inkey", f(`${pub}.pub`), "-pkeyopt", "rsa_padding_mode:oaep", "-pkeyopt", "rsa_oaep_md:sha256", "-pkeyopt", "rsa_mgf1_md:sha256"], text).toString("base64");

  console.log("Signing:");
  const signed = await signRequest(payload, pem("sign"));
  check("three parts, starting v1", [signed.split(".").length, signed.startsWith("v1.")], [3, true]);
  check("the payload reads back exactly", JSON.parse(Buffer.from(signed.split(".")[1], "base64url").toString()), payload);
  check("openssl accepts the signature", serverVerify(signed), true);
  check("control: openssl refuses it under a different public key", serverVerify(signed, "other"), false);
  const [v, body, sig] = signed.split(".");
  const forged = Buffer.from(JSON.stringify({ ...payload, host: "evil.example" })).toString("base64url");
  check("control: a changed payload with the old signature is refused", serverVerify(`${v}.${forged}.${sig}`), false);
  check("control: a signature with one byte changed is refused", serverVerify(`${v}.${body}.${sig.slice(0, -2)}${sig.endsWith("AA") ? "BB" : "AA"}`), false);
  check("fits the database's 4096-character limit", signed.length < 4096, true);
  check("a key with literal \\n in place of line breaks still works", serverVerify(await signRequest(payload, pem("sign").replace(/\n/g, "\\n"))), true);
  check("no key: a key error, not a crash elsewhere", await threw(() => signRequest(payload, undefined)), "key error");
  check("a public key where the private one belongs: a key error", await threw(() => signRequest(payload, readFileSync(f("sign.pub"), "utf8"))), "key error");
  check("a hostname with a slash is never signed", await threw(() => signRequest({ ...payload, host: "example.com/x" }, pem("sign"))), "error");
  check("a hostname with .. is never signed", await threw(() => signRequest({ ...payload, host: "a..b" }, pem("sign"))), "error");
  check("an id that is not a uuid is never signed", await threw(() => signRequest({ ...payload, id: "1; rm -rf" }, pem("sign"))), "error");
  check("an expiry before the issue time is never signed", await threw(() => signRequest({ ...payload, exp: payload.iat }, pem("sign"))), "error");

  console.log("Unsealing:");
  const LINK = "https://example.com/9c195f0a/AbCdEfGhIjKlMnOpQrStUv";
  const sealed = serverSeal(`${ID}\n${LINK}`);
  check("a link sealed by openssl opens", await unsealLink(sealed, pem("box"), { id: ID, hostname: HOST }), { ok: true, url: LINK });
  check("fits the database's 2048-character limit", sealed.length <= 2048, true);
  check("the sealed text does not contain the link", sealed.includes("9c195f0a") || Buffer.from(sealed, "base64").includes("example.com"), false);
  check("control: a different private key cannot open it", await unsealLink(sealed, pem("otherbox"), { id: ID, hostname: HOST }), { ok: false, reason: "cannot-open" });
  check("a link sealed for another request is refused", await unsealLink(sealed, pem("box"), { id: "11111111-1111-4111-8111-111111111111", hostname: HOST }), { ok: false, reason: "wrong-request" });
  check("a link for another site is refused", await unsealLink(sealed, pem("box"), { id: ID, hostname: "other.example" }), { ok: false, reason: "link-wrong-site" });
  check("a www link for the bare site name is accepted", (await unsealLink(serverSeal(`${ID}\nhttps://www.example.com/9c195f0a/abc`), pem("box"), { id: ID, hostname: HOST })).ok, true);
  check("a sealed http link is refused", await unsealLink(serverSeal(`${ID}\nhttp://example.com/9c195f0a/abc`), pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "link-not-https" });
  check("sealed text with no request id is refused", await unsealLink(serverSeal(LINK), pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "wrong-shape" });
  check("sealed text with an extra line is refused", await unsealLink(serverSeal(`${ID}\n${LINK}\nhttps://evil.example/`), pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "wrong-shape" });
  check("text that was never sealed is refused", await unsealLink(Buffer.from(`${ID}\n${LINK}`).toString("base64"), pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "not-sealed" });
  check("something that is not base64 is refused", await unsealLink("https://example.com/abc", pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "not-sealed" });
  const flipped = Buffer.from(sealed, "base64"); flipped[40] ^= 1;
  check("sealed bytes with one bit changed are refused", await unsealLink(flipped.toString("base64"), pem("box"), { id: ID, hostname: HOST }), { ok: false, reason: "cannot-open" });
  check("no unsealing key: a key error", await threw(() => unsealLink(sealed, "", { id: ID, hostname: HOST })), "key error");
  const longHost = `${"a".repeat(60)}.${"b".repeat(60)}.${"c".repeat(60)}.${"d".repeat(60)}.com`;
  const longLink = `https://${longHost}/9c195f0a/${"t".repeat(28)}`;
  check(`the longest hostname (${longHost.length} characters) still fits in one sealed message`, await unsealLink(serverSeal(`${ID}\n${longLink}`), pem("box"), { id: ID, hostname: longHost }), { ok: true, url: longLink });

  console.log("Which links a browser may be sent to:");
  const bad: [string, string, string][] = [
    ["another site", "https://evil.example/9c195f0a/abc", "wrong-site"],
    ["a look-alike that ends with the site name", `https://not${HOST}/9c195f0a/abc`, "wrong-site"],
    ["the site name as a subdomain of another", "https://example.com.evil.example/9c195f0a/abc", "wrong-site"],
    ["the site name before an @", "https://example.com@evil.example/9c195f0a/abc", "has-credentials"],
    ["a user and password", "https://user:pw@example.com/9c195f0a/abc", "has-credentials"],
    ["another port", "https://example.com:8443/9c195f0a/abc", "wrong-port"],
    ["plain http", "http://example.com/9c195f0a/abc", "not-https"],
    ["a script address", "javascript:alert(1)//example.com/abc", "not-https"],
    ["no path", "https://example.com/", "no-path"],
    ["a space in it", "https://example.com/9c195f0a/abc def", "not-a-url"],
    ["a backslash trick", "https://evil.example\\@example.com/abc", "not-a-url"],
    ["not a link", "No link came back", "not-a-url"],
    ["600+ characters", `https://example.com/${"a".repeat(600)}`, "too-long"],
  ];
  for (const [name, url, reason] of bad) check(`refused: ${name}`, checkLoginUrl(url, HOST), { ok: false, reason });
  check("control: the real shape is accepted", checkLoginUrl(LINK, HOST), { ok: true, url: LINK });
  check("a link without www for a www site name is accepted", checkLoginUrl(LINK, "www.example.com").ok, true);
  check("site names: lower-case letters, digits, dots, hyphens", ["example.com", "a-b.mail.example.com", "x"].map(isHostname), [true, true, true]);
  check("not site names", ["Example.com", "a..b", "a/b", "a b", "-a.com", "a.com-", "", "a;b", "$(x)", 7].map(isHostname), Array(10).fill(false));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${ran} checks, ${failed} failed`);
process.exit(failed ? 1 : 0);
