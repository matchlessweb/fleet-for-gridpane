# GridPane's caching API: what it accepts

Found by trying each change on a development site, after reading GridPane's published API collection (the
Postman documentation GridPane's knowledge base links to). The site page's caching panel, the route
`app/api/sites/[id]/caching/route.ts` and `lib/site-caching.ts` follow these results.

Every change is `PUT https://my.gridpane.com/oauth/api/v1/site/{id}` with a JSON body.

## What worked

| Body | Result |
| --- | --- |
| `{"object_caching": true}` / `{"object_caching": false}` | Accepted. Shows in `site_customizer.object_caching` on the next read. The record's top-level `object_caching` stayed null throughout: read the customizer |
| `{"nginx_caching": "redis"}`, `{"nginx_caching": "fastcgi"}` with no page cache on | Accepted. Shows in `nginx_caching` |
| `{"nginx_caching": "none"}` | Accepted. `nginx_caching` reads back as null, not "none" |
| `{"nginx_caching_ttl": 60}` while a page cache is on | Accepted. Shows in `site_customizer.nginx_caching_ttl` |
| `{"clear_cache": "page"}` | Accepted. Nothing in the record shows a clear |

## What GridPane refused, and how

| Body | Answer |
| --- | --- |
| Any value in quotes: `{"object_caching": "true"}`, `{"nginx_caching_ttl": "120"}` | 429 "Beep, Beep, you're going too fast...", which looks like a rate limit and is not. Send real JSON booleans and numbers. (Fleet's PHP settings are the opposite: they must be sent as text. See `docs/gridpane-api-v1-findings.md`) |
| `{"nginx_caching": "redis"}` while FastCGI is on | 409 "Unable to enable redis, please disable fastcgi first." Turn the page cache off, then turn the other on |
| `{"nginx_caching_ttl": 120}` with no page cache on | 409 "Nginx caching must be enabled on the site to configure nginx caching ttl" |
| Any change a minute or two after the last one | Often 429, the same "Beep, Beep" answer, while the rate-limit headers still showed 8 of 12 requests left on the endpoint and 56 of 60 overall. GridPane limits how often one site's settings change. With 10 minutes between changes nothing was refused. One pair 1.5 minutes apart went through; another change 5 minutes after the last was refused. Never retry on a 429: the first test run's retries were all refused too |

### A read just before a change spends the change

A site change on `PUT /site/{id}` comes back with its own limit: `x-ratelimit-endpoint-limit: 2`.
One accepted change on its own left `x-ratelimit-endpoint-remaining: 0` and the account total two
lower (60 to 58), so one change spends both of that minute's 2. Reads of a site report a separate
limit of 12, but a read of the same site about a second before a change left nothing for the
change: it was refused with 429 and `remaining: 0`, both times this was tried. The same change sent alone, ten
minutes later, was accepted. So never read a site in the minute before changing it. Reading after
a change is fine: read-backs 25 seconds after each accepted change all worked. Fleet's route plans from its own copy of the site's caching, and reads GridPane
only after the change, or after a refusal.

### Any other call in that minute can spend it too

A change sent with no read before it, more than ten minutes after the last change, can still be
refused with 429: `retry-after-endpoint` near a minute, `x-ratelimit-endpoint-remaining: 0`, and
`x-ratelimit-total-remaining` one lower than a change alone leaves. That means some other call on
the same GridPane account reached GridPane in that minute: another tool, a script, or anything
else using the account's API token. Fleet itself made none: it calls GridPane on no page load,
and no sync was running.

So a 10-minute gap does not guarantee a change goes through. The panel shows GridPane's refusal
in its dialog and changes nothing. Wait about 10 minutes and try once more; never retry
automatically.

Not tried: a page cache and its time to live in one request. Each attempt fell in a throttled
moment, so its refusals prove nothing either way. Fleet sends one setting per request.

## Other things the tests showed

- GridPane keeps the last time to live while caching is off: turning Redis on set it to
  2592000 (30 days), and it stayed at that after caching went off. Turning caching off in
  GridPane's own dashboard did not reset it either.
- A page cache the API turned on could be turned off in GridPane's own dashboard, and the API
  then read it as off. Whether the dashboard showed the API's change was not checked.
- Object Cache Pro and Relay: no setting in the API. See `docs/parked-features.md` section 5.

## To test again

Use a dev site, save its record first (`GET /site/{id}`), and leave about 10 minutes between
changes. Read the record back after each one. End with the site as it was.
