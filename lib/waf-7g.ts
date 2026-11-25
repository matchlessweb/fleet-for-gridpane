/**
 * 7G WAF whitelist-rule authoring.
 *
 * GridPane's 7G firewall is configured through map-driven drop flags. When a
 * legitimate request is blocked you never disable a rule category — you write
 * an update-safe exception file that resets the flag after evaluation. These
 * helpers turn a blocked-request log line into that file's contents.
 *
 * Checked on a GridPane server: GridPane's per-site
 * 7G file sets each drop flag, includes `*-7g-context.conf`, then returns 403
 * for any flag still set. An exception resets the flag between those two.
 *
 * Reference: https://gridpane.com/kb/using-the-7g-web-application-firewall/
 */

/**
 * The five 7G rulesets: the map output var, the drop flag, and the part of the
 * request each one tests. `from` names the ParsedBlock field that holds that
 * part, so a generated pattern tests the same text the rule did.
 */
const RULESETS = {
  bad_bot: { triggerVar: "$bad_bot_7g", dropFlag: "$7g_drop_bad_bot", label: "Bad bot", target: "$http_user_agent", from: "userAgent" },
  bad_referer: { triggerVar: "$bad_referer_7g", dropFlag: "$7g_drop_bad_referer", label: "Bad referer", target: "$http_referer", from: "referer" },
  bad_querystring: { triggerVar: "$bad_querystring_7g", dropFlag: "$7g_drop_bad_query_string", label: "Bad query string", target: "$args", from: "args" },
  // $request_uri is the path WITH its query string. A bad_request rule often
  // fires on the query part, so the path alone ("/") would match every request.
  bad_request: { triggerVar: "$bad_request_7g", dropFlag: "$7g_drop_bad_request", label: "Bad request", target: "$request_uri", from: "fullUri" },
  bad_method: { triggerVar: "$not_allowed_method_7g", dropFlag: "$7g_drop_bad_method", label: "Bad method", target: "$request_method", from: "method" },
} as const;

/** How GridPane's log names each ruleset, where that differs from our key. */
const LOGGED_AS: Record<string, RulesetKey> = { not_allowed_method: "bad_method" };

export type RulesetKey = keyof typeof RULESETS;
export const ALL_DROP_FLAGS = Object.values(RULESETS).map((r) => r.dropFlag);

/**
 * The variable an exception sets and compares. It must NOT start with a digit:
 * in an nginx expression `$7g_exception` reads as the regex capture `$7`
 * followed by the text "g_exception", so a comparison against it never matches
 * and the exception silently does nothing (that was this file's first form).
 * GridPane's own file writes `${7g_reason}` in braces for the same reason.
 */
export const EXCEPTION_VAR = "$fleet_7g_exception";

export type FiredRule = {
  /** Full token as logged, e.g. "bad_querystring_12" */
  raw: string;
  ruleset: RulesetKey | null;
  /** Rule number within the ruleset, e.g. "12" */
  number: string | null;
  label: string;
};

export type ParsedBlock = {
  ip: string | null;
  host: string | null;
  method: string | null;
  uri: string | null;
  /** Query string without the leading "?", when the URI had one */
  args: string | null;
  /** The request target as logged: path plus "?query" (what $request_uri holds) */
  fullUri: string | null;
  status: string | null;
  userAgent: string | null;
  referer: string | null;
  timestamp: string | null;
  rules: FiredRule[];
  /** False when nothing usable could be pulled out of the input */
  ok: boolean;
};

const IP_RE = /\b((?:\d{1,3}\.){3}\d{1,3}|[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7})\b/i;

function classify(token: string): FiredRule {
  const numMatch = token.match(/_(\d+)$/);
  const number = numMatch ? numMatch[1] : null;
  const name = token.replace(/_\d+$/, "");
  const base = (LOGGED_AS[name] ?? name) as RulesetKey;
  const known = base in RULESETS ? base : null;
  return {
    raw: token,
    ruleset: known,
    number,
    label: known ? RULESETS[known].label : token.replace(/_/g, " "),
  };
}

/**
 * Pull the useful fields out of a 7G log line. Deliberately forgiving: the
 * line can arrive from the GridPane dashboard, from `7g.log` over SSH, or be
 * partially pasted, so every field is extracted independently and any field
 * may come back null.
 */
export function parseBlockedRequest(input: string): ParsedBlock {
  const text = input.trim();
  const empty: ParsedBlock = {
    ip: null, host: null, method: null, uri: null, args: null, fullUri: null, status: null,
    userAgent: null, referer: null, timestamp: null, rules: [], ok: false,
  };
  if (!text) return empty;

  // Rule tokens are logged between colons: [":bad_bot_21:"] (several rules follow one another, each in its own pair of colons)
  const ruleTokens = Array.from(text.matchAll(/:([a-z]+(?:_[a-z]+)+(?:_\d+)?):/gi)).map((m) => m[1]);
  const rules = Array.from(new Set(ruleTokens)).map(classify);

  // Request line: "GET /path?q=1 HTTP/1.1"
  const req = text.match(/"([A-Z]{3,10})\s+(\S+)\s+HTTP\/[\d.]+"/);
  const method = req?.[1] ?? null;
  const fullUri = req?.[2] ?? null;
  const [uri, args] = fullUri ? [fullUri.split("?")[0], fullUri.split("?").slice(1).join("?") || null] : [null, null];

  // Status follows the quoted request line
  const status = req ? text.slice(text.indexOf(req[0]) + req[0].length).match(/\s(\d{3})\b/)?.[1] ?? null : null;

  const quoted = Array.from(text.matchAll(/"([^"]*)"/g)).map((m) => m[1]);
  const trailing = quoted.filter((q) => !/^[A-Z]{3,10}\s+\S+\s+HTTP/.test(q) && !q.includes("::"));
  const referer = trailing.find((q) => /^https?:\/\//i.test(q)) ?? null;
  const userAgent = trailing.length ? trailing[trailing.length - 1] : null;

  const timestamp = text.match(/\[(\d{2}\/[A-Za-z]{3}\/\d{4}[:\s][\d:]+\s*[+-]\d{4})\]/)?.[1] ?? null;

  // Take the first IP that is not part of the timestamp
  const ip = text.replace(/\[[^\]]*\]/g, " ").match(IP_RE)?.[1] ?? text.match(IP_RE)?.[1] ?? null;

  // Host: a bare domain token sitting between the IP and the request line
  const host = text.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b(?=[^"]*"[A-Z]{3,10}\s)/i)?.[1] ?? null;

  return {
    ip, host, method, uri, args, fullUri, status, userAgent, referer, timestamp, rules,
    ok: Boolean(ip || rules.length || req),
  };
}

