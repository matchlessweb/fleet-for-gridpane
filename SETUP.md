# Setting up Fleet

This is a runbook. Work through the steps in order. Each step has the exact commands, what a person must do by hand
and why, and a check at the end. It is written for a GridPane customer and for a coding agent working for one.

## How to read a step

- **Run** is a command to run from the top of the checkout. An agent may run these unless the step says otherwise.
- **By hand** is something a person must do, with the reason an agent cannot.
- **Check** is what `npm run doctor` should say once the step is done. Run it after every step.
- **Unproven** marks something written from reading the code, not from a run on a new install.
- **Not from the repository** marks something this repository does not say. It is the usual way to do it, and you
  should confirm it in that product's own documentation.

`npm run doctor` changes nothing and prints no secret. It prints one line per check:

| Line starts with | Meaning |
| --- | --- |
| `ok` | It is there and it works |
| `not yet` | A step you have not done. The line says which |
| `FAIL` | It is there and it is wrong. The line ends with `Next:` and what to do |
| `could not check` | The doctor was not able to look. The line says why |

Its last line is `doctor=ok`, `doctor=incomplete` (steps remain, nothing is broken), `doctor=problems` (a `FAIL`
line) or `doctor=blind` (it could not look, which is never a pass). It exits 0, 0, 1 and 3 for those.
`npm run doctor -- --json doctor.json` also writes the result to a file.

One line never goes away: `could not check  Row level security`. The keys in `.env.local` cannot read it. Step 4
shows how to check it another way. That line alone does not stop the last line from being `doctor=ok`.

## Rules for an agent

- Never print a secret, and never ask for one in chat. Secrets go into files and prompts by the person's own hand.
- Do not read `.env.local`. The doctor names each setting with its length, which is all you need.
- Read a server script's header before you run it: it says which form only looks. The look-only forms (`--status`,
  `--dry-run`, `--selftest`, `--print`, `--audit`, and for most scripts no option at all) you may run freely.
  Anything else changes something: any other option (`--apply`, `--live`, `--update`, `--fix`, `--install`, `--clone`, `--set`,
  `--undo`, `--remove`, `--reclaim`, `--prove`, `--enable-plugin` are the ones today). Run
  those only when the person has named the server and the change. `install-operator-allowlist.sh` without
  `--apply` only looks, whatever else is on the line: an address, `--clear`, `--ufw-web` or `--ufw-web-clear`.
  With `--apply`, each of those changes a server. `install-waf-refresh.sh` with no option only looks
  too; `install-waf-refresh.sh --apply` installs a daily job on this machine: that one is the person's to run.
- The doctor contacts your Supabase project and GridPane (nine read-only requests, and one more for each
  account). A wrong GridPane token still costs one of GridPane's 12 requests a minute, so do not run it in a loop.
- If a check does not say what this guide says it should, stop and show the person the doctor's line. Do not guess.

## What you need before you start

| What | Why | Needed for |
| --- | --- | --- |
| A GridPane account with API access, and its API token | The sync reads your servers and sites with it | Everything |
| A Supabase project of your own, new and empty | The database and the sign-in service | Everything |
| A Cloudflare account with a zone (a domain) you control | The app runs on Workers at a hostname on that zone, behind Access | The deployed app |
| Root SSH to your servers with a key | The telemetry agent and the root tools | Monitoring, firewall pages, Fail2Ban, root tools |
| A read-only Cloudflare API token | The WAF inventory | The Cloudflare WAF board |
| A Mac, or patience | The scripts you run from your own machine were written and proven on macOS. "Which machine" below says what a Linux user does instead | The database steps, SSH, the daily WAF job |
| The Supabase CLI, signed in (`supabase login`) | The scripts that change your database or its sign-in settings use its login | Steps 3 and 4 |
| python3 3.6 or later and `/usr/bin/openssl` on each server | The sign-in service runs on the server with them; its installer stops, changing nothing, without them | One-click WordPress sign-in (11c) |

## Which machine

The app itself runs anywhere Cloudflare Workers runs. The **operator scripts**, the ones you run from your own
machine, **assume macOS today**. None of them has been tested on Linux. The table says where a Linux route exists.

| What | macOS | Linux |
| --- | --- | --- |
| `scripts/apply-sql.sh` (the migrations), `scripts/set-email-change-template.sh`, `scripts/dump-schema.sh` (`npm run schema:dump`) | They read the Supabase CLI's login from the macOS keychain | Set `SUPABASE_ACCESS_TOKEN` for that one command (a personal access token from your Supabase account page). All three read it. Proven with a stand-in on a Mac; unproven on Linux |
| SSH to your servers | The system ssh-agent, else the 1Password SSH agent at its macOS path | The system ssh-agent only: `ssh-add` your key |
| The daily WAF job | `scripts/install-waf-refresh.sh --apply` installs a launchd job | No installer. `scripts/waf-refresh.sh` is plain bash: run it from cron. Unproven on Linux |
| The test suites | They pass on a Mac | Not yet proven: run "checks on Linux" by hand from the Actions tab |

---

## Step 1. Tools and the code

You need:

- **Node 22.6 or later** and npm. The TypeScript scripts run under Node's own type stripping. CI uses Node 22.
- **git, bash, curl, python3, openssl, ssh and ssh-add.** macOS and most Linux systems have them. The one-click
  sign-in tests (`sso:test` and the others in 11c) need OpenSSL 3, and a Mac's own `openssl` is LibreSSL:
  `brew install openssl@3`.
- **dig**, for `scripts/lock-web-ports-cloudflare.sh` only (step 11d). It stops at once without it. macOS has it; on
  Debian and Ubuntu it is in the `dnsutils` package.
- **The Supabase CLI**, signed in (`supabase login`). It is not an npm dependency of this project: install it from
  Supabase's own instructions. Only steps 3 and 4 use it.
- **wrangler**, Cloudflare's CLI. It is installed by `npm ci` as a dev dependency: run it as `npx wrangler`.

**Run**

```bash
git clone <this repository's URL> fleet
cd fleet
npm ci
npm run doctor
```

**Check**

```
ok              Node 22.x can run the TypeScript scripts (22.6 or later is needed).
ok              The npm packages are installed (all <n> that package.json names).
...
doctor=incomplete
```

`<n>` is however many packages `package.json` names, its `dependencies` and `devDependencies` together: 25 today,
so the line reads `(all 25 that package.json names)`. The line should say `all` and that number, with none
missing. Most other lines are `not yet`. That is right at this point.

## Step 2. Your settings: `fleet.config.ts` and `.env.local`

### 2a. `fleet.config.ts`

The repository already has this file, a copy of `fleet.config.example.ts`. (If yours does not:
`cp fleet.config.example.ts fleet.config.ts`.) Edit it:

| Setting | Put there |
| --- | --- |
| `name`, `shortName`, `wordmark`, `description`, `footerLabel` | What the app calls itself |
| `hostname` | The hostname the app will live at, like `fleet.example.com`. Passkeys are registered for this hostname, and passkey sign-in is offered only there. It does not have to be the real one yet: any value other than the example clears the doctor line, and a local trial works with a made-up one. It must be the real one before you deploy (steps 9 and 10) |
| `repoUrl` | Where your copy of the code lives |
| `wafRefreshLabel` | A reverse-DNS name under a domain of yours, for the daily WAF job on a Mac |
| `server.prefix`, `server.jailPrefix` | 2 to 15 lowercase letters and digits, starting with a letter. They name the files and Fail2Ban jails Fleet installs on servers |

