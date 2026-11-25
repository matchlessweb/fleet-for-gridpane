# Parked features

Features taken out of the app because they showed data that was not real, or
offered a control that did not change the server. Each entry says what was
removed, why, and how to bring it back if the cause goes away.

The removed files are no longer in the tree. Each entry says enough to rebuild
it.

## 1. Backup History (`/backups/history`)

**What it was.** A table of backup runs per site, with status, size, storage
path and a CSV export, linked from Backups as "Full History".

**Why it was removed.** Nothing real ever fed it. GridPane's OAuth API (v1)
exposes backup schedules but no record of backup runs. The only writer of the
`backup_history` table was `POST /api/backups/seed`, which inserted five random
rows per site: random sizes, about 90% "success", invented job ids and storage
paths. The table held no rows when the page was removed, so no data was deleted.

**Removed files.**

- `app/(dashboard)/backups/history/page.tsx` (the page)
- `app/api/backups/seed/route.ts` (the fake-data writer; do not restore this one)
- the "Full History" link in `app/(dashboard)/backups/page.tsx`

**Still in place.** The empty `backup_history` table and its types in
`lib/database.types.ts`.

**To bring it back.** It needs a real source of backup runs. Two candidates:
GridPane adding a backup-runs endpoint, or the fleet agent on each server
reporting the runs it can see (the way it reports Fail2Ban state). Write real
rows into `backup_history`, then restore the page file and the link.

## 2. PHP slow log controls (site page)

**What it was.** A switch for slow logging and number fields for
`slowlog_timeout` and `slowlog_trace_depth` in the Slowlog panel of
`app/(dashboard)/sites/[id]/page.tsx`.

**Why it was removed.** `PUT /oauth/api/v1/site/{id}` answers `422 No command
was committed to the server. Insufficient payload.` for every slow log payload
shape tried (`docs/api-php-slowlog.md` lists them). The route stripped the three
keys before calling GridPane, then still saved them to Supabase and logged
"[PHP Slowlog Activated] Successfully generated infrastructure overrides". The
switch moved; the server did not change.

**What is there now.** The same panel, read-only, showing the values GridPane
reports at each sync (the Sync button, the nightly sync and `scripts/sync-gridpane.ts`). `PATCH /api/sites/[id]`
answers 400 to `is_php_slowlog`, `php_slowlog_timeout` and
`php_slowlog_trace_depth`.

**To bring it back.**

1. Re-test the payloads in `docs/api-php-slowlog.md` against the live API. Go on
   only if one returns 200 and the setting changes on the server.
2. In `app/api/sites/[id]/route.ts`, take the three keys out of `notWritable`
   and add them back to `gpProps`, in the shape the API accepted.
3. Restore the switch and fields in the `Slowlog` section of
   `app/(dashboard)/sites/[id]/page.tsx` (the fields used `PhpMetricInput` and
   `updatePhpSetting`, both still there).

## 3. `is_ssl` and `waf` writes

**What it was.** `PATCH /api/sites/[id]` accepted `is_ssl` and `waf` and saved
them to Supabase only. A `toggleSetting` helper on the site page would have
called it, but nothing on the page used the helper.

**Why it was removed.** The values were never sent to GridPane, so a caller
would have changed the app's copy and nothing else. The route now answers 400
to both. `is_ssl` is still read from GridPane by the sync.

**To bring it back.** Only with a GridPane call that makes the change on the
server. None is known.

## 4. Typed "Cloudflare DNS connection" field and the fixed "Cloudflare proxied" label

**What it was.** The site page's SSL row said "Cloudflare proxied" for every
site. A text field in the site's configuration modal ("Cloudflare DNS
connection") decided whether the Firewall panel treated the site as proxied.
It was set on no site, so every site was treated as not proxied while
the row above said the opposite.

**What is there now.** A Cloudflare row with an orange, grey or outlined cloud,
answered per hostname from the daily Cloudflare inventory (`hostProxy()` in
`lib/cloudflare-waf.ts`, fed by `proxied_names` and `grey` in each zone's
`reach`). The Firewall panel uses the same answer. The typed field is gone from
the modal; the `cloudflare_dns_name` column stays and is still filled by
`scripts/sync-gridpane.ts` with GridPane's DNS integration name.

**To bring it back.** No reason to: the inventory is the real source.

## 5. Object Cache Pro and Relay controls (site page)

**What is there now.** The caching panel shows whether Object Cache Pro is on,
read from each site's GridPane record at every sync, and says to change it in
GridPane. It has no control for Object Cache Pro or Relay.

**Why.** GridPane's public API has no setting for either: its Postman collection
(114 requests) names neither. The only way besides GridPane's
own dashboard is GP-CLI as root on the server, with each license key in the
command: `gp site {url} -enable-object-cache {ocp.license} -relay {relay.license}`.
Fleet does not run commands as root on a server, and does not hold license keys.

**To bring it back.** Only if GridPane's API gains a setting for them: try it on
a dev site first, as `docs/gridpane-api-caching.md` describes, before building
on it.
