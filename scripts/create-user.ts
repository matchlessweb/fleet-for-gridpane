// Makes one account that can sign in to Fleet. Run it for the first user, and
// again for each person you add: with sign-ups off, this is the only way in.
//
//   npm run user:create -- you@example.com
//
// It asks for the password twice and does not show it. The password is never an
// argument: a command line is kept in your shell's history, and `ps` shows it to
// every user of the machine while the command runs. From a password manager or
// a script, send it on standard input instead (the first line is the password):
//
//   pass show fleet/you | npm run user:create -- you@example.com
//
// The account is made already confirmed, so no confirmation email is sent. A
// session opened with a password alone never enters Fleet: at the first sign-in
// the login page has the account set up an authenticator app before it lets it
// past. Until then the password is all that protects the account (SECURITY.md),
// so sign in straight after making it.
//
// It reads NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY from .env.local
// in the folder you run it from, or from the file $FLEET_ENV_FILE names.
// $FLEET_SUPABASE_URL names another address (scripts/test-create-user.mjs points
// it at a stand-in). The password is sent to that address and nowhere else, and
// is never printed. The last line is always user_create=ok|stop.
import { createClient } from "@supabase/supabase-js";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USE = "Use: npm run user:create -- <email>     (it asks for the password; the password is never an argument)";
function stop(why: string, code = 1): never {
  console.error(why);
  console.log("user_create=stop");
  process.exit(code);
}

const args = process.argv.slice(2);
if (args.length > 1) stop(`The password is not taken on the command line, where your shell's history and \`ps\` would keep it. If what you typed after the email was a real password, choose another one.\n${USE}`, 2);
const email = (args[0] || "").trim();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) stop(`${email ? "That is not an email address." : "No email address given."}\n${USE}`, 2);

// The two settings, read by name from the file. Nothing else in it is loaded.
const envFile = process.env.FLEET_ENV_FILE || resolve(process.cwd(), ".env.local");
const settings: Record<string, string> = {};
try {
  for (const line of readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) settings[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
} catch {
  stop(`Cannot read ${envFile}. Copy .env.example to .env.local and fill it in first (npm run doctor says what is missing).`);
}
const url = (process.env.FLEET_SUPABASE_URL || settings.NEXT_PUBLIC_SUPABASE_URL || "").replace(/\/+$/, "");
const serviceKey = settings.SUPABASE_SERVICE_ROLE_KEY || "";
if (!url || !serviceKey) stop(`${envFile} needs NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (npm run doctor says which is missing).`);

/** One line typed at the terminal, with nothing shown as it is typed. */
function typedUnseen(question: string): Promise<string> {
  return new Promise((done, cancel) => {
    const input = process.stdin;
    // Before the question is asked: a terminal still in its usual mode would show what is typed.
    input.setRawMode(true);
    input.setEncoding("utf8");
    input.resume();
    process.stderr.write(question);
    let value = "";
    const end = () => { input.setRawMode(false); input.pause(); input.off("data", onData); process.stderr.write("\n"); };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") { end(); return done(value); }
        if (ch === "\u0003") { end(); return cancel(new Error("Stopped. No account was made.")); }
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1);
        else if (ch >= " ") value += ch;
      }
    };
    input.on("data", onData);
  });
}

/** The first line of standard input, when it is a pipe and not a person. */
async function firstLineOfInput(): Promise<string> {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text.split("\n")[0].replace(/\r$/, "");
}

let password = "";
if (process.stdin.isTTY) {
  try {
    password = await typedUnseen(`Password for ${email} (not shown as you type): `);
    const again = await typedUnseen("The same password again: ");
    if (password !== again) stop("The two did not match. No account was made.");
  } catch (e) {
    stop(e instanceof Error ? e.message : "Stopped. No account was made.");
  }
} else {
  password = await firstLineOfInput();
}
if (!password) stop("No password given. No account was made.");

const supabase = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const { data, error } = await supabase.auth.admin.createUser({ email, password, email_confirm: true });
if (error || !data?.user) {
  // The sign-in service's own words (a password it finds too short, an address already in use).
  stop(`The account was not made: ${(error?.message || "the sign-in service did not return an account").split(password).join("[hidden]")}`);
}

console.log(`Made the account for ${email}.`);
console.log("Next: open Fleet's login page, sign in with that email and password, and set up the authenticator app it asks for.");
console.log("      Do it now. Until it is done the account cannot get past the login page, and its password is all that protects it:");
console.log("      whoever signs in first sets the authenticator up (SECURITY.md). A passkey can be added afterwards, under Settings, Security.");
console.log("      Keep sign-ups off in Supabase: npm run doctor says whether they are.");
console.log("user_create=ok");