/**
 * Text as a literal inside an nginx `~*` regex in double quotes: regex
 * metacharacters escaped, and the quote itself. Without it "." matches any
 * character and the "?" after a path makes the slash optional.
 */
export function escapeForNginxRegex(text: string): string {
  return text
    // nginx turns "\\" inside quotes into one backslash, so a literal one needs four.
    .replace(/\\/g, "\\\\\\\\")
    // nginx keeps a backslash before any other character, so the regex sees "\.".
    .replace(/[.*+?^${}()|[\]]/g, "\\$&")
    .replace(/"/g, '\\"');
}

/** The nginx variable a ruleset tests, and the logged text it fired on. */
export function ruleTarget(ruleset: RulesetKey, parsed: Partial<ParsedBlock>): { variable: string; text: string | null } {
  const { target, from } = RULESETS[ruleset];
  const text = (parsed[from as keyof ParsedBlock] as string | null | undefined) ?? null;
  return { variable: target, text: text || null };
}

export type MatchBy = "ip" | "pattern";
export type Scope = "site" | "global";
export type Coverage = "all" | "specific";

export type RuleRequest = {
  matchBy: MatchBy;
  /**
   * The IP when matchBy is "ip". When matchBy is "pattern": a regex typed by
   * hand, used for every rule; empty means each rule's own logged text, escaped.
   */
  value: string;
  coverage: Coverage;
  /** Every rule that fired. A request two rules blocked stays blocked if one is lifted. */
  rules: FiredRule[];
  /** The parsed log line, for each rule's own pattern */
  parsed: Partial<ParsedBlock>;
};

/** The nginx `if` blocks that reset the drop flag(s) for a matched request. */
export function buildExceptionConfig(req: RuleRequest): string {
  const { matchBy, coverage, parsed } = req;
  const value = req.value.trim();
  const ipCondition = `$remote_addr = "${value}"`;
  if (matchBy === "ip" && !value) return "# Add an IP address or a request pattern to generate a rule.";

  const known = req.rules.filter((r): r is FiredRule & { ruleset: RulesetKey } => r.ruleset !== null);

  // Reset every flag: simplest, and correct for a source you fully trust.
  if (coverage === "all" || known.length === 0) {
    const pattern = value || (parsed.fullUri ? `^${escapeForNginxRegex(parsed.fullUri)}$` : "");
    if (matchBy === "pattern" && !pattern) return "# Add an IP address or a request pattern to generate a rule.";
    const condition = matchBy === "ip" ? ipCondition : `$request_uri ~* "${pattern}"`;
    const body = ALL_DROP_FLAGS.map((f) => `    set ${f} 0;`).join("\n");
    return `if (${condition}) {\n${body}\n}`;
  }

  // Narrowest form: one block per rule that fired, each lifting only that rule
  // number and only for this source, so every other 7G protection stays live.
  return known
    .map((rule) => {
      const { triggerVar, dropFlag, label } = RULESETS[rule.ruleset];
      let condition: string;
      if (matchBy === "ip") {
        condition = ipCondition;
      } else {
        const { variable, text } = ruleTarget(rule.ruleset, parsed);
        // From the log: the exact text, anchored at both ends. Unanchored,
        // "...callback" also matched "...callbackX" and the same query on any
        // other page. A value that changes per request needs widening by hand.
        const pattern = value || (text ? `^${escapeForNginxRegex(text)}$` : "");
        if (!pattern) return `# ${label} ${rule.number ?? ""}: the log line has nothing to match on; add a pattern by hand.`.replace("  ", " ");
        condition = `${variable} ~* "${pattern}"`;
      }
      if (!rule.number) return `if (${condition}) {\n    set ${dropFlag} 0;\n}`;
      return [
        `set ${EXCEPTION_VAR} "";`,
        `if (${condition}) {`,
        `    set ${EXCEPTION_VAR} ${rule.number};`,
        `}`,
        `if (${triggerVar} = ${EXCEPTION_VAR}) {`,
        `    set ${dropFlag} 0;`,
        `}`,
      ].join("\n");
    })
    .join("\n");
}

/** Update-safe include path — these survive GridPane stack updates. */
export function exceptionFilePath(scope: Scope, siteUrl: string, name = "whitelist"): string {
  return scope === "site"
    ? `/var/www/${siteUrl}/nginx/${name}-7g-context.conf`
    : `/etc/nginx/extra.d/${name}-7g-context.conf`;
}

/** Copy-ready shell: write the file, validate, reload. */
export function buildShellSnippet(scope: Scope, siteUrl: string, config: string): string {
  const path = exceptionFilePath(scope, siteUrl);
  return [
    `cat >> ${path} <<'EOF'`,
    config,
    `EOF`,
    ``,
    `nginx -t && gp ngx reload`,
  ].join("\n");
}
