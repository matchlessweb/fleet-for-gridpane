#!/usr/bin/env python3
"""Local half of the server snapshot: unpack what a server sent, and compare two snapshots.

  unpack  <raw stream file> <output folder>
  compare <snapshot folder> <target folder> [--plan <file>]
  program <plan file> <restore program>     (the restore program with the plan's files filled in)

Neither command prints a file's content. `unpack` writes each file the server sent under
<output>/files/, a manifest and the facts. `compare` says what a restore would do to bring the
target (a server read just now) back to the snapshot, and with --plan writes the list of files a
live restore may install. Exit codes for compare: 0 nothing to do, 10 there is something to do,
20 a precondition for a live restore is not met, 1 the input is unusable.
"""
import base64, hashlib, json, os, re, sys

CRON = "crontab:root"


def jails_key():
    """The fact that counts this deployment's own jails: jails_<server prefix>.

    The prefix comes from the caller's environment (scripts/lib-fleet-names.sh exports it
    from fleet.config.ts). There is no default: a wrong key would read as "no jails".
    """
    prefix = os.environ.get("FLEET_PREFIX", "")
    if not re.fullmatch(r"[a-z][a-z0-9]{1,23}", prefix):
        sys.exit("FLEET_PREFIX is not set or not valid; run this through the fleet scripts, which read it from fleet.config.ts")
    return "jails_" + prefix


def local_path(root, path):
    rel = "_crontab/root" if path == CRON else path.lstrip("/")
    full = os.path.normpath(os.path.join(root, "files", rel))
    if not full.startswith(os.path.join(os.path.normpath(root), "files") + os.sep):
        raise ValueError("path escapes the output folder: %r" % path)
    return full


def parse_fields(rest):
    """key=value pairs up to path=, which takes the rest of the line (a path may hold spaces)."""
    head, _, path = rest.partition(" path=")
    if not _ and rest.startswith("path="):
        head, path = "", rest[5:]
    out = dict(p.split("=", 1) for p in head.split() if "=" in p)
    out["path"] = path
    return out


def parse(raw_text):
    facts, files, data, order = [], {}, {}, []
    lines = raw_text.split("\n")
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.startswith("file "):
            f = parse_fields(ln[5:])
            files[f["path"]] = f
            order.append(f["path"])
        elif ln.startswith("data path="):
            p = ln[len("data path="):]
            body = lines[i + 1] if i + 1 < len(lines) else ""
            if i + 2 >= len(lines) or lines[i + 2] != "enddata":
                raise ValueError("data block for %s is cut off" % p)
            data[p] = base64.b64decode(body)
            i += 2
        elif ln.strip():
            facts.append(ln)
        i += 1
    return facts, files, data, order


def unpack(raw, out):
    text = open(raw, encoding="utf-8", errors="replace").read()
    facts, files, data, order = parse(text)
    complete = "snapshot_complete=yes" in facts
    os.makedirs(out, exist_ok=True)
    os.chmod(out, 0o700)
    bad = []
    for p in order:
        f = files[p]
        if f["class"] == "record":
            continue
        if p not in data:
            bad.append("%s: listed with content but none arrived" % p)
            continue
        if hashlib.sha256(data[p]).hexdigest() != f["sha256"]:
            bad.append("%s: content does not match its hash" % p)
            continue
        dest = local_path(out, p)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        with open(dest, "wb") as fh:
            fh.write(data[p])
        os.chmod(dest, 0o600)
    with open(os.path.join(out, "manifest.json"), "w") as fh:
        json.dump({"complete": complete, "files": [files[p] for p in order]}, fh, indent=1)
    with open(os.path.join(out, "facts.txt"), "w") as fh:
        fh.write("\n".join(facts) + "\n")
    for n in ("manifest.json", "facts.txt"):
        os.chmod(os.path.join(out, n), 0o600)
    by = {}
    for p in order:
        by[files[p]["class"]] = by.get(files[p]["class"], 0) + 1
    print("complete=%s" % ("yes" if complete else "NO"))
    print("files restore=%d compare=%d record=%d" % (by.get("restore", 0), by.get("compare", 0), by.get("record", 0)))
    print("sites=%d" % sum(1 for x in facts if x.startswith("site ")))
    for p in order:
        if "withheld" in files[p]:
            print("withheld %s (was %s): a line in it looks like a credential, so its content stayed on the server" % (p, files[p].get("was", "?")))
    for b in bad:
        print("BAD %s" % b)
    return 0 if complete and not bad else 1


def load(folder):
    m = json.load(open(os.path.join(folder, "manifest.json")))
    facts = open(os.path.join(folder, "facts.txt")).read().split("\n")
    kv, sites, php = {}, {}, {}
    for ln in facts:
        if ln.startswith("site "):
            d = dict(p.split("=", 1) for p in ln[5:].split())
            sites[d["name"]] = d
        elif ln.startswith("php "):
            d = dict(p.split("=", 1) for p in ln[4:].split())
            php[d["version"]] = d
        elif "=" in ln:
            k, v = ln.split("=", 1)
            kv[k] = v
    return m, kv, sites, php, {f["path"]: f for f in m["files"]}


