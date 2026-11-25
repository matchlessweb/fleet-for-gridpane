/**
 * Checks for lib/web-lock.ts.   npm run weblock:test
 * Assertions are on values, and every "this is fine" has a control that must not be.
 */
import { allowlistLabel, BUILT_IN_RANGES, cidrWithin, classifyWebLock, describeWebLock } from "../lib/web-lock.ts";

let ran = 0;
let failed = 0;
function check(name: string, got: unknown, want: unknown) {
  ran++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) failed++;
  console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok ? "" : `\n       got  ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`);
}

const CF = BUILT_IN_RANGES.ranges;
const LOCKED = [...CF]; // what `gp cloudflare enable` leaves: one rule per range
const st = (sources: string[] | null, ufw_enabled = true) => ({ ufw_enabled, ufw_web_sources: sources });
const status = (sources: string[] | null, ufw = true, ranges: readonly string[] = CF) =>
  classifyWebLock(st(sources, ufw), ranges).status;

console.log("cidrWithin:");
check("a range inside a wider one", cidrWithin("104.16.0.0/14", "104.16.0.0/13"), true);
check("control: a wider range is not inside a narrower one", cidrWithin("104.16.0.0/12", "104.16.0.0/13"), false);
check("a bare address inside a range", cidrWithin("173.245.48.7", "173.245.48.0/20"), true);
check("control: an address just outside", cidrWithin("203.0.113.16", "203.0.113.0/28"), false);
check("IPv6 range inside a /29", cidrWithin("2a06:98c0::/32", "2a06:98c0::/29"), true);
check("control: IPv6 just outside the /45", cidrWithin("2001:db8:8::/48", "2001:db8::/45"), false);
check("control: families never mix", cidrWithin("0.0.0.0/0", "::/0"), false);
check("the same range is within itself", cidrWithin("2606:4700::/32", "2606:4700::/32"), true);

console.log("classify:");
check("built-in list holds 15 IPv4 + 7 IPv6", CF.length, 22);
check("a server after the lock", status(LOCKED), "cloudflare");
check("a server before the lock (GridPane default)", status(["0.0.0.0/0", "::/0"]), "open");
check("open on IPv6 only still counts as open", status([...LOCKED, "::/0"]), "open");
check("locked plus an operator address",
  classifyWebLock(st([...LOCKED, "203.0.113.7"]), CF), { status: "cloudflare-plus", others: ["203.0.113.7"], missing: [], cloudflareSources: 22 });
check("a range Cloudflare adds later shows as missing",
  classifyWebLock(st(LOCKED), [...CF, "198.51.100.0/24"]).missing, ["198.51.100.0/24"]);
check("missing ranges outrank an operator address", status([...LOCKED.slice(1), "203.0.113.7"]), "cloudflare-partial");
check("one wide rule covering a Cloudflare range counts as covering it",
  classifyWebLock(st([...LOCKED.filter((r) => r !== "104.16.0.0/13"), "104.16.0.0/12"]), CF).missing, []);
check("only non-Cloudflare addresses", status(["203.0.113.7"]), "restricted");
check("nothing may reach the web ports", status([]), "closed");
check("UFW off", status(LOCKED, false), "ufw-off");
check("old agent: NULL is unreported, not closed", status(null), "unreported");
check("no state row at all", classifyWebLock(null, CF).status, "unreported");
check("control: an empty list is not unreported", status([]) === "unreported", false);

console.log("describe:");
check("locked reads Cloudflare only / ok", (({ label, tone }) => ({ label, tone }))(describeWebLock(classifyWebLock(st(LOCKED), CF))), { label: "Cloudflare only", tone: "ok" });
check("open reads as a warning", describeWebLock(classifyWebLock(st(["0.0.0.0/0"]), CF)).tone, "warn");
check("plus one counts the others", describeWebLock(classifyWebLock(st([...LOCKED, "203.0.113.7"]), CF)).label, "Cloudflare + 1");
check("missing counts the ranges", describeWebLock(classifyWebLock(st(LOCKED.slice(2)), CF)).label, "2 Cloudflare ranges missing");

console.log("allowlist labels:");
const ALLOWS = [{ ip: "203.0.113.50", label: "Home" }, { ip: "2001:db8:1234:5678::/64", label: "Home (IPv6)" }];
check("an exact address gets its label", allowlistLabel("203.0.113.50", ALLOWS), "Home");
check("an address inside an allowlisted IPv6 /64", allowlistLabel("2001:db8:1234:5678::5", ALLOWS), "Home (IPv6)");
check("control: a neighbour address is not labelled", allowlistLabel("203.0.113.51", ALLOWS), undefined);
check("control: a wider rule is not covered by a narrower entry", allowlistLabel("2001:db8:1234::/48", ALLOWS), undefined);

console.log(`\n${failed === 0 ? "PASS" : "FAILED"} (${ran} checks, ${failed} failed)`);
process.exit(failed === 0 ? 0 : 1);
