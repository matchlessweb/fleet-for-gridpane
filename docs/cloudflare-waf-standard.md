# The Cloudflare WAF standard, in the words Fleet uses

Fleet does not ship firewall rules and never changes one. It reads the custom
rules of every Cloudflare zone your token can see, compares each zone against a
standard **you** write down, and shows the result on the Cloudflare WAF pages.

This page explains the words that comparison uses: the five rules, the three
profiles, the classes and DNS reach. It describes the shape of a standard, not
the contents of one. Which networks, countries and crawlers you challenge or
block is your decision, and belongs in your own document (section 3).

The parts:

| Part | What it does |
| --- | --- |
| `scripts/waf-inventory.py` | Reads Cloudflare (read-only) and writes `report.json` |
| `scripts/waf-refresh.sh` | Runs the inventory once a day and loads the report |
| `scripts/ingest-waf-report.ts` | Checks a report and loads it into the database |
| The app, under Firewall | Shows the latest loaded report. It holds no Cloudflare token |

## 1. The five rules

The standard is five custom rules per zone (Cloudflare's "WAF custom rules").
The inventory calls this shape the **wordpress** profile; the app labels it
"Five-rule standard".

| Rule | Action | Name in the report | What it is for |
| --- | --- | --- | --- |
| 1 | Skip | `skip` | Lets through callers the later rules must not catch: verified good bots, your own monitoring, a payment provider's webhooks |
| 2 | Managed challenge | `providers` | Challenges visitors from networks and countries you do not expect real visitors from |
| 3 | Managed challenge | `crawlers` | Challenges crawlers that take more than they give, matched by user agent |
| 4 | Managed challenge | `vpn` | Challenges anonymizing networks, and protects the WordPress login |
| 5 | Block | `block` | Blocks hosting networks, paths no real visitor asks for, and Tor |

Rule 1 is different on every site by design, so it is never compared. The
inventory lists its clauses and leaves the judgment to you. Rules 2 to 5 are
compared clause by clause against your document.

### 1.1 How the inventory tells the rules apart

By what a rule does, never by its position or its name:

- A rule whose action is **skip** is rule 1.
- A rule whose action is **block** is rule 5, unless it names verified-bot
  categories and lists no networks: that is the dev profile's rule 1 (1.3).
- A challenge that lists both networks and countries is rule 2.
- A challenge that matches three or more user agents is rule 3.
- A challenge that mentions the WordPress login, or is short, is rule 4.
- Anything else is `other`: not one of the five.

Because of this, two zones that carry the same rules in a different order are
the same standard, and a zone whose rules have older names still compares.

### 1.2 The static-site profile

A site with no WordPress behind it (a static site, an app on a hosting
platform) needs four rules, not five. The inventory calls this the **static**
profile:

- Rule 1, skip, as above.
- Rule 2 without its country clause (the report calls this rule `other`).
- Rule 3, the same text as the five-rule standard's.
- Rule 5 with a wider block: on a site with no PHP, a request for a PHP file or
  a WordPress path is never a real visitor.
- No rule 4: there is no login to protect.

Never put the static rule 5 on a WordPress site. It blocks the paths WordPress
itself is served from.

### 1.3 The dev-site profile

A staging or development zone must not be indexed. The **dev** profile turns
rule 1 around: where a production zone skips the verified crawlers, a dev zone
blocks them, and it has no skip rule at all. Rules 2 to 5 are the five-rule
standard's, unchanged. The report calls the inverted rule 1 `noindex`.

A dev zone that also hosts something a crawler must reach can carry a guard on
its rules (section 2). The inventory still compares the zone and reports it as
a variant, so the exception stays visible.

### 1.4 Rule order

The block rule (rule 5) runs **second**, straight after rule 1 and before every
challenge. Cloudflare lets a request in once it passes a challenge and runs no
later rule against it, so a block placed after a challenge never blocks a
hosting network that solves the challenge.

The inventory reports this on every zone, compared or not:

> block rule runs after a challenge: a hosting network that passes the
> challenge is never blocked (s1.4)

Any other difference in order is not a finding. A zone whose clauses all match
but whose rules sit in another order reads as "Standard, reordered".

## 2. Exceptions: guards

When one rule must not catch one caller, narrow that rule instead of rewriting
it. Wrap the standard text in a guard:

```
(not <the caller to let past>) and (<the standard rule, unchanged>)
```

The inventory recognizes this shape. It reports the guard once ("guarded by:
...") and still compares everything inside the parentheses, so drift inside a
guarded rule is not hidden. A zone with a guard reads as a variant: correct,
and on the record.

## 3. Writing your standard down

The inventory compares against a Markdown file of your own. For each rule it
looks for a bold heading followed by a code block that holds the rule's whole
expression, exactly as it is entered at Cloudflare:

````
**Rule 2:** managed challenge, providers and countries
```
<your expression>
```

**Rule 3:** managed challenge, aggressive crawlers
```
<your expression>
```

**Rule 4:** managed challenge, VPNs and the WordPress login
```
<your expression>
```

**Rule 5:** block
```
<your expression>
```
````

The static profile is read from `**Static rule 2:**`, `**Static rule 3:**` and
`**Static rule 5:**`; the dev profile from `**Dev rule 1:**` (its other rules
are taken from Rules 2 to 5). Anything else in the file is ignored, so the
document can explain each rule in as many words as you like.

Rules for the document:

- A profile is all or nothing. If the file has `Rule 2` and no `Rule 3`, the
  inventory stops and says which one is missing.
- A profile you have not written down is not compared. Zones of that shape
  read as "Own rules" with the nearest profile named.
- With no document at all, nothing is compared. The inventory still lists
  every zone, rule and DNS finding, but no zone can read as "Standard".

Tell the inventory where the file is, in one of these ways:

1. `--standard /path/to/standard.md` on its command line
2. the environment variable `WAF_STANDARD`
3. the path on one line in `~/.config/fleet/waf-standard`

Keep the document outside this repository, or in a private fork: it describes
exactly what your firewall does and does not stop.

A rule can match on a key or a shared secret. The inventory masks any run of
20 or more letters, digits, hyphens and underscores before it writes the
report (`<40-char value redacted>`), and the ingest refuses a report where one
got through. A masked expression is shown as masked; it will not paste back
into Cloudflare as it is.

## 4. What the report says about a zone

### 4.1 DNS reach

A rule can only act on traffic that reaches Cloudflare. A zone can carry every
rule and still be unprotected, because its front door (the apex or `www`) is
DNS-only and visitors connect straight to the server. So the inventory also
reads each zone's DNS records:

| Reach | Meaning |
| --- | --- |
| `proxied` | The front door is proxied. The rules apply |
| `bypass` | The apex or `www` is DNS-only and points at one of your own servers. Visitors skip the rules |
| `review` | The front door is DNS-only and its target was not recognized. Check it by hand |
| `platform-front` | The front door is DNS-only and points at a third-party platform (a site builder, a parking page). Expected; proxying it would break the platform's certificate |
| `no-site` | The zone has no apex or `www` record |
| `unknown` | The DNS records could not be read |

"One of your own servers" is decided from evidence: an address counts as yours
when a proxied record somewhere in your zones points at the same address. The
report never carries an origin address. Each one is replaced by a number that
is the same across zones, so a shared server is still visible.

DNS-only records that are not the front door are counted separately: a
subdomain that exposes a server (`grey_other`), and names that point outside
the zone, such as mail and CDN records, which cannot be proxied (`delegated`).

### 4.2 Classes

| Class | In the app | Meaning |
| --- | --- | --- |
| `standard` | Standard | Every clause matches its profile, in order |
| `standard-reordered` | Standard, reordered | Every clause matches; the order differs |
| `variant` | Variant | Compared against a profile and differs. Each difference is a finding |
| `custom` | Own rules | Not compared: the rules match no profile, or you have not written that profile down |
| `none` | No custom rules | The zone has no custom rules |

`custom` means "not compared", not "wrong". `standard` is only ever given to a
zone that was compared against your document.

### 4.3 Findings

A finding is one difference, in plain words:

- `list changed: added ...; removed ...`: a clause is the standard's, with
  values added to or taken from one of its lists
- `extra clause: ...` and `clause removed: ...`
- `guarded by: ...`: the rule carries a guard (section 2)
- `rule "..." is DISABLED`
- `missing <rule>`: the zone matches no profile and lacks a rule of the nearest one
- the rule-order finding in 1.4

### 4.4 What an unattended run refuses

The daily job never forces a change through. If Cloudflare cannot be read for
one zone, the inventory writes no report at all: a zone that cannot be read is
not a zone with no rules. If a zone disappears from the report, or a zone that
had rules now has none, the ingest holds the run and writes nothing, and the
date on the WAF pages gets older until a person looks.
