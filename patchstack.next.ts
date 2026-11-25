// Patchstack's firewall for this app: Patchstack's template from @patchstack/connect (MIT,
// Patchstack), with the changes for Cloudflare Workers explained in buildProtection below.
// middleware.ts runs it on every request. With no Patchstack account it blocks on the rules
// bundled in patchstack.rules.json and sends nothing anywhere. To connect an account, see
// "11e. Patchstack" in SETUP.md. `npx @patchstack/connect setup` leaves this file as it is and
// says it is customized. If you ever swap in Patchstack's plain template, keep egress,
// peerAddress, bootTimeoutMs and the retry in getPatchstackProtection: without them a Worker
// can run out of memory or pass requests through unscreened.

// Server-only helpers for Next.js middleware and App Router handlers.
import { createProtection } from "@patchstack/connect/protect";
import fallbackRules from "./patchstack.rules.json";

const PS_SITE_UUID = "__PATCHSTACK_SITE_UUID__";
type Protection = Awaited<ReturnType<typeof createProtection>>;
let _protection: Promise<Protection> | undefined;
let warned = false;

// Not async: it hands back the shared promise itself, so getPatchstackProtection can tell whether
// the promise that failed is still the shared one.
function getProtection(): Promise<Protection> {
  if (!_protection) {
    _protection = buildProtection().catch((error) => {
      _protection = undefined;
      throw error;
    });
  }
  return _protection;
}

function cloudflareClientIp(request: { headers?: { get?: (name: string) => string | null } }): string | undefined {
  return request?.headers?.get?.("cf-connecting-ip")?.trim() || undefined;
}

async function buildProtection() {
  const mode = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_MODE) === "dry-run" ? "dry-run" : "block";
  const siteUuid = PS_SITE_UUID.startsWith("__") ? (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_SITE_UUID) : PS_SITE_UUID;
  const token = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_WAF_TOKEN);
  const refreshMs = (typeof process === "undefined" ? undefined : process.env.PATCHSTACK_ENVIRONMENT) === "sandbox" ? 15000 : 300000;
  // egress is off: on a Cloudflare Worker the fetch wrapper it installs and Next's own fetch
  // wrapper call each other until the Worker runs out of memory. Turn it on only on a Node server.
  // peerAddress: on a Cloudflare Worker the guard has no socket to read the visitor's address from,
  // so it takes the one Cloudflare sets in cf-connecting-ip. Behind another proxy, or on a Node
  // server, change or remove this.
  // bootTimeoutMs: how long a new instance waits for each of Patchstack's two answers (a token,
  // then the rules) before starting on the bundled rules (patchstack.rules.json). The package
  // waits 5 s for each, which holds a cold request up to ~10 s when Patchstack is slow. The guard
  // fetches fresh rules at its next refresh.
  const common = { mode, egress: false, refreshMs, peerAddress: cloudflareClientIp, bootTimeoutMs: 1500 } as const;
  return createProtection(
    siteUuid
      ? { ...common, siteUuid, rules: fallbackRules as never, cacheDir: ".patchstack" }
      : token
        ? { ...common, token, cacheDir: ".patchstack" }
        : { ...common, rules: fallbackRules as never },
  );
}

// On a Cloudflare Worker the guard is built once and shared by every request in the isolate, and a
// request cannot wait on a promise another request started once that request has ended. When the
// request that began the build is cancelled, the shared promise is dead and its own .catch never
// runs, so later requests would pass through unscreened. So a failed wait drops the shared promise,
// if it is still the same one, and builds again inside this request, once.
// `keepAlive` (middleware passes the request's waitUntil) keeps a build this request starts running
// even if this request is cancelled. `from` names the caller in the build-time log line: the
// middleware and the routes are bundled separately on a Worker, so each builds its own guard.
export async function getPatchstackProtection(keepAlive?: (promise: Promise<unknown>) => void, from = "route") {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fresh = !_protection;
    const started = Date.now();
    const pending = getProtection();
    if (fresh && keepAlive) {
      try {
        keepAlive(pending.catch(() => undefined));
      } catch {
        // No waitUntil here (a dev server, a test): the build still runs, only without the guarantee.
      }
    }
    try {
      const protection = await pending;
      // One line per guard a Worker instance builds, so the cold-start cost is measured live, not guessed.
      if (fresh) console.log(`[patchstack] guard built in ${Date.now() - started} ms (${from}; rules from ${protection.ruleSource?.origin ?? "unknown"})`);
      return protection;
    } catch (error) {
      lastError = error;
      if (_protection === pending) _protection = undefined;
    }
  }
  if (!warned) {
    warned = true;
    console.warn(
      "[patchstack] protection is unavailable; traffic may pass through unscreened until a later attempt succeeds. Reported once per process. Cause: " +
        (lastError instanceof Error ? lastError.message : String(lastError)),
    );
  }
  return null;
}

// The handler's expression is evaluated once; its rejection remains the application's error.
// A response streamed as NDJSON (live progress) goes back unscreened: screenResponse reads the
// whole body before handing the response on, and skips only text/event-stream by itself.
export async function screenPatchstackResponse(
  response: Response | Promise<Response>,
  request: Request,
  protection: Protection | null,
): Promise<Response> {
  const settled = await response;
  if (!protection || isLiveStream(settled)) return settled;
  return protection.screenResponse(settled, request);
}

function isLiveStream(response: Response): boolean {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
  return type === "application/x-ndjson";
}