**Choose the two prefixes before you install anything on a server.** Change them later and Fleet stops recognizing
its own files and jails.

**Run**

```bash
npm run config:test
npm run names:test
```

`names:test` also looks for your own words (four letters or more, from your prefix, name, hostname and job label)
in what the scripts would send to a server under other names. If one of your words is an ordinary word the scripts
use for their own reasons (`server`, `test`, `cloud`), it reports that as a failure and lists the words it looked
for. Run it again with the ordinary word named: `FLEET_NAMES_SHARED_WORDS="server" npm run names:test`. To name two or
more, separate them with spaces inside the quotes: `FLEET_NAMES_SHARED_WORDS="test trial" npm run names:test`. Its part C
prints `NOT RUN`; that is expected on a new install (it is only for an install that had these scripts before the
names became settings).

### 2b. `.env.local`

**By hand: create a Supabase project** if you do not have one for this (in the Supabase dashboard). It must be empty.

**Run**

```bash
cp .env.example .env.local
```

**By hand: fill in the four required values**, in an editor. An agent must not do this: the service-role key and
the GridPane token must not pass through a chat or a transcript. `.env.local` is never committed.

| Name | Where it comes from |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase, Project Settings, API. Like `https://<project id>.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | The same page: the public (anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | The same page. **Secret.** It passes every access rule |
| `GRIDPANE_API_TOKEN` | GridPane, Settings, GridPane API. **Secret** |

Leave the optional ones empty for now. `.env.example` says what each is for.

*Not from the repository:* a newer Supabase project may also show a "publishable" and a "secret" key. This code was
written and tested with the anon and service-role keys. The other pair is unproven here.

**Check**

```
ok              fleet.config.ts passes the config test (21 rules) and the server scripts can read it.
ok              .env.local has the 4 required settings: NEXT_PUBLIC_SUPABASE_URL (40 characters), ...
ok              The database answers with the service-role key.
not yet         The database has none of the 22 tables this code needs: the migrations have not been run yet.
not yet         No user exists yet, so nobody can sign in.
ok              GridPane accepts the API token.
```

On a new Supabase project you will also see `FAIL  Sign-ups are on`. Step 3 fixes it.

If `fleet.config.ts` still reads `not yet ... is still the example`, the hostname is still `fleet.example.com`.

The doctor asks GridPane exactly once. If it says `could not check  GridPane says too many requests`, wait a full
minute before you run it again: asking sooner makes the wait longer.

## Step 3. Supabase project settings

All of these are **by hand**, in the Supabase dashboard: they are your project's own settings, and the repository
has a script for only one of them. Do the first one now. The others can wait until the app has an address.

**For a local trial only** (the app at `http://localhost:3000`, nothing deployed): do items 1 and 4 now. Item 2 is
already right, because a new project's Site URL is `http://localhost:3000`. Item 3 matters only when someone changes
an email address. Item 5 cannot work on localhost, because passkeys are offered only on the hostname in
`fleet.config.ts`. Items 6 to 8 need nothing for a trial, and item 8 matters only once you send real email. Before you
deploy, do all eight.

1. **Turn sign-ups off.** Under Authentication, turn off "Allow new users to sign up". With sign-ups on, anyone who
   has the public key can make an account, add an authenticator of their own and read the database. Accounts are
   made by you (step 5). Making one that way still works with sign-ups off.
2. **Set the Site URL** to the app's address, `https://<your hostname>` (Authentication, URL Configuration). A new
   project has `http://localhost:3000` there. The email links Supabase sends are built from it.
3. **Point the "Change Email Address" email at Fleet's confirm page**, and keep "Secure email change" on.
   `docs/sign-in-email.md` says why and gives the template line. Signed in to the Supabase CLI on a Mac, or with
   `SUPABASE_ACCESS_TOKEN` set, one script does this and the Site URL together. Run it with no option first: it shows the settings and changes nothing.

   ```bash
   bash scripts/set-email-change-template.sh
   bash scripts/set-email-change-template.sh --apply --site-url https://<your hostname>
   ```

   **On Supabase's free plan without your own email sender (item 8)**, Supabase refuses any change to its email
   templates: `--apply` ends `✗ the change was refused (HTTP 400)`, with `entitlement_required` in what Supabase said.
   The script sends the Site URL and the template in one request, so **the Site URL is not set either**. Set the Site
   URL by hand (Authentication, URL Configuration) and leave the template for now, or set up your own email sender
   first and then run the script. Without the template, a change of address is confirmed by Supabase's own link
   (`docs/sign-in-email.md` says what that risks).

4. **Authenticator apps (TOTP) must be allowed.** The login page sets one up for every new account. *Not from the
   repository:* new Supabase projects allow it unless you turned it off; look under Authentication, Multi-Factor.
5. **Passkeys are optional.** Sign-in works with a password plus an authenticator code. If you want passkeys, the
   relying-party hostname set in Supabase Auth must equal `hostname` in `fleet.config.ts`. *The repository does not
   say where that setting is in the Supabase dashboard.*
6. **Realtime needs nothing from you.** The baseline migration adds the four live tables to the project's
   `supabase_realtime` publication when the project has one.
7. **pg_cron is optional.** Where the project offers it, the baseline turns it on and schedules two daily clean-up
   jobs (old telemetry after 7 days, old log entries after 30). Where it does not, they are skipped.
8. **An email sender of your own (custom SMTP)** is worth having: Supabase's built-in sender only writes to the
   project's own team (`docs/sign-in-email.md`).

**Check**

```
ok              Sign-ups are off: an account can only be made by you.
```

The doctor looks at sign-ups only. It cannot see the other seven.

## Step 4. The database

Every file in `supabase/migrations/` builds it (a baseline and the files after it). They are applied **in name order**, each one tried first.

| File | What it does |
| --- | --- |
| `20261120000000_baseline.sql` | Every table, function and access rule. Run once, on a project with no tables of its own |
| `20261120000100_settings_row.sql` | The one row the Settings page needs. Safe to run again |
| `20261121000000_strong_session.sql` | The database refuses a session without a second factor, and the public key loses every table privilege. It checks its own result and stops, changing nothing, if anything is left open. Safe to run again |
| `20261122000000_authenticator_rule.sql` | The database also refuses an account that has no authenticator app, as the app does. It tries the new rule as a signed-in account and stops, changing nothing, if the rule would shut out an account that has one. Safe to run again |
| `20261123000000_site_caching.sql` | Three columns for the site page's caching panel: the page cache's time to live, the Redis object cache and Object Cache Pro. Adds columns only; the next sync fills them. Safe to run again |
| `20261124000000_sync_runs.sql` | A record of each sync, so every screen can show one running and how the last one ended, and so only one runs at a time. Read-only to the app's pages. Adds a table only. Safe to run again |

