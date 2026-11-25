#!/usr/bin/env node
// Proves scripts/create-user.ts against a stand-in for the sign-in service's
// admin API: a throwaway HTTP server on a random local port. No real project is
// asked and no real account is made.
//
//   node scripts/test-create-user.mjs              # the checks
//   node scripts/test-create-user.mjs --controls   # also: break a copy of the script one way at a time; each break must be caught
//
// What it holds the script to: the password is never an argument, is never
// shown as it is typed (a real terminal, made with python3's pty), is never
// printed, and goes only to the address the settings name; the account is made
// confirmed; and nothing is asked of the service when the script stops early.
// The made-up password and key are random and made at run time.
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url)), REPO = resolve(HERE, "..");
const SCRIPT = process.env.FLEET_CREATE_USER_UNDER_TEST || join(HERE, "create-user.ts");
const QUIET = !!process.env.QUIET;
const T = mkdtempSync(join(tmpdir(), "fleet-user-test-"));
const stubs = new Set();
process.on("exit", () => { for (const s of stubs) { try { s.closeAllConnections(); s.close(); } catch { /* already closed */ } } rmSync(T, { recursive: true, force: true }); });
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => process.exit(130));

let PASS = 0, FAIL = 0;
const said = [];
const ok = (name, got, want) => { if (got === want) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: got '${got}', wanted '${want}'`); } };
const has = (name, text, part) => { if (String(text).includes(part)) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: '${part}' is not in the output`); } };
const hasnt = (name, text, part) => { if (!String(text).includes(part)) { PASS++; if (!QUIET) said.push(`  pass  ${name}`); } else { FAIL++; said.push(`  FAIL  ${name}: it is in the output`); } };
const section = (title) => { if (!QUIET) said.push(title); };

const random = (n) => randomBytes(n).toString("base64url");
const SERVICE_KEY = `service.${random(48)}`;
const PASSWORD = `pw-${random(18)}`;
const EMAIL = "someone@example.com";
// An address nothing answers at: every run is pointed at the stand-in with FLEET_SUPABASE_URL.
const ENV = join(T, "env.local");
writeFileSync(ENV, `NEXT_PUBLIC_SUPABASE_URL=https://fleet-user-test.invalid\nNEXT_PUBLIC_SUPABASE_ANON_KEY=anon.${random(30)}\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_KEY}\n`);

/* ── the stand-in admin API ──────────────────────────────────────────────── */
// mode: "ok" | "taken" (the address is in use) | "weak" (it quotes the password back, as an error might)
function startStub(mode = "ok") {
  const log = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => { body += d; });
    req.on("end", () => {
      let json = null;
      try { json = JSON.parse(body); } catch { /* not JSON */ }
      log.push({ method: req.method, path: new URL(req.url, "http://stub").pathname, json });
      const send = (status, out) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(out)); };
      if (req.headers.apikey !== SERVICE_KEY || req.headers.authorization !== `Bearer ${SERVICE_KEY}`) return send(401, { code: 401, error_code: "no_authorization", msg: "Invalid API key" });
      if (req.method !== "POST" || !req.url.startsWith("/auth/v1/admin/users")) return send(404, { code: 404, msg: "not found" });
      if (mode === "taken") return send(422, { code: 422, error_code: "email_exists", msg: "A user with this email address has already been registered" });
      if (mode === "weak") return send(422, { code: 422, error_code: "weak_password", msg: `Password ${json && json.password} is too weak` });
      return send(200, { id: "00000000-0000-0000-0000-000000000001", aud: "authenticated", role: "authenticated", email: json && json.email, email_confirmed_at: new Date().toISOString(), app_metadata: {}, user_metadata: {}, identities: [], created_at: new Date().toISOString() });
    });
  });
  stubs.add(server);
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, log, stop: () => { server.closeAllConnections(); server.close(); stubs.delete(server); } })));
}