def group(path):
    if path.startswith("/etc/fail2ban/"):
        return "fail2ban"
    if path.startswith("/var/www/"):
        return "site-nginx"
    if path.startswith("/etc/ufw/"):
        return "ufw"
    if path == CRON:
        return "crontab"
    return "other"


def compare(snap, target, plan_file=None):
    sm, skv, ssites, sphp, sfiles = load(snap)
    tm, tkv, tsites, tphp, tfiles = load(target)
    if not sm["complete"] or not tm["complete"]:
        print("ABORT: %s is incomplete" % ("the snapshot" if not sm["complete"] else "the read of the target"))
        return 1
    todo, blocked, plan = [], [], []
    say = print

    say("== Sites")
    # GridPane's own folders (its stats host, port 22222) are named after the server and are not
    # sites anyone moves, so only WordPress sites count.
    ssites = {k: v for k, v in ssites.items() if v.get("wordpress") == "yes"}
    tsites = {k: v for k, v in tsites.items() if v.get("wordpress") == "yes"}
    missing = sorted(s for s in ssites if s not in tsites)
    extra = sorted(s for s in tsites if s not in ssites)
    say("   WordPress sites in the snapshot: %d, on the target: %d" % (len(ssites), len(tsites)))
    for s in missing:
        say("   MISSING on the target: %s" % s)
    for s in extra:
        say("   new on the target (not in the snapshot): %s" % s)
    if missing:
        blocked.append("%d site(s) from the snapshot are not on the target: has the move finished?" % len(missing))
    for s in sorted(set(ssites) & set(tsites)):
        a, b = ssites[s].get("wp_fail2ban"), tsites[s].get("wp_fail2ban")
        if a != b:
            say("   %s: WP Fail2Ban plugin was %s, now %s" % (s, a, b))
            if a != "off" and b == "off":
                todo.append("turn the WP Fail2Ban integration back on for %s in GridPane" % s)

    say("== Outbound address")
    for fam in ("egress_ipv4", "egress_ipv6"):
        a, b = skv.get(fam, ""), tkv.get(fam, "")
        if a == b:
            say("   %s unchanged (%s)" % (fam, a or "none"))
        else:
            say("   %s CHANGED: %s -> %s" % (fam, a or "none", b or "none"))
    if skv.get("egress_ipv4") != tkv.get("egress_ipv4"):
        new = tkv.get("egress_ipv4", "?")
        for t in ("edit this server's Cloudflare token: set its IP lock to %s" % new,
                  "Cloudflare account allow rule: add %s, remove %s" % (new, skv.get("egress_ipv4", "?")),
                  "any WAF rule 1 skip that names the old address: change it to %s" % new):
            todo.append(t)

    say("== Server facts")
    for k in ("os", "nginx_version", "nginx_config_test", "fail2ban_version", "ufw_status", "ufw_user_rules",
              "mysql_innodb_buffer_pool_size", "mysql_max_connections", "telemetry_agent",
              "root_crontab_telemetry_lines", "cloudflare_token_file", "old_global_key_file", "jails_other"):
        a, b = skv.get(k, ""), tkv.get(k, "")
        say("   %-30s %s" % (k, a if a == b else "%s -> %s  (differs)" % (a or "none", b or "none")))
    if skv.get("jails_other") != tkv.get("jails_other"):
        gone = sorted(set(skv.get("jails_other", "").split()) - set(tkv.get("jails_other", "").split()))
        if gone:
            todo.append("jail(s) not running on the target that the apply script does not rebuild: %s. Their files are in the snapshot under files/etc/fail2ban" % " ".join(gone))
    if tkv.get("nginx_config_test") == "FAILED":
        blocked.append("nginx's config test already fails on the target: fix that first, nothing is installed onto a broken config")
    if skv.get("telemetry_agent") == "present" and tkv.get("telemetry_agent") != "present":
        todo.append("install the telemetry agent: bash scripts/fix-telemetry-crontabs.sh --install (new GridPane server id), then scripts/provision-agent-tokens.sh")
    if skv.get("ufw_user_rules") != tkv.get("ufw_user_rules"):
        todo.append("firewall (UFW) rules differ: %s in the snapshot, %s on the target. Compare files/etc/ufw/user.rules by hand" % (skv.get("ufw_user_rules"), tkv.get("ufw_user_rules")))
    for v in sorted(set(sphp) | set(tphp)):
        a, b = sphp.get(v), tphp.get(v)
        if a is None or b is None:
            say("   php %-26s %s" % (v, "only in the snapshot" if b is None else "only on the target"))
        elif (a["opcache_memory"], a["interned_strings"]) != (b["opcache_memory"], b["interned_strings"]):
            say("   php %-26s opcache %s/%s -> %s/%s  (differs)" % (v, a["opcache_memory"], a["interned_strings"], b["opcache_memory"], b["interned_strings"]))
            todo.append("PHP %s OPcache was %s MB with %s MB for strings; the target has %s and %s" % (v, a["opcache_memory"], a["interned_strings"], b["opcache_memory"], b["interned_strings"]))

    say("== Files a restore may put back (only where missing)")
    n_same = 0
    for p, f in sorted(sfiles.items()):
        if f["class"] != "restore" and f.get("was") != "restore":
            continue
        t = tfiles.get(p)
        if f["class"] == "record":
            if t is None:
                say("   CANNOT RESTORE %s: its content was withheld from the snapshot (credential-shaped line). Copy it by hand." % p)
                todo.append("copy %s to the target by hand (withheld from the snapshot)" % p)
            continue
        if t is None:
            say("   would install %s (%s bytes, mode %s)" % (p, f["size"], f["mode"]))
            plan.append({"path": p, "mode": f["mode"], "owner": f["owner"], "sha256": f["sha256"], "source": local_path(snap, p)})
        elif t["sha256"] == f["sha256"]:
            n_same += 1
        else:
            say("   DIFFERS, left alone: %s (the target has its own version)" % p)
            todo.append("%s differs on the target: decide by hand which version is right" % p)
    say("   already in place and identical: %d" % n_same)
    if plan:
        todo.insert(0, "install %d missing file(s) with --live" % len(plan))

    say("== Fail2Ban")
    want = int(skv.get(jails_key(), "0") or 0)
    have = int(tkv.get(jails_key(), "0") or 0)
    say("   per-site jails running: %d in the snapshot, %d on the target" % (want, have))
    f2b_missing = [p for p, f in sfiles.items() if group(p) == "fail2ban" and f["class"] == "compare" and p not in tfiles]
    f2b_diff = [p for p, f in sfiles.items() if group(p) == "fail2ban" and f["class"] == "compare" and p in tfiles and tfiles[p]["sha256"] != f["sha256"]]
    say("   setup files missing: %d, different: %d" % (len(f2b_missing), len(f2b_diff)))
    if tkv.get("cloudflare_token_file") != "present" or have < want or f2b_missing:
        todo.append("rebuild the per-site jails: bash scripts/fleet-fail2ban.sh <label>, then bash scripts/fleet-fail2ban-apply.sh <label> (dry run), then --live")

    say("== Reference only (never installed)")
    for g, label in (("site-nginx", "per-site nginx files"), ("ufw", "firewall rule files"), ("crontab", "root's crontab")):
        ps = [p for p, f in sfiles.items() if group(p) == g]
        miss = [p for p in ps if p not in tfiles]
        diff = [p for p in ps if p in tfiles and tfiles[p]["sha256"] != sfiles[p]["sha256"]]
        say("   %-22s %d in the snapshot, %d missing on the target, %d different" % (label, len(ps), len(miss), len(diff)))
        for p in (miss + diff)[:12]:
            say("      %s %s" % ("missing  " if p in miss else "different", p))
        if len(miss) + len(diff) > 12:
            say("      ... and %d more" % (len(miss) + len(diff) - 12))
        if g == "site-nginx" and miss:
            todo.append("%d per-site nginx file(s) are missing on the target: check each site's GridPane security settings, do not copy generated files across" % len(miss))

    say("== Result")
    for b in blocked:
        say("   BLOCKED: %s" % b)
    for t in todo:
        say("   to do: %s" % t)
    if plan_file:
        with open(plan_file, "w") as fh:
            json.dump({"blocked": blocked, "install": plan}, fh, indent=1)
        os.chmod(plan_file, 0o600)
    if blocked:
        return 20
    if not todo:
        say("   nothing to do: the target matches the snapshot")
        return 0
    return 10