**By hand, on a Mac:** `scripts/apply-sql.sh` uses the Supabase CLI's own login from the macOS keychain, and its
header says a person runs it, not an agent. Sign in first with `supabase login`. The project is the one named by
`FLEET_SUPABASE_PROJECT_REF`, else the one the Supabase CLI linked this checkout to, else the one in `.env.local`;
with none of those it stops. Each file runs as one transaction: `--dry-run` runs it and rolls it all back, and a real
run is applied whole or not at all.

```bash
bash scripts/apply-sql.sh supabase/migrations/20261120000000_baseline.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261120000000_baseline.sql
bash scripts/apply-sql.sh supabase/migrations/20261120000100_settings_row.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261120000100_settings_row.sql
bash scripts/apply-sql.sh supabase/migrations/20261121000000_strong_session.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261121000000_strong_session.sql
bash scripts/apply-sql.sh supabase/migrations/20261122000000_authenticator_rule.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261122000000_authenticator_rule.sql
bash scripts/apply-sql.sh supabase/migrations/20261123000000_site_caching.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261123000000_site_caching.sql
bash scripts/apply-sql.sh supabase/migrations/20261124000000_sync_runs.sql --dry-run
bash scripts/apply-sql.sh supabase/migrations/20261124000000_sync_runs.sql
```

A dry run ends with `✓ dry run clean: ... Nothing changed.` and a real run with `✓ applied: <file>`. Anything else
starts with `✗` or `ABORT`, says why, and has applied nothing. Do not go on to the next file.

`sso_schema.sql` at the top of the repository is not part of this step: it is only for step 11c. Any other `.sql`
file there is an earlier step the baseline already holds: do not run it.

**To undo the fourth file** if the app comes up empty for an account that has an authenticator app and did pass its
second factor: `bash scripts/apply-sql.sh supabase/rollbacks/20261122000000_authenticator_rule.sql`. If it is still
empty, undo the third as well: `bash scripts/apply-sql.sh supabase/rollbacks/20261121000000_strong_session.sql`.
Read each file's header first.

**With no keychain (Linux)** set `SUPABASE_ACCESS_TOKEN` for each of those commands; the script uses it in place of
the keychain login (see "Which machine"). A person does this, not an agent: the token can change your whole
Supabase account. *Unproven on Linux.* The last resort is to paste each file, whole and in the same order, into the
Supabase SQL editor; this guide has not checked that the editor runs a file as one transaction, so read the result
of each run before the next.

**Then check the structure, access rules included.** The first command is **by hand** for the same reason as above
(on Linux, with `SUPABASE_ACCESS_TOKEN` set for that one command). It reads the structure only, no rows, and writes
`~/.config/fleet/schema-dump.json`, outside the repository. The second compares that file with what the baseline and the
migrations after it build, on a Postgres in memory.

```bash
npm run schema:dump
npm run schema:drift
```

The first ends with `schema_dump=ok`. The second ends with `baseline: <n> checks, 0 failed  (compared with a
capture, not the snapshot)`. A failed check there names what differs: a migration not applied, or a database that
was changed by hand.

**Check**

```
ok              The database has everything this code needs: 22 tables, 240 columns, 8 functions.
ok              What the <n> migrations after the baseline add is there: a row in app_settings, the function session_is_strong, the function account_has_authenticator, ... the table sync_runs.
could not check Row level security: the keys in .env.local cannot read whether it is on for every table.
```

The counts are today's and change when the structure does. `<n>` is how many migration files follow the baseline: 5 today.
The doctor counts what the baseline snapshot (`supabase/schema.snapshot.json`) lists, and the later migrations are
checked in the next line. `npm run schema:dump` counts the live database, so it reports more tables, columns and functions:
the ones the later migrations add, and any function Supabase itself puts in the `public` schema
(`rls_auto_enable` on a new project). On a new project that is 23 tables, 258 columns and 11 functions in the dump
against 22, 240 and 8 here. That is not a fault. If you see
`FAIL  A migration has not been applied to the database`, the line names the file and the command.
`FAIL  The database is older than this code` names the tables, columns or functions that are missing.

The `Row level security` line stays as it is: `npm run schema:drift` is the check for it.

## Step 5. The first user

**By hand:** the command asks for a password twice and does not show it. An agent must not choose or see it.

Type your own address in place of `<your email address>`, and take the angle brackets out too. The line is written so
that pasting it as it stands fails with a shell syntax error and makes no account.

```bash
npm run user:create -- <your email address>
```

Your address must be one you can receive mail at: a later change of address is confirmed by email
(`docs/sign-in-email.md`, "What the first account needs"). The password is never an argument. From a password
manager, send it on standard input instead: `pass show fleet/you | npm run user:create -- <your email address>`.

It ends with `user_create=ok`. The account is made confirmed, so no email is sent.

**Set up the authenticator app straight away.** At the first sign-in the login page has the account scan a QR
code with an authenticator app and enter its 6-digit code. Until that is done the account cannot get past the login
page, and its password is all that protects it: whoever signs in first sets the authenticator up (SECURITY.md).
Once it is set up, a password alone gets nowhere. A passkey can be added afterwards under Settings, Security; it
does not replace the authenticator app. You sign in for the first time once the app has an address (step 10), or
now on this machine with `npm run dev` at `http://localhost:3000`.

Run the same command for each person you add.

**Check**

```
ok              1 user exists.
not yet         1 account has never signed in and has no authenticator app yet (id 1a2b3c4d…). Until it is set up, the password alone is enough to enter.
```

The second line turns to `ok` once the account has signed in and set up its authenticator app. An account that has
signed in before and still has none is a `FAIL`. The doctor names accounts by the start of their id, never by
address.

## Step 6. The first sync from GridPane

GridPane allows about 12 requests a minute **on each route** (the server list, the domain list, the site list, one
site's record), and that allowance is shared by everything that uses the same token: the doctor (it asks for the
server list once), a second copy of Fleet, any other tool of yours. A sync spends its first requests on the server
list and the domain list, then asks for the site list. **Wait a minute or two after the doctor** before you start: a
sync that starts into a used-up minute is refused at once.

If another copy of Fleet, or another tool, uses the same GridPane token, the sync may be refused several times before
it gets through.
Space the tries a few minutes apart. **Never retry at once**: asking sooner makes GridPane's wait longer.

Start it one of two ways. Both write the same record, so the app and the terminal each show a sync the other started,
and only one runs at a time.

- **In the app** (from step 5 on, at `http://localhost:3000`): Settings, Setup, **Start the first sync**. The overview
  points there until the first sync has run. Nothing syncs until you press it. It runs in that browser tab: you can
  move around the app, but keep the tab open until it finishes. A blinking dot in the top bar shows it running on every
  screen you are signed in on.
- **In the terminal:**

  ```bash
  npm run sync
  ```

To follow a sync from a terminal, whichever way it started (an agent can run this too; it only reads):

```bash
npm run sync:status -- --watch
```

A sync reads your servers, the domain list, the site list, then each site's own record. In the app it reads about
one site every 11 seconds, so 100 sites take about 18 minutes. `npm run sync` reads one about every 5.5 seconds and
prints its own estimate when it starts. `npm run sync` ends one of these ways:

- `Sync complete.` Every site was read.
- `Sync finished, except N site(s) that could not be read (the [!] lines above)`, exit code 2. GridPane refused those
  sites. What was read is saved; run it again in a few minutes to read the rest.