/* ── one run of the script ───────────────────────────────────────────────── */
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings", SCRIPT];
// A terminal of its own for the script, so "not shown as you type" is looked at and not assumed:
// it types each answer when the question for it has been asked, and hands back all the terminal showed.
const PTY = `
import json, os, pty, select, sys, time
answers = json.loads(sys.argv[1]); argv = sys.argv[2:]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(argv[0], argv)
shown = b""; sent = 0; end = time.time() + 30
while time.time() < end:
    ready, _, _ = select.select([fd], [], [], 0.1)
    if fd in ready:
        try: data = os.read(fd, 4096)
        except OSError: break
        if not data: break
        shown += data
    if sent < len(answers) and shown.count(b": ") > sent:
        time.sleep(0.15)
        os.write(fd, answers[sent].encode() + b"\\r"); sent += 1
_, status = os.waitpid(pid, 0)
print(json.dumps({"code": os.WEXITSTATUS(status) if os.WIFEXITED(status) else -1, "shown": shown.decode("utf8", "replace")}))
`;
async function create({ args = [EMAIL], input = PASSWORD + "\n", typed = null, mode = "ok", env = {}, stub = true } = {}) {
  const svc = stub ? await startStub(mode) : null;
  const e = { PATH: process.env.PATH, HOME: join(T, "home"), FLEET_ENV_FILE: ENV, FLEET_SUPABASE_URL: svc ? svc.url : "http://127.0.0.1:1", ...env };
  let out = "", code = null;
  // Never spawnSync: the stand-in service lives in this process and must be able to answer meanwhile.
  const child = typed
    ? spawn("python3", ["-c", PTY, JSON.stringify(typed), process.execPath, ...NODE_ARGS, ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] })
    : spawn(process.execPath, [...NODE_ARGS, ...args], { env: e, stdio: ["pipe", "pipe", "pipe"] });
  let err = "";
  child.stdout.on("data", (d) => { out += d; }); child.stderr.on("data", (d) => { if (typed) err += d; else out += d; });
  if (!typed) child.stdin.end(input);
  const killer = setTimeout(() => child.kill("SIGKILL"), 45000);
  code = await new Promise((done) => { child.on("error", (x) => { err += x.code || x.message; done(-1); }); child.on("close", (c, sig) => done(sig ? `killed (${sig})` : c)); });
  clearTimeout(killer);
  if (typed) {
    try { const j = JSON.parse(out); out = j.shown; code = j.code; } catch { out = `(the terminal stand-in did not run: ${err.trim().split("\n").at(-1) || "no output"})`; code = -1; }
  }
  if (svc) svc.stop();
  const log = svc ? svc.log : [];
  return { out, code, log, last: out.trimEnd().split(/\r?\n/).at(-1), end: `${out.trimEnd().split(/\r?\n/).at(-1)}/${code}`, sent: log.length ? log.at(-1).json : null };
}

