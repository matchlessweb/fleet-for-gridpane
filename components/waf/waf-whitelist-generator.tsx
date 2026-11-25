"use client";

import { useMemo, useState } from "react";
import { Check, Copy } from "lucide-react";
import {
  Button,
  Copyable,
  Input,
  Modal,
  Segmented,
  StatusPill,
  useCopy,
} from "@/components/ui";
import {
  buildExceptionConfig,
  buildShellSnippet,
  exceptionFilePath,
  parseBlockedRequest,
  ruleTarget,
  type Coverage,
  type MatchBy,
  type Scope,
} from "@/lib/waf-7g";

const SAMPLE = `[12/Aug/2026:14:15:22 +0000] [":bad_querystring_12:"] 203.0.113.55 example.com "GET /wp-admin/admin.php?redirect_uri=http://localhost:7777/callback HTTP/1.1" 403 0 "-" "Mozilla/5.0"`;

export function WafWhitelistGenerator({
  open,
  onClose,
  siteUrl,
}: {
  open: boolean;
  onClose: () => void;
  siteUrl: string;
}) {
  const [raw, setRaw] = useState("");
  const [scope, setScope] = useState<Scope>("site");
  const [coverage, setCoverage] = useState<Coverage>("specific");
  const [matchBy, setMatchBy] = useState<MatchBy>("ip");
  const [manualValue, setManualValue] = useState("");

  const parsed = useMemo(() => parseBlockedRequest(raw), [raw]);

  // A request is often blocked by more than one rule (a query string can trip
  // a bad-query-string and a bad-request rule at once). Lifting only one
  // leaves it blocked, so the exception covers every rule that fired, each
  // tested against the part of the request that rule reads.
  const targets = Array.from(
    new Set(parsed.rules.flatMap((r) => (r.ruleset ? [ruleTarget(r.ruleset, parsed).variable] : [])))
  );

  // IP: the logged address unless one is typed. Pattern: empty means each
  // rule's own logged text, escaped; a typed regex is used for every rule.
  const value = matchBy === "ip" ? manualValue || parsed.ip || "" : manualValue;

  const config = useMemo(
    () => buildExceptionConfig({ matchBy, value, coverage, rules: parsed.rules, parsed }),
    [matchBy, value, coverage, parsed]
  );

  const filePath = exceptionFilePath(scope, siteUrl);
  const shell = buildShellSnippet(scope, siteUrl, config);

  const { state: configCopy, copy: copyConfig } = useCopy(config);
  const { state: shellCopy, copy: copyShell } = useCopy(shell);

  const reset = () => {
    setRaw("");
    setManualValue("");
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="7G whitelist rule"
      meta={siteUrl}
    >
      <div className="flex flex-col gap-5">
        <p className="text-pretty text-[12.5px] leading-relaxed text-muted-foreground">
          Paste a blocked request from GridPane&apos;s security log. This reads
          which rule fired and writes the update-safe exception file that lets
          that traffic through — every other 7G protection stays on.
        </p>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <label className="eyebrow text-faint" htmlFor="waf-input">
              Blocked request
            </label>
            <button
              type="button"
              className="touch-hit eyebrow text-faint underline underline-offset-2 hover:text-foreground"
              onClick={() => setRaw(SAMPLE)}
            >
              Use an example
            </button>
          </div>
          <textarea
            id="waf-input"
            value={raw}
            onChange={(e) => setRaw(e.target.value)}
            rows={3}
            spellCheck={false}
            placeholder="[12/Aug/2026:14:15:22 +0000] [&quot;:bad_bot_21:&quot;] 203.0.113.10 example.com &quot;GET /path HTTP/1.1&quot; 403 …"
            className="w-full resize-y rounded-md border border-line-strong bg-panel px-3 py-2 font-mono text-[11.5px] leading-relaxed text-foreground transition-colors duration-150 placeholder:text-faint focus:border-primary/60 focus:outline-none"
          />
        </div>

        {raw.trim() && !parsed.ok && (
          <p className="text-pretty text-[12.5px] leading-relaxed text-warning">
            Nothing recognizable in that text. Paste the whole log line, or set
            the match value by hand below.
          </p>
        )}

        {parsed.ok && (
          <div className="flex flex-col gap-3 rounded-md border border-border bg-panel-2 p-3.5">
            <span className="eyebrow text-faint">What was blocked</span>
            <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-2">
              <Fact label="Source IP" value={parsed.ip} mono copyWhat="IP address" />
              <Fact label="Status" value={parsed.status} mono />
              <Fact
                label="Request"
                value={parsed.method && parsed.uri ? `${parsed.method} ${parsed.uri}` : null}
                mono
                wide
              />
              {parsed.args && <Fact label="Query string" value={parsed.args} mono wide />}
              {parsed.userAgent && <Fact label="User agent" value={parsed.userAgent} wide />}
            </dl>

            {parsed.rules.length > 0 && (
              <div className="flex flex-col gap-2 border-t border-border pt-3">
                <span className="eyebrow text-faint">
                  {parsed.rules.length > 1 ? "Rules fired: the exception lifts each one" : "Rule fired"}
                </span>
                <div className="flex flex-wrap gap-2">
                  {parsed.rules.map((r) => (
                    <StatusPill key={r.raw} tone="danger">
                      {r.label}
                      {r.number ? ` ${r.number}` : ""}
                    </StatusPill>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Control label="Match on">
            <Segmented
              options={[
                { value: "ip", label: "Source IP" },
                { value: "pattern", label: "Request pattern" },
              ]}
              value={matchBy}
              onChange={(v) => {
                setMatchBy(v as MatchBy);
                setManualValue("");
              }}
            />
          </Control>
          <Control label="Scope">
            <Segmented
              options={[
                { value: "site", label: "This site" },
                { value: "global", label: "Whole server" },
              ]}
              value={scope}
              onChange={(v) => setScope(v as Scope)}
            />
          </Control>
          <Control label="Lift">
            <Segmented
              options={[
                { value: "specific", label: parsed.rules.length > 1 ? "Just these rules" : "Just this rule" },
                { value: "all", label: "All 7G rules" },
              ]}
              value={coverage}
              onChange={(v) => setCoverage(v as Coverage)}
            />
          </Control>
          <Control
            label={matchBy === "ip" ? "IP address" : `Pattern (tested against ${targets.length ? targets.join(", ") : "$request_uri"})`}
          >
            <Input
              value={value}
              onChange={(e) => setManualValue(e.target.value)}
              placeholder={matchBy === "ip" ? "203.0.113.10" : "Empty: exactly what each rule saw"}
              className="w-full font-mono"
              spellCheck={false}
            />
          </Control>
        </div>

        {coverage === "all" && (
          <p className="text-pretty text-[12px] leading-relaxed text-warning">
            This lifts every 7G ruleset for that match. Use it only for a source
            you fully control — otherwise keep it to the single rule that fired.
          </p>
        )}

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
              <span className="font-semibold text-primary">File: </span>
              {filePath}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" onClick={copyConfig}>
                {configCopy === "copied" ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
                {configCopy === "copied" ? "Copied" : "Copy rule"}
              </Button>
              <Button size="sm" onClick={copyShell}>
                {shellCopy === "copied" ? <Check size={14} strokeWidth={1.75} /> : <Copy size={14} strokeWidth={1.75} />}
                {shellCopy === "copied" ? "Copied" : "Copy with commands"}
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto rounded-md bg-sunken p-4">
            <pre className="font-mono text-[11px] leading-relaxed text-on-sunken">
              <code>{config}</code>
            </pre>
          </div>
          <p className="text-pretty text-[11.5px] leading-relaxed text-faint">
            Append to that file over SSH, then run{" "}
            <Copyable value="nginx -t && gp ngx reload" what="command" className="text-muted-foreground">
              nginx -t &amp;&amp; gp ngx reload
            </Copyable>
            .
            The path is an update-safe include — GridPane stack updates will not
            overwrite it. Verify both directions afterward: the legitimate
            request passes, a bare bad pattern still returns 403.
          </p>
        </div>

        <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-between">
          <Button variant="ghost" onClick={reset} disabled={!raw && !manualValue}>
            Clear
          </Button>
          <Button variant="solid" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <span className="eyebrow text-faint">{label}</span>
      {children}
    </div>
  );
}

function Fact({
  label,
  value,
  mono,
  wide,
  copyWhat,
}: {
  label: string;
  value: string | null;
  mono?: boolean;
  wide?: boolean;
  copyWhat?: string;
}) {
  if (!value) return null;
  return (
    <div className={wide ? "min-w-0 sm:col-span-2" : "min-w-0"}>
      <dt className="eyebrow text-faint">{label}</dt>
      <dd className={`mt-0.5 break-all text-[12.5px] ${mono ? "font-mono" : ""}`}>
        {copyWhat ? <Copyable value={value} what={copyWhat} /> : value}
      </dd>
    </div>
  );
}