- `[ABORTED]`, exit code 1. GridPane refused a whole list (HTTP 429). Nothing from that list was saved, but what was
  saved before it stays saved: the servers, for example, when the site list was refused. Wait a minute or two, then
  run it again.
- `[BUSY]`, exit code 1. Another sync is running (in the app, or another terminal). Nothing was read.
- `[FAILED]`, exit code 1. Anything else: the database refused a write, or GridPane gave another error. The line
  says which.

Once the app is deployed, the Sync button in its masthead does the same as the Setup page's button. To run it on a
schedule from this machine, `scripts/cron-sync.sh` runs `npm run sync`; its header has an example cron line.

**Check**

```
ok              The database holds 3 servers and 41 sites.
ok              The last sync finished 4 minutes ago and read all 41 sites.
```

From here the doctor also lists the servers under `7. Server agents`. They read `not yet ... no agent token is
registered` until step 8, on one line for all the servers waiting the same way.

**Steps 7 and 8 are optional.** Without them the Monitoring page and the per-server firewall, Fail2Ban, WAF and PHP
code cache panels stay empty, and the root tools cannot run. Everything from GridPane still works. If you skip them,
go to step 9, and the doctor will end `doctor=incomplete`.

## Step 7. The server list and your SSH key

The scripts that connect to servers read one list, kept outside git.

**Run**

```bash
npm run servers:export
```

It writes `scripts/servers.local` from your database (`-- --home` writes `~/.config/fleet/servers` for every
checkout on this machine; `-- --print` only prints). Each line is `<ip address>|<GridPane server id>|<label>`.

A label may hold only letters, digits, `.`, `_` and `-`. If one of your servers has a space or any other character in
its GridPane label, the command writes nothing and names those servers. Rename them in GridPane (`web 1` to `web-1`,
say), run the sync again (step 6), then run `npm run servers:export` again.

**By hand: mark one server golden.** Add `|golden` to the end of exactly one line. It is the server the install
scripts copy known-good files from. On a new fleet, choose the server you will set up first. Nothing in step 8
uses it yet (only `--install` and the log-rotation `--clone` copy from it, and on a new fleet it has nothing to copy:
step 11d gives the order), but the doctor reads `not yet` until one line is marked, so mark it now.

**By hand: your SSH key.** The scripts connect as `root`. Your public key must be accepted for root on each server.
*Not from the repository:* GridPane customers add an SSH key to a server in GridPane's own settings. Then load the
key: `ssh-add <your key file>`. To hold the scripts to one key, put its fingerprint (`ssh-add -l` prints it, the
part that starts `SHA256:`) in `~/.config/fleet/ssh-key-fingerprint` (or in `FLEET_SSH_KEY_FP` for one run). With none
set, any key the agent holds counts.

On a Mac the scripts fall back to the 1Password SSH agent, but only when the system agent holds no key that counts.
**If your key is in 1Password and the system agent holds any other key** (one loaded for something else), the
scripts stay with the system agent, never ask 1Password, and every server fails to sign in. The fix is to pin your
key's fingerprint: list the keys 1Password holds with
`SSH_AUTH_SOCK="$HOME/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock" ssh-add -l`, then put the
`SHA256:` part of the right one in `~/.config/fleet/ssh-key-fingerprint`. The system agent then no longer counts, and
the scripts use 1Password.

Know this before the first connection: the scripts accept a server's host key the first time they connect
(`StrictHostKeyChecking=accept-new`) and refuse to connect if it later answers with another one. They keep those
keys in Fleet's own file, `~/.config/fleet/known_hosts` (`FLEET_KNOWN_HOSTS` names another), and never read or write
`~/.ssh/known_hosts`. After a server is rebuilt at the same address, a script stops and prints the command that
forgets the old key: `ssh-keygen -R <address> -f ~/.config/fleet/known_hosts`. If the server was not rebuilt, stop
and look into it before you connect.

**Check**

```
ok              The server list parses: 3 servers, one marked golden (web1).
ok              The ssh-agent holds 1 key.
```

Neither line proves root SSH works on a server: the first real connection is step 8's look. The doctor numbers its
own groups: these two lines are under `8. This machine`, which it prints after
`7. Server agents` (step 8 of this guide).

## Step 8. The telemetry agent and its tokens

Each server runs one small script, `/root/telemetry-agent.sh`, from root's cron every 10 minutes. It opens no port
and its only network calls are outbound, to your Supabase project. Each call must carry that server's own token: the
database made in step 4 refuses a report without one. So the order below matters, and it is **not** the obvious one.

**What it leaves on the server besides itself.** To read each PHP version's code cache (OPcache), the agent keeps one
small read-only PHP file, `/var/lib/<prefix>-fleet/opcache-probe.php` (`<prefix>` is `server.prefix` in
`fleet.config.ts`), outside every web root, and asks that PHP version's own PHP-FPM pool to run it through its local
socket. The numbers can be read only from inside the running PHP: the command line has a separate, empty cache. It
changes no PHP or GridPane setting. When the read fails, the site and server pages show the cache as **Cannot see**,
with the reason, and still show the settings as written in `php.ini`. The usual reasons: `opcache.restrict_api` is set
or `opcache_get_status` is disabled (PHP refuses to give the numbers), the pool's `open_basedir` does not include that
folder (PHP will not run the file), the agent could not write the file, or the pool was not answering on its socket.
A PHP version with no site on it shows only its settings, since there is no running PHP to ask.

**Prove it on one server first.** Replace `web1` with one of your labels. A person names the server; an agent runs
the audits.

1. **Look.** Read-only.

   ```bash
   bash scripts/fix-telemetry-crontabs.sh
   ```

   A new server reads `no agent installed`. Ignore its hint to use `--install`: that copies the golden server's
   agent, and on a new fleet the golden server has none yet.

2. **Send the agent.** `--update` fills in this repository's agent with your names (`fleet.config.ts`) and your
   project's address and public key (`.env.local`), writes it to the server with that server's id, sets one cron
   line and runs it once.

   ```bash
   bash scripts/fix-telemetry-crontabs.sh --update web1
   ```

   On a new server expect `token=ABSENT (run scripts/provision-agent-tokens.sh)`, then
   `✗ UPDATE DID NOT VERIFY — no agent was here before, so there is no old copy.` and a line naming the next
   command, `bash scripts/provision-agent-tokens.sh --apply web1`. That is right at this point: the agent is in place
   and has no token yet. Its run lines show the reports refused: the telemetry, hardware and firewall reports with
   HTTP 401, the Fail2Ban, WAF and OPcache reports with HTTP 404. Both are expected before the token.

3. **Give it its token.** The script makes a random token, registers only its hash in your database, then writes
   the token on the server and runs the agent. The token is never printed and never kept on your machine.

   ```bash
   bash scripts/provision-agent-tokens.sh --apply web1
   ```

   Expect `hash registered` and
   `✓ token active — all six reporters authenticated (telemetry, hardware, firewall, Fail2Ban, WAF, OPcache)`.

4. **Look again.** `bash scripts/provision-agent-tokens.sh` shows each server's token state and when it last
   reported. Running step 2 again now keeps the token and should end `✓ updated and reporting`.

