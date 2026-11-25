// 7G exception generator (lib/waf-7g.ts): what it writes for a real blocked request.
//
//   npm run waf7g:test
//
// The cases come from a real GridPane server. There, the generator's
// first form passed `nginx -t` and did nothing: `$7g_exception`
// reads as the capture `$7` plus "g_exception", it lifted only one of the two
// rules that fired, and its bad_request pattern was "/", which matches every
// request. The corrected form below let the one request through while a
// different localhost redirect and "<script>" stayed 403.
//
// Each check runs against the real builder and against the first form, and the
// first form must fail it: a check that cannot fail proves nothing.

import { buildExceptionConfig, escapeForNginxRegex, parseBlockedRequest, type RuleRequest } from "../lib/waf-7g.ts";

const LINE =
  '[24/Nov/2026:19:43:42 +0000] [":bad_querystring_10::bad_request_15:"] 203.0.113.55 example.com "GET /?redirect_uri=http://localhost:8080/callback HTTP/2.0" 403 0.000 "-" "curl/8.7.1"';
const parsed = parseBlockedRequest(LINE);

// The generator's first form, kept only as this test's control.
const FIRST_FORM = [
  'set $7g_exception "";',
  'if ($request_uri ~* "/") {',
  "    set $7g_exception 15;",
  "}",
  "if ($bad_request_7g = $7g_exception) {",
  "    set $7g_drop_bad_request 0;",
  "}",
].join("\n");

const pattern = (over: Partial<RuleRequest> = {}) =>
  buildExceptionConfig({ matchBy: "pattern", value: "", coverage: "specific", rules: parsed.rules, parsed, ...over });

type Check = { name: string; test: (config: string) => boolean };
const checks: Check[] = [
  {
    name: "never compares a variable that starts with a digit ($7... is a regex capture)",
    test: (c) => !/=\s*\$\d/.test(c) && !/set \$\d+g_exception/.test(c),
  },
  {
    name: "lifts every rule that fired (query string 10 and request 15)",
    test: (c) => c.includes("set $7g_drop_bad_query_string 0;") && c.includes("set $7g_drop_bad_request 0;"),
  },
  {
    name: "the bad_request pattern includes the query, never a bare path",
    test: (c) => /\$request_uri ~\* "[^"]*redirect_uri=/.test(c) && !/~\* "\/"/.test(c),
  },
  {
    name: "the query-string rule is tested against $args, anchored at both ends",
    test: (c) => /\$args ~\* "\^redirect_uri=http:\/\/localhost:8080\/callback\$"/.test(c),
  },
  {
    // Run the generated patterns as regexes (nginx's quoting undone): they must
    // let the logged request through and nothing near it.
    name: "lets the logged request through, but not callbackX or the same query on another page",
    test: (c) => {
      const pats = Array.from(c.matchAll(/(\$args|\$request_uri) ~\* "((?:[^"\\]|\\.)*)"/g)).map(([, v, p]) => ({ v, re: new RegExp(p.replace(/\\"/g, '"'), "i") }));
      if (pats.length < 2) return false;
      const hits = (args: string, uri: string) => pats.every(({ v, re }) => re.test(v === "$args" ? args : uri));
      const logged = "redirect_uri=http://localhost:8080/callback";
      return hits(logged, `/?${logged}`)
        && !hits(`${logged}X`, `/?${logged}X`)
        && !hits(logged, `/sample-page/?${logged}`);
    },
  },
  {
    name: "the path's '?' is escaped, so it is not 'optional slash'",
    test: (c) => c.includes('"^/\\?redirect_uri='),
  },
];

let failed = 0;
let caught = 0;
const real = pattern();
for (const { name, test } of checks) {
  const ok = test(real);
  const control = !test(FIRST_FORM);
  if (!ok) failed++;
  if (control) caught++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}${control ? "" : "   (control NOT caught)"}`);
}

// Parsing and the other forms.
const other: Array<[string, boolean]> = [
  ["parses both rules from one log line", parsed.rules.length === 2 && parsed.rules.every((r) => r.ruleset)],
  ["keeps the full request target (path and query)", parsed.fullUri === "/?redirect_uri=http://localhost:8080/callback"],
  ["reads not_allowed_method_3 as the bad-method ruleset", parseBlockedRequest('[":not_allowed_method_3:"] "TRACE / HTTP/1.1"').rules[0]?.ruleset === "bad_method"],
  ["IP form tests $remote_addr in every block", (() => {
    const c = buildExceptionConfig({ matchBy: "ip", value: "203.0.113.55", coverage: "specific", rules: parsed.rules, parsed });
    return (c.match(/\$remote_addr = "203\.0\.113\.55"/g) ?? []).length === 2;
  })()],
  ["'All 7G rules' resets all five flags", (buildExceptionConfig({ matchBy: "ip", value: "203.0.113.55", coverage: "all", rules: parsed.rules, parsed }).match(/ 0;/g) ?? []).length === 5],
  ["a typed pattern is used as typed", pattern({ value: "localhost:8080" }).includes('~* "localhost:8080"')],
  ["a literal backslash becomes four in the file", escapeForNginxRegex("a\\b") === "a\\\\\\\\b"],
  ["a quote is escaped for nginx", escapeForNginxRegex('a"b') === 'a\\"b'],
  ["no pattern and no log line asks for one", pattern({ parsed: {}, rules: [] }).startsWith("# Add")],
];
for (const [name, ok] of other) {
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"}  ${name}`);
}

const total = checks.length + other.length;
console.log(`\nwaf7g: ${total} checks, ${failed} failed; controls: ${caught} of ${checks.length} caught the first form`);
if (failed || caught !== checks.length) process.exit(1);