def program(plan_file, remote_file):
    """Print the restore program with the plan's files filled in as PLAN lines."""
    lines = []
    for f in json.load(open(plan_file))["install"]:
        if not re.fullmatch(r"[0-7]{3,4}", f["mode"]) or not re.fullmatch(r"[A-Za-z0-9_.-]+:[A-Za-z0-9_.-]+", f["owner"]):
            sys.exit("unexpected mode or owner for %s" % f["path"])
        if "|" in f["path"] or "\n" in f["path"]:
            sys.exit("a path holds a character the plan cannot carry: %r" % f["path"])
        body = open(f["source"], "rb").read()
        if hashlib.sha256(body).hexdigest() != f["sha256"]:
            sys.exit("the saved copy of %s no longer matches its hash" % f["path"])
        lines.append("PLAN|%s|%s|%s|%s|%s" % (f["path"], f["mode"], f["owner"], f["sha256"], base64.b64encode(body).decode()))
    script = open(remote_file).read()
    if script.count("\n__PLAN_LINES__\n") != 1:
        sys.exit("the restore program has no single placeholder line")
    sys.stdout.write(script.replace("\n__PLAN_LINES__\n", "\n" + "\n".join(lines) + "\n"))
    return 0


def main(a):
    if len(a) == 3 and a[0] == "unpack":
        return unpack(a[1], a[2])
    if len(a) == 3 and a[0] == "program":
        return program(a[1], a[2])
    if len(a) >= 3 and a[0] == "compare":
        plan = a[a.index("--plan") + 1] if "--plan" in a else None
        return compare(a[1], a[2], plan)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