**Check**

```
ok              web1: the agent reported under a minute ago.
not yet         web2: no agent token is registered for it, so its agent has never reported.
```

**Then the rest.** The same two commands without a server name do every server in the list:
`bash scripts/fix-telemetry-crontabs.sh --update`, then `bash scripts/provision-agent-tokens.sh --apply`.

An agent that has gone quiet reads `FAIL ... the agent last reported 3 hours ago, more than 30 minutes`. On that
server, run `/root/telemetry-agent.sh` by hand and read what it says.

When `scripts/telemetry-agent.sh` changes in git, `--update` sends the new one and keeps each server's token.

## Step 9. Deploy the app

The repository already has `wrangler.jsonc`, a copy of `wrangler.example.jsonc`. (If yours does not:
`cp wrangler.example.jsonc wrangler.jsonc`.) If you change the Worker's `name`, change `services[0].service` to the
same name.

**By hand:** sign wrangler in. It opens a browser.

```bash
npx wrangler login
```

*Not from the repository:* if your Cloudflare login reaches more than one account, wrangler asks which to use. To
answer ahead of time, set `CLOUDFLARE_ACCOUNT_ID` for the command.

**If the `wrangler login` sign-in has expired**, or you would rather not keep one, wrangler also takes a Cloudflare
API token from the environment variable `CLOUDFLARE_API_TOKEN`, with `CLOUDFLARE_ACCOUNT_ID` beside it. It serves
every wrangler command in this guide, including those inside `npm run deploy`, `scripts/set-access-check.sh` and
`scripts/sso-make-keys.sh` (step 11c). *Not from the repository:* make the token in the Cloudflare dashboard (My
Profile, API Tokens) from the "Edit Cloudflare Workers" template, limited to the one account. It can change Workers,
so keep it as you keep the keys in `.env.local`: in a password manager or a file only you can read, never in the
repository.

**Run**

```bash
npm run deploy:first
```

It builds the app, takes your keys out of what it built, and deploys the Worker. The two `NEXT_PUBLIC_*` values are
read from `.env.local` when it builds and are built into the app, so they must be set (step 2) before this.

**Why keys are taken out.** The build tool copies every line of `.env.local` into the Worker's code. A key in a
Worker's code can be read by any person, and any API token, that is allowed to read your account's Workers. So
`scripts/strip-build-secrets.mjs` runs between the build and the deploy: it keeps only the `NEXT_PUBLIC_*` names,
then looks through every built file for the values it took out. Its last line must be `build_secrets=clean`, or
nothing is deployed. Do not deploy with `npx opennextjs-cloudflare deploy` or `npx wrangler deploy` by themselves:
both skip that step.

**By hand: the Worker's two secrets.** Each command asks for the value; paste it at the prompt. An agent must not:
it would have to hold the value.

```bash
npx wrangler secret put GRIDPANE_API_TOKEN
npx wrangler secret put SUPABASE_SERVICE_ROLE_KEY
```

**Every later deploy** is `npm run deploy`. It also asks the Worker which secrets it holds, and stops, naming the
command to run, if `.env.local` has a setting that the Worker does not (as a secret, or under `vars` in
`wrangler.jsonc`). `deploy:first` skips only that question, because a Worker that does not exist yet cannot answer.

**The Worker has no address yet, on purpose.** `workers_dev` is `false` in `wrangler.jsonc`: the default
`*.workers.dev` hostname would serve the same app and let anyone walk around Cloudflare Access. It gets its address
at the end of step 10, after Access is in front of it.

**Check.** The doctor does not look at the deployment. This lists the names of the Worker's secrets, never their
values, and should show both. The second lists the Worker's versions, newest last, with the time you deployed:

```bash
npx wrangler secret list
npx wrangler deployments list
```

## Step 10. Cloudflare Access, then the app's address

**What the repository tells you**

- The app is built to sit behind Cloudflare Access, with its own sign-in behind that (`SECURITY.md`). Its own
  sign-in is not meant to be the only door.
- The default `*.workers.dev` address is off, so the custom hostname is the only way in.
- Two settings make the app check Access itself. When `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` are set, the
  app refuses every request that does not carry a valid Access token, before its own login page
  (`lib/access-gate.ts`). It verifies the token's signature against your team's published keys and checks that it
  was issued for this application (`lib/sso/access-jwt.ts`). Without them the app trusts that Access is in front.
- Set both or neither. With only one of the two set, the app refuses every request and says which settings it
  needs: half a setup must never read as no check. So the two are never written one at a time:
  `scripts/set-access-check.sh` sends both in one request, or removes both in one request.
- The team address may be pasted as `https://yourteam.cloudflareaccess.com/`: the app takes the `https://` and
  the `/` off. An address with a path in it is refused, and the refusal says the address is wrong.
- The app fetches your team's keys from Cloudflare and keeps them for ten minutes. If Cloudflare cannot be
  reached when they are due again, it goes on using the keys it holds, for up to a day from when it fetched
  them, so a short failure there does not take the app down. While it holds keys, it waits ten seconds after
  a failed fetch before it asks again. The fetch gives up after three seconds.
- With no keys at all (a Worker that has just started) every request that carries a token asks Cloudflare,
  so on a healthy start the requests that arrive together are all let through. If Cloudflare does not answer,
  each of them is refused with a 503. Once one of those fetches has failed, and for ten seconds after any
  failure, the Worker starts at most one fetch a second and refuses the other requests of that second without
  asking. That limit begins only when the first failure is seen: until then each request has started its own
  fetch, so a Cloudflare that takes three seconds to fail is sent about three seconds' worth of requests
  first, and about one a second after that. The first fetch that is answered ends the limit, and every
  request from then on is let through. Each running copy of the Worker counts for itself.
- A token that names a key the app does not hold sends it back to Cloudflare for one more look (anyone can
  send such a token). After a look that Cloudflare answered, the next one is a minute later. After a look that
  got no answer, the next one is ten seconds later. When Cloudflare answers and the key is not there, the
  request is refused with a 403. When the look is not made, or gets no answer, it is refused with a 503 that
  says to try again: the key may be one Cloudflare has just started signing with.

**What it cannot tell you:** how to create the Access application, who to let in, or how to give the Worker its
hostname. `wrangler.example.jsonc` has no route. Those are steps in Cloudflare's dashboard, and the policy is yours.

**By hand,** in this order, so the app is never reachable without Access. *Not from the repository:*

1. In Cloudflare Zero Trust, add a self-hosted Access application for `https://<your hostname>`.
2. Give it a policy that allows only the people who should reach Fleet: **Action** `Allow`, and under **Include**,
   the selector `Emails` with the address of each person. Never `Bypass`: a bypassed request carries no Access
   token, and the app will refuse it. Leave the other options off.
3. Note two values: your team's address, like `yourteam.cloudflareaccess.com`, and the application's audience tag
   (AUD: 64 hex characters). The tag exists only once the application is made: after you click Create, open the
   application again (Access, Applications, your application) and read it on its Overview tab.