async function checks() {
  const everything = [];
  const run = async (o) => { const r = await create(o); everything.push(r.out); return r; };

  section("The password on standard input (a password manager, a script):");
  const piped = await run();
  ok("the account is made: ends ok, exit 0", piped.end, "user_create=ok/0");
  ok("one request, to the admin API's users address", piped.log.map((r) => `${r.method} ${r.path}`).join(","), "POST /auth/v1/admin/users");
  ok("with the email", piped.sent && piped.sent.email, EMAIL);
  ok("with the password as it was given", piped.sent && piped.sent.password, PASSWORD);
  ok("already confirmed, so no confirmation email is needed", piped.sent && piped.sent.email_confirm, true);
  has("it says the account was made", piped.out, `Made the account for ${EMAIL}.`);
  has("and that the first sign-in sets up a second factor", piped.out, "set up the authenticator app it asks for");
  const crlf = await run({ input: PASSWORD + "\r\nsecond line\r\n" });
  ok("only the first line is the password, without its line ending", crlf.sent && crlf.sent.password, PASSWORD);

  section("The password typed at a terminal:");
  const typed = await run({ typed: [PASSWORD, PASSWORD] });
  ok("the account is made: ends ok, exit 0", typed.end, "user_create=ok/0");
  ok("with the password that was typed", typed.sent && typed.sent.password, PASSWORD);
  has("it asked for it, and said it would not be shown", typed.out, "(not shown as you type): ");
  has("it asked twice", typed.out, "The same password again: ");
  hasnt("the terminal never showed the password", typed.out, PASSWORD);
  hasnt("nor a part of it", typed.out, PASSWORD.slice(4, 16));
  const mismatch = await run({ typed: [PASSWORD, PASSWORD + "x"] });
  ok("two different entries: stops, exit 1", mismatch.end, "user_create=stop/1");
  ok("and nothing was asked of the service", mismatch.log.length, 0);
  const blank = await run({ typed: ["", ""] });
  ok("nothing typed: stops, exit 1, nothing asked", `${blank.end}/${blank.log.length}`, "user_create=stop/1/0");

  section("The password is never an argument:");
  const asArg = await run({ args: [EMAIL, PASSWORD], input: "" });
  ok("a password after the email: stops, exit 2", asArg.end, "user_create=stop/2");
  ok("nothing was asked of the service", asArg.log.length, 0);
  has("it says why", asArg.out, "The password is not taken on the command line");
  has("and how to run it", asArg.out, "Use: npm run user:create -- <email>");
  hasnt("it does not print what was typed there", asArg.out, PASSWORD);

  section("When it stops early, nothing is asked of the service:");
  const noEmail = await run({ args: [], input: "" });
  ok("no email: stops, exit 2, nothing asked", `${noEmail.end}/${noEmail.log.length}`, "user_create=stop/2/0");
  const badEmail = await run({ args: ["not-an-address"], input: PASSWORD + "\n" });
  ok("not an email address: stops, exit 2, nothing asked", `${badEmail.end}/${badEmail.log.length}`, "user_create=stop/2/0");
  const noPassword = await run({ input: "" });
  ok("empty input: stops, exit 1, nothing asked", `${noPassword.end}/${noPassword.log.length}`, "user_create=stop/1/0");
  has("it says no account was made", noPassword.out, "No password given. No account was made.");
  const noEnv = await run({ env: { FLEET_ENV_FILE: join(T, "not-there.local") } });
  ok("no settings file: stops, exit 1, nothing asked", `${noEnv.end}/${noEnv.log.length}`, "user_create=stop/1/0");
  has("with what to do", noEnv.out, "Copy .env.example to .env.local");
  const noKey = join(T, "nokey.local"); writeFileSync(noKey, "NEXT_PUBLIC_SUPABASE_URL=https://fleet-user-test.invalid\n");
  const unset = await run({ env: { FLEET_ENV_FILE: noKey } });
  ok("no service-role key: stops, exit 1, nothing asked", `${unset.end}/${unset.log.length}`, "user_create=stop/1/0");
  has("it names the two settings", unset.out, "needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY");

  section("When the sign-in service says no:");
  const taken = await run({ mode: "taken" });
  ok("an address already in use: stops, exit 1", taken.end, "user_create=stop/1");
  has("in the service's own words", taken.out, "The account was not made: A user with this email address has already been registered");
  const wrongKey = join(T, "wrongkey.local"); writeFileSync(wrongKey, `NEXT_PUBLIC_SUPABASE_URL=https://fleet-user-test.invalid\nSUPABASE_SERVICE_ROLE_KEY=service.${random(48)}\n`);
  const refused = await run({ env: { FLEET_ENV_FILE: wrongKey } });
  ok("a key the service refuses: stops, exit 1", refused.end, "user_create=stop/1");
  hasnt("it does not say the account was made", refused.out, "Made the account");
  const weak = await run({ mode: "weak" });
  ok("an answer that quotes the password back: stops, exit 1", weak.end, "user_create=stop/1");
  has("the quoted password is hidden", weak.out, "Password [hidden] is too weak");
  const deaf = await run({ stub: false });
  ok("nothing listening at the address: stops, exit 1", deaf.end, "user_create=stop/1");

  section("No secret in any output:");
  const all = everything.join("\n");
  hasnt(`the password is in none of the ${everything.length} runs' output`, all, PASSWORD);
  hasnt("nor the service-role key", all, SERVICE_KEY);
  hasnt("nor a part of the key (its last 16 characters)", all, SERVICE_KEY.slice(-16));
  ok("the password and the key were really in play (the stand-in accepted them)", `${piped.code}/${typed.code}`, "0/0");
  const source = readFileSync(SCRIPT, "utf8");
  hasnt("the script does not read a password from its arguments", source, "process.argv[3]");
  hasnt("its own instructions do not use a runner that is not installed", source, "tsx");
}

