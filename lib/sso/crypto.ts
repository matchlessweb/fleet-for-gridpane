/**
 * The two secrets-in-transit of one-click sign-in.
 *
 *   signRequest   Fleet signs "mint a sign-in for this site on this server".
 *                 The server service checks the signature with the public half
 *                 before it runs anything, so a stolen database key cannot ask
 *                 for a sign-in.
 *   unsealLink    The server seals the link to Fleet's public key. Only this
 *                 code, holding the private half, can read it, so the database
 *                 never holds a usable link.
 *
 * Formats, which scripts/fleet-sso-agent.py also implements (with openssl):
 *
 *   signed request   v1.<base64url(JSON payload)>.<base64url(signature)>
 *                    signature = RSASSA-PKCS1-v1_5, SHA-256, over the ASCII
 *                    bytes of "v1.<base64url(JSON payload)>"
 *                    payload   = { v: 1, id, sid, host, iat, exp }  (seconds)
 *   sealed link      base64( RSA-OAEP, SHA-256 for both hashes, of the UTF-8
 *                    text "<request id>\n<link>" )
 *
 * Sealing gives secrecy, not proof of who sealed: anyone with the public key
 * can seal. So what comes out is checked hard (checkLoginUrl) before a browser
 * is sent to it: https, the site that was asked for, and the request it was
 * sealed for.
 *
 * Pure WebCrypto: runs in the Worker and under Node (scripts/test-sso-crypto.ts).
 */

export const HOSTNAME_RE = /^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A site folder name: lower-case, no "..", nothing a path or a shell could trip on. */
export function isHostname(value: unknown): value is string {
  return typeof value === "string" && HOSTNAME_RE.test(value) && !value.includes("..");
}
export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type SsoRequestPayload = { v: 1; id: string; sid: number; host: string; iat: number; exp: number };

const enc = new TextEncoder();

function bytesToB64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64ToBytes(text: string): Uint8Array<ArrayBuffer> | null {
  // Accepts base64 or base64url, with or without padding or line breaks.
  const clean = text.replace(/-/g, "+").replace(/_/g, "/").replace(/\s+/g, "").replace(/=+$/, "");
  if (!/^[A-Za-z0-9+/]*$/.test(clean) || clean.length % 4 === 1) return null;
  try {
    const bin = atob(clean + "=".repeat((4 - (clean.length % 4)) % 4));
    const out = new Uint8Array(new ArrayBuffer(bin.length));
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

/** The DER bytes inside a "-----BEGIN PRIVATE KEY-----" (PKCS#8) block. */
function pkcs8FromPem(pem: string | undefined): Uint8Array<ArrayBuffer> | null {
  if (!pem) return null;
  // A secret pasted through a dashboard can arrive with literal "\n" in it.
  const text = pem.replace(/\\n/g, "\n");
  const m = /-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----/.exec(text);
  return m ? b64ToBytes(m[1]) : null;
}

export class SsoKeyError extends Error {}

async function importPrivate(pem: string | undefined, use: "sign" | "decrypt"): Promise<CryptoKey> {
  const der = pkcs8FromPem(pem);
  if (!der) throw new SsoKeyError(`the ${use === "sign" ? "signing" : "unsealing"} key is missing or is not a PKCS#8 private key`);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      der,
      use === "sign" ? { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } : { name: "RSA-OAEP", hash: "SHA-256" },
      false,
      [use]
    );
  } catch {
    throw new SsoKeyError(`the ${use === "sign" ? "signing" : "unsealing"} key could not be read`);
  }
}

/** Sign a request for the server service. Throws SsoKeyError if the key is unusable. */
export async function signRequest(payload: SsoRequestPayload, signPrivateKeyPem: string | undefined): Promise<string> {
  if (payload.v !== 1 || !isUuid(payload.id) || !Number.isSafeInteger(payload.sid) || payload.sid <= 0 || !isHostname(payload.host)) {
    throw new Error("not a valid sign-in request");
  }
  if (!Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp) || payload.exp <= payload.iat) {
    throw new Error("not a valid sign-in request");
  }
  const key = await importPrivate(signPrivateKeyPem, "sign");
  // Field order is fixed so the same request always signs to the same text.
  const body = JSON.stringify({ v: 1, id: payload.id, sid: payload.sid, host: payload.host, iat: payload.iat, exp: payload.exp });
  const signed = `v1.${bytesToB64url(enc.encode(body))}`;
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(signed));
  return `${signed}.${bytesToB64url(new Uint8Array(sig))}`;
}

export type LoginUrlCheck = { ok: true; url: string } | { ok: false; reason: "not-a-url" | "not-https" | "wrong-site" | "has-credentials" | "wrong-port" | "no-path" | "too-long" };

/**
 * Is this a link Fleet may send a browser to for `hostname`?
 * https only, the site that was asked for (with or without "www."), the normal
 * port, no user:password part, and a real path (a sign-in link is never "/").
 */
export function checkLoginUrl(raw: string, hostname: string): LoginUrlCheck {
  if (raw.length > 600) return { ok: false, reason: "too-long" };
  if (/[\s<>"'`\\]/.test(raw)) return { ok: false, reason: "not-a-url" };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { ok: false, reason: "not-a-url" };
  }
  if (url.protocol !== "https:") return { ok: false, reason: "not-https" };
  if (url.username || url.password) return { ok: false, reason: "has-credentials" };
  if (url.port) return { ok: false, reason: "wrong-port" };
  const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
  if (!isHostname(hostname) || bare(url.hostname) !== bare(hostname)) return { ok: false, reason: "wrong-site" };
  if (url.pathname.length < 2) return { ok: false, reason: "no-path" };
  return { ok: true, url: url.href };
}

export type Unsealed =
  | { ok: true; url: string }
  | { ok: false; reason: "not-sealed" | "cannot-open" | "wrong-shape" | "wrong-request" | `link-${Exclude<LoginUrlCheck, { ok: true }>["reason"]}` };

/**
 * Open a sealed link and check it belongs to this request and this site.
 * Throws SsoKeyError only when Fleet's own key is unusable; anything wrong with
 * what the server sent comes back as { ok: false }.
 */
export async function unsealLink(sealed: string, boxPrivateKeyPem: string | undefined, expect: { id: string; hostname: string }): Promise<Unsealed> {
  const key = await importPrivate(boxPrivateKeyPem, "decrypt");
  const bytes = typeof sealed === "string" && sealed.length <= 2048 ? b64ToBytes(sealed) : null;
  if (!bytes || bytes.length < 128) return { ok: false, reason: "not-sealed" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(await crypto.subtle.decrypt({ name: "RSA-OAEP" }, key, bytes));
  } catch {
    return { ok: false, reason: "cannot-open" };
  }
  const nl = text.indexOf("\n");
  if (nl < 0 || text.indexOf("\n", nl + 1) >= 0) return { ok: false, reason: "wrong-shape" };
  if (text.slice(0, nl) !== expect.id) return { ok: false, reason: "wrong-request" };
  const link = checkLoginUrl(text.slice(nl + 1), expect.hostname);
  return link.ok ? { ok: true, url: link.url } : { ok: false, reason: `link-${link.reason}` };
}