4. In the Cloudflare dashboard, open the Worker, then Settings, Domains & Routes, and add a custom domain equal to
   `hostname` in `fleet.config.ts`. The zone must be in the same Cloudflare account. **Pick the zone from the list
   first, then type only the subdomain** (`fleet` for `fleet.example.com`): typing the whole hostname opens a dialog
   to buy a domain instead. If you are asked where the domain applies, choose **Production** only, never "Production
   and Preview": preview addresses would sit outside the Access application. The Domains tab goes on listing the
   `*.workers.dev` and preview addresses even while they are turned off; listed is not the same as reachable, and
   `workers_dev` stays `false` in `wrangler.jsonc`.

**By hand: give the two values to the Worker, together.** The app reads them the way it reads its secrets. Check
first that the Access application covers the whole hostname and has no Bypass policy: a request Access lets
through without a token is one the app will refuse.

```bash
bash scripts/set-access-check.sh                                                               # look: is the check on, off, or half set
bash scripts/set-access-check.sh --apply --team-domain <team>.cloudflareaccess.com --aud <audience tag>   # CHANGES the Worker: on
bash scripts/set-access-check.sh --apply --off                                                 # CHANGES the Worker: off again
```

Do not use `npx wrangler secret put` for these two: between the first and the second, the app refuses every
request.

Leave them out of `.env.local` unless this machine's copy of the app also sits behind Access: a local run with
them set refuses every request, because nothing puts an Access token on it. **If you set this app up before the
app-wide check existed,** `.env.example` then listed both under `.env.local`, where they affected two routes
only. Take them out: with them there, `npm run dev` refuses every page, the login page included. A development
run says so in the refusal, and the doctor flags them (`settings.access`). Copy the two lines to
`~/.config/fleet/privacy-extra` first: `npm run privacy:denylist` reads them there, so the privacy gate (step 12)
still keeps your team's address and the audience tag out of anything you publish.

**Check.** Open the app. It loads as before, and every answer carries the header `x-fleet-access-check: on`
(the browser's network panel shows it). The doctor cannot see the Worker or your Access policy: it only reads
`.env.local`. `bash scripts/set-access-check.sh` with no option says which of the three states the Worker is in.

By hand:

1. Open `https://<your hostname>` in a private window. Cloudflare Access must stop you before you see Fleet.
2. Pass Access. You should see Fleet's login page.
3. Sign in with the account from step 5 and set up the authenticator app it asks for.
4. The dashboard should show your servers and sites. Now do the rest of step 3 (the Site URL and the email
   template), which needed this address. On Supabase's free plan, read the note under step 3, item 3, first.
5. In the browser's network panel, open any request to Fleet and read its response headers. `x-fleet-access-check: on`
   means the app is checking every request's Access token. `off` means the Worker does not hold the two settings.

## Step 11. Optional features

The doctor does not look at any of these. Each has its own way to check.

### 11a. The Cloudflare WAF board

The app never holds a Cloudflare token. A job on your own machine reads Cloudflare once a day and loads the result.

**By hand: the token.** Create a Cloudflare API token that can **read** zones, zone WAF rulesets and DNS. A
read-only token is enough and is the right one. Put it where the scripts look. The first of these that is set is
used (`scripts/lib-fleet-token.sh` has the details):

1. the environment variable `FLEET_CF_TOKEN_ALL_READ`
2. a command of your own that prints the token, on one line in `~/.config/fleet/cloudflare-token-command`, with
   `{name}` where the token's name goes (for a password manager: `pass show cloudflare/{name}`)
3. the token alone in the file `~/.config/fleet/tokens/cloudflare-all-read.token`, readable by you only

For the file: `mkdir -p ~/.config/fleet/tokens && install -m 600 /dev/null ~/.config/fleet/tokens/cloudflare-all-read.token`,
then open it in an editor and paste the token. A scheduled job has no environment of yours, so use 2 or 3 for the
daily run.

**Run**

```bash
python3 scripts/waf-inventory.py --selftest     # offline checks; asks Cloudflare nothing
bash scripts/waf-refresh.sh --dry-run           # reads Cloudflare, checks the report, writes nothing to the database
npm run waf:refresh                             # the same, and loads it
```

**By hand, on a Mac: the daily job.** Run it from your main checkout, not a git worktree.

```bash
bash scripts/install-waf-refresh.sh             # look: what --apply would install; changes nothing
bash scripts/install-waf-refresh.sh --apply     # install or update the job: daily at 06:15
bash scripts/install-waf-refresh.sh --status    # is it installed, and its last log lines
```

Optional settings, all described at the top of `scripts/waf-refresh.sh` and `scripts/waf-inventory.py`:

- **Your written standard**, so zones are compared and not only listed: its path in `WAF_STANDARD`, or on one line
  in `~/.config/fleet/waf-standard`. `docs/cloudflare-waf-standard.md` has the format. Without one, every zone with
  rules reads as "custom".
- **Where runs are kept:** `FLEET_OUTPUT_DIR`, or a full path on one line in `~/.config/fleet/output-dir`. The
  default is `~/.local/state/fleet`. If earlier runs, audits or snapshots are kept in another folder, set one of the
  two to it; a script that finds nothing says which folder it searched. With `XDG_CONFIG_HOME` set, the settings
  files of 11a and 11b (the tokens, `output-dir`) are looked for under `$XDG_CONFIG_HOME/fleet`, but
  **`XDG_CONFIG_HOME` does not move the output folder**: only an `output-dir` file there does. The default output
  folder follows `XDG_STATE_HOME` instead (`$XDG_STATE_HOME/fleet`).
- **A page of your own:** `WAF_PAGE_TEMPLATE`, or one line in `~/.config/fleet/waf-page-template`.

**Check:** in the app, Settings shows "Cloudflare WAF inventory" with the time of the last check, and Firewall,
Cloudflare WAF lists your zones.

### 11b. Fail2Ban behind Cloudflare

Per-site jails that ban at Cloudflare, in that site's own zone. Read each script's header first: it says exactly what
is written on the server and how to remove it. It needs the Cloudflare inventory from 11a, and one Cloudflare token
per server.

**1. Your own address on the allowlist. Required, not optional.** A new server's allowlist is empty, so the address
you work from (your office or home) can be banned like any other. Find your address as the internet sees it, then
put it on the allowlist before anything else. Use a fixed home or office address, never a phone hotspot: those are
shared and change. `203.0.113.50` stands for your address:

```bash
bash scripts/install-operator-allowlist.sh                             # look: which addresses can never be banned, per server
bash scripts/install-operator-allowlist.sh 203.0.113.50 web1           # look: what --apply would write on web1
bash scripts/install-operator-allowlist.sh --apply 203.0.113.50 web1   # CHANGES web1: your address can never be banned there
```

It writes `/etc/fail2ban/jail.d/<prefix>-allowlist.local` (`<prefix>` is `server.prefix`), which keeps the loopback
addresses too. Several addresses go in one quoted argument: `"203.0.113.50 198.51.100.0/24"`.

**2. The server's Cloudflare token.** One token per server, named `f2b-<label>` (`f2b-web1`; the label in lower case,
`_` written as `-`), kept in one of the three places from 11a: `FLEET_CF_TOKEN_F2B_WEB1`, your token command, or the
file `~/.config/fleet/tokens/cloudflare-f2b-web1.token`. First audit the server, which is read-only. Its output
includes a line `outbound IPv4: <address>`: that is the address the token is locked to.