/* ── controls: each broken copy of the script must fail at least one check ─ */
const CONTROLS = [
  ["a password after the email is accepted as the password", "if (args.length > 1) stop(", "if (false) stop("],
  ["what is typed is shown on the terminal", "    input.setRawMode(true);\n    input.setEncoding(\"utf8\");", "    input.setEncoding(\"utf8\");"],
  ["the password is printed with the result", "console.log(`Made the account for ${email}.`);", "console.log(`Made the account for ${email} with ${password}.`);"],
  ["two different entries are accepted", "if (password !== again) stop(", "if (false) stop("],
  ["an empty password is sent", 'if (!password) stop("No password given. No account was made.");', ""],
  ["the account is made unconfirmed", "email_confirm: true", "email_confirm: false"],
  ["a refusal is reported as an account made", "if (error || !data?.user) {", "if (false) {"],
  ["an answer that quotes the password is printed as it came", '.split(password).join("[hidden]")', ""],
  ["the whole of standard input is the password, line ending and all", 'return text.split("\\n")[0].replace(/\\r$/, "");', "return text;"],
  ["anything is taken as an email address", "if (!/^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(email)) stop(", "if (!email) stop("],
  ["it ends ok when it stopped", 'console.log("user_create=stop");', 'console.log("user_create=ok");'],
];
function selfRun(program) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url)], { env: { ...process.env, FLEET_CREATE_USER_UNDER_TEST: program, QUIET: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (d) => { out += d; });
    child.on("close", () => done(out.trimEnd().split("\n").at(-1) || ""));
  });
}
async function controls() {
  console.log("Controls: each broken copy of the script must fail at least one check.");
  const base = await selfRun(SCRIPT);
  if (!/ 0 failed$/.test(base)) { console.log(`The checks do not pass on the script as it is (${base}), so a control would prove nothing. Fix that first.`); process.exit(1); }
  // The copies import the same packages, so they sit beside a link to this checkout's node_modules.
  const dir = join(T, "copies"); mkdirSync(dir);
  symlinkSync(join(REPO, "node_modules"), join(dir, "node_modules"));
  const source = readFileSync(SCRIPT, "utf8");
  let caught = 0, missed = 0;
  const one = async ([name, from, to], i) => {
    const text = source.split(from).join(to);
    if (text === source) { missed++; console.log(`  MISSED  ${name} (the control itself did not apply)`); return; }
    const copy = join(dir, `create-user-${i}.ts`); writeFileSync(copy, text);
    const out = await selfRun(copy);
    if (/ 0 failed$/.test(out)) { missed++; console.log(`  MISSED  ${name}`); } else { caught++; console.log(`  caught  ${name}`); }
  };
  const queue = CONTROLS.map((c, i) => () => one(c, i));
  await Promise.all(Array.from({ length: 4 }, async () => { while (queue.length) await queue.shift()(); }));
  console.log(`controls: ${caught} caught, ${missed} missed, of ${caught + missed}`);
  process.exit(missed ? 1 : 0);
}

if (process.argv.includes("--controls")) await controls();
else {
  await checks();
  console.log(said.join("\n"));
  console.log(`user test: ${PASS + FAIL} checks, ${FAIL} failed`);
  process.exit(FAIL ? 1 : 0);
}