```bash
bash scripts/fleet-fail2ban.sh web1                            # audit: read-only
```

*Not from the repository:* in the Cloudflare dashboard (My Profile, API Tokens, Create Token, Custom token):

| Setting | Value |
| --- | --- |
| Permissions | `Zone` / `Zone` / `Read`, and `Zone` / `Firewall Services` / `Edit` |
| Zone Resources | Include, Specific zone: only the zones of the sites on this server. Add one line per zone |
| Client IP Address Filtering | `Is in`, the server's `outbound IPv4` address from the audit |
| TTL | An end date is fine |

Every call the server makes to Cloudflare is forced onto IPv4 (`curl -4`), which is why the filter holds the IPv4
address. With such a token, run from the server, a check of the token, and the making and removing of a block, all
work; from any other machine Cloudflare answers `Authentication error`, which shows the address lock holds. To prove
yours from the server (it makes one Cloudflare rule on a documentation-only address and removes it again):

```bash
bash scripts/fleet-fail2ban-token-proof.sh web1 example.com <zone id>
```

The zone id is on the zone's Overview page in the Cloudflare dashboard.

**3. Apply.** Audit the server again right before you apply. The audits are kept in one folder per day, and the apply
script reads the newest folder, not that server's newest audit. If you last audited web1 on an earlier day than
another server, it stops with `no audit for web1`; if you audited web1 hours ago, it applies what that audit saw.

```bash
bash scripts/fleet-fail2ban.sh web1                            # audit again: read-only
bash scripts/fleet-fail2ban-apply.sh web1                      # dry run: changes nothing on the server
bash scripts/fleet-fail2ban-apply.sh web1 --live               # CHANGES web1: write, reload, prove with a ban and unban
```

**What nothing here checks.** The jails read the lines the WP Fail2Ban plugin writes to `/var/log/auth.log`, and
they ban the address at the end of each line. Behind Cloudflare that must be the visitor's own address, not one of
Cloudflare's. The proof at the end of `--live` writes a line of its own, so it does not test this. To check it: on one
site with the plugin on, sign in once with a wrong password, then on the server run
`grep 'wordpress(' /var/log/auth.log | tail -3`. The newest line reads `Authentication failure for <user> from
<address>` (or `Authentication attempt for unknown user <user> from <address>`), and that address must be yours. If it is one of Cloudflare's addresses, the jails would ban Cloudflare in your zone: stop and fix the site's
real-visitor-address setting first.

### 11c. One-click WordPress sign-in

Off until you turn it on. It needs Cloudflare Access (step 10): the routes refuse a request without a valid Access
token. Read `sso_schema.sql`, `scripts/sso-make-keys.sh` and `scripts/install-fleet-sso-agent.sh` first.

```bash
bash scripts/apply-sql.sh sso_schema.sql --dry-run
bash scripts/apply-sql.sh sso_schema.sql
bash scripts/sso-make-keys.sh                               # look only
bash scripts/sso-make-keys.sh --apply --user-ids <your Supabase user id>
bash scripts/set-access-check.sh                            # look: both Access settings from step 10 must be on the Worker
bash scripts/install-fleet-sso-agent.sh                     # audit every server
bash scripts/install-fleet-sso-agent.sh --apply web1        # CHANGES web1: installs the service
```

- **The user id** is in the Supabase dashboard, Authentication, Users: copy the account's UID. Several go in one
  argument, separated by commas with no spaces.
- **`sso-make-keys.sh` puts the private keys straight into the Worker's secrets**, so it needs wrangler signed in
  (`npx wrangler login`) or `CLOUDFLARE_API_TOKEN` set, as in step 9.
- **The audit lists every server; install one at a time** with `--apply <server>`, and prove sign-in on that server
  before the next.

Then turn it on in the app: the master switch under Settings, Security, and each site on its own page. A site must
already be in Fleet (step 6 synced it) before sign-in can be turned on for it; otherwise the app answers
`Fleet has no such site on that server.`

Run in this order, the service makes a sealed sign-in link in a few seconds, the link signs in to WordPress (a
redirect to `/wp-admin/`), and a second use of the same link is refused with HTTP 410. The tests (`npm run sso:test`, `sso:schema:test`, `sso:keys:test`, `sso:install:test`, `sso:e2e`) run
against stand-ins. So does `npm run accesscheck:test`, for `scripts/set-access-check.sh`.

**Testing on a copy of a live site:** the sign-in link uses the site's real hostname. If that hostname's DNS still
points at the old server, the button signs you in there, not on the copy.

`sso_schema.sql` is not one of the migrations. Once it is applied, `npm run schema:drift` (step 4) holds your capture
to the migrations plus that file, and one of its lines says so. `npm run drift:test` proves that against stand-ins.

### 11d. The other root tools

Each audits or does a dry run by default. The header of each says what it changes and how to undo it.

| Script | What it is for |
| --- | --- |
| `scripts/lock-web-ports-cloudflare.sh` | Lock a server's ports 80 and 443 to Cloudflare's addresses, and undo it |
| `scripts/install-certbot-port-hook.sh` | Keep certificates renewing on a server locked that way |
| `scripts/install-7g-logrotate.sh` | Rotate the 7G WAF log, which GridPane does not |
| `scripts/fleet-server-snapshot.sh`, `scripts/fleet-server-restore.sh` | Save a server's hand-added settings before a move, and put them back |
| `scripts/fleet-site-hold.sh`, `scripts/fleet-site-final-copy.sh` | Move a busy site in two passes without losing an order |

**Locking web ports to Cloudflare, in this order** (from the header of `scripts/lock-web-ports-cloudflare.sh`). It
refuses to lock a server where any site's DNS points straight at it (a grey cloud), because that site would stop
loading. The lock uses GridPane's own `gp cloudflare enable`; SSH and other ports are untouched.

```bash
bash scripts/lock-web-ports-cloudflare.sh                      # look: audit every server
bash scripts/lock-web-ports-cloudflare.sh --audit web1         # look: audit one server
bash scripts/lock-web-ports-cloudflare.sh --apply web1         # CHANGES web1: back up the firewall, lock, verify
bash scripts/install-certbot-port-hook.sh                      # look: which servers have the renewal hooks
bash scripts/install-certbot-port-hook.sh --apply web1         # CHANGES web1: the hooks that keep its own certificates renewing
bash scripts/install-certbot-port-hook.sh --prove web1         # CHANGES web1 for a moment: a test renewal; the hooks open and close the ports
bash scripts/install-operator-allowlist.sh --ufw-web 203.0.113.50 web1          # look: would it open 80 and 443 to your address
bash scripts/install-operator-allowlist.sh --apply --ufw-web 203.0.113.50 web1  # CHANGES web1: open 80 and 443 to your address only
```

Lock first, then the certbot hooks, and only then `--ufw-web`: the lock's own check that a request straight to the
server times out would pass for the wrong reason if your address were already let in. `--ufw-web` is needed only to
reach the tools GridPane serves from the server's own hostname (phpMyAdmin, Monit). Each is taken back with
`lock-web-ports-cloudflare.sh --undo web1`, `install-certbot-port-hook.sh --remove web1` and
`install-operator-allowlist.sh --apply --ufw-web-clear 203.0.113.50 web1`. Leaving the server name off `--apply` on
the certbot script installs on every server.

**7G log rotation, in this order** (from the header of `scripts/install-7g-logrotate.sh`). `--clone` copies the rule
from the golden server, so on a new fleet, where the golden server has none, it stops with
`ABORT: web1 has no rule at ...`. Give the golden server the standard rule first:

```bash
bash scripts/install-7g-logrotate.sh                  # look: which servers have the rule, and how big 7g.log is
bash scripts/install-7g-logrotate.sh --set web1       # CHANGES web1 (the golden server): writes the standard rule
bash scripts/install-7g-logrotate.sh --clone          # CHANGES every server that has no rule: copies web1's
```

**`--set` with no server name writes to every server**, replacing the rule there. `--clone` never replaces a rule
that is there. The audit's closing lines say which of the two a server needs.

### 11e. Patchstack

`middleware.ts` runs Patchstack's firewall (`patchstack.next.ts`, from the `@patchstack/connect` package) on every
request, and every API route runs it again. **With no Patchstack account it still blocks**: it uses the rules bundled in
`patchstack.rules.json`, and it sends Patchstack nothing. While no npm script in `package.json` runs
`patchstack-connect`, `npm install` and `npm run build` send it nothing either. You need no account and no setting
for any of this.

**Connecting an account is optional.** It gets you Patchstack's live rules, its dashboard of blocked requests and
its warnings about vulnerable packages. Read "What gets sent" in `node_modules/@patchstack/connect/README.md` first.
Then:

```bash
npx @patchstack/connect setup     # makes your Patchstack site; follow what it prints to claim it
```

It writes `.patchstackrc.json` (your site's id) and `.patchstackrc.local.json` (its key, git-ignored). It also adds
three npm scripts to `package.json`, which from then on run on every install and build:

- `postinstall` and `prebuild` send the package names and versions from `package-lock.json`, and the app's name
- `prebuild` also uploads a map of the app's routes and parameter names (not the source code)
- `postbuild` tells Patchstack which build is live

It leaves `patchstack.next.ts` as it is, and says the file is customized. Keep it that way: the changes it carries
stop a Cloudflare Worker running out of memory and stop requests passing unscreened. Then put the key on the
Worker, and deploy (step 9):

```bash
npx wrangler secret put PATCHSTACK_API_KEY   # paste the apiKey from .patchstackrc.local.json at the prompt
```

The other settings are in `.env.example`. `PATCHSTACK_MODE=dry-run` on the Worker makes the firewall log what it
would block and block nothing.

**Check:** a request carrying an attack, such as `https://<your app>/login?file=../etc/passwd`, gets a 403 page, and the
Worker's log (`npx wrangler tail`) shows a line starting `[patchstack] BLOCK`. `npm run accessgate:test` proves the
firewall is wired into `middleware.ts`. Patchstack's own `npx @patchstack/connect protect --check` says the
middleware is "not wired": it reads only a plain `next.config.ts`, and this one calls OpenNext's development hook.

### 11f. 7G exceptions, and 8G

**7G** is GridPane's own firewall. When it blocks a request that should pass, do not switch a 7G rule group off:
write an exception. A site's page in Fleet has a **Whitelist rule generator** for this. Paste the blocked line from
that site's 7G log (`/var/www/<site>/logs/7g.log`). It reads every rule that fired and writes an nginx exception that
lifts each one for that request only: by default for the source address, or, with "Request pattern", for exactly
the text the rule saw, anchored at both ends (or for a pattern you type in its place). "Whole server" writes it for every site on the server; "All 7G rules"
lifts every rule, for a source you trust fully.

It gives a shell snippet to run as root on the server. The snippet **appends** (`cat >>`) to
`/var/www/<site>/nginx/whitelist-7g-context.conf` (or `/etc/nginx/extra.d/whitelist-7g-context.conf` for the whole
server), files GridPane's updates leave alone, then runs `nginx -t && gp ngx reload`. Running the same snippet twice
adds the exception twice: read the file first. Its limit: the exception lifts a rule's whole group for the matching
request, so that request also skips the group's other rules.

**8G** is a separate firewall that some people add to GridPane by hand. **Fleet only reports it; nothing in this
repository installs it.** The agent (step 8) reports, per site, whether it finds a folder
`/var/www/<site>/nginx/8g/`, an nginx include of `8g-firewall.conf`, an `access_log ... 8g.log` line (8G only logging
what it would block), or an include of `8g.conf` (8G blocking), and counts the last day of `logs/8g.log`. To use 8G,
install it yourself from its author's own instructions; the pages show it once the agent sees it.

## Step 12. Before you publish a fork

If you fork this privately, change it and publish the changes, your own server names, addresses and client names
must not go with them. The tooling checks every file against a list of your own terms.

**Run**

```bash
npm run privacy:denylist     # writes ~/.config/fleet/privacy-denylist from your database and settings
npm run export:check         # exports the last commit to a temporary folder and runs the gate
npm run export:trial         # runs the type check and every suite inside an exported copy (a few minutes)
```

**By hand:** put what no database knows in `~/.config/fleet/privacy-extra`, one term a line: your name, your
business, a client's name as you would write it in a comment. The two Cloudflare Access settings go there too,
as the lines `CF_ACCESS_TEAM_DOMAIN=...` and `CF_ACCESS_AUD=...`, since they are not kept in `.env.local`
(step 10). Then run `npm run privacy:denylist` again. It says so when it has no team address or audience tag.

The last line of `export:check` must be `export_public=clean`, and of `export:trial`, `public_copy=pass`. Then
`bash scripts/export-public.sh ../fleet-public` makes the copy in a new folder with no history. It never pushes:
publishing is a step you take yourself, after reading what it made. `scripts/export-public.rules` says what is left
out and which files are replaced by their example.

---

## When something is wrong

- Run `npm run doctor`. Every `FAIL` line ends with `Next:` and what to do.
- In a git worktree with no `.env.local` of its own, the doctor and the bash scripts that read the project's
  address (`apply-sql.sh`, `set-email-change-template.sh`, `fix-telemetry-crontabs.sh`, `provision-agent-tokens.sh`,
  `install-fleet-sso-agent.sh`) read the main checkout's `.env.local`; `FLEET_ENV_FILE` names another file for them
  and for `npm run user:create`. The others read only the `.env.local` in the checkout they run from: `npm run sync`,
  `npm run sync:status`, `npm run servers:export`, `npm run waf:refresh` (its loading step) and `npm run dev`. In a
  worktree, give those a `.env.local` of their own or run them from the main checkout.
- The app comes up empty after sign-in: the session did not pass a second factor, the account has no authenticator
  app, or the two sign-in migrations (`20261121000000_strong_session.sql` and `20261122000000_authenticator_rule.sql`)
  and the app disagree. `npm run access:schema:test` and `npm run access:rule:test`
  prove the two hold the same rule.
- An agent stopped reporting: on that server, run `/root/telemetry-agent.sh` by hand and read what it says.
- GridPane answers 429: wait a full minute. Retrying sooner lengthens the wait (`docs/gridpane-api-v1-findings.md`).
