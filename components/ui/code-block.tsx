"use client";

import * as React from "react";
import { Check, Copy } from "lucide-react";
import { cn, tied } from "@/lib/utils";
import { Button } from "./button";
import { useCopy } from "./copy-button";

type CodeBlockKind = "file" | "command" | "dashboard" | "destructive";

const prefixes: Record<CodeBlockKind, string> = {
  file: "File: ",
  command: "Shell: ",
  dashboard: "Dashboard: ",
  destructive: "Destructive: ",
};

type CodeBlockProps = {
  /** What the code is: a path for a file, a few words for commands. */
  label: React.ReactNode;
  /** A file to write, commands to run, steps in a dashboard, or commands that destroy something. */
  kind?: CodeBlockKind;
  /** What is shown in the well. */
  code: string;
  /** What lands on the clipboard, when that is more than what is shown (a script that writes the file, say). */
  copyValue?: string;
  /** The button's words. They stay put when it is pressed: the icon turns into a check. */
  copyLabel?: string;
  /** One line under the well on why the code is written this way. */
  footnote?: React.ReactNode;
  className?: string;
};

/**
 * CodeBlock — a labeled, ink-dark well of code with one copy button. The one
 * way to show a file, a script or a command the user will paste somewhere
 * else. The button keeps its width when pressed.
 */
export function CodeBlock({ label, kind = "file", code, copyValue, copyLabel = "Copy", footnote, className }: CodeBlockProps) {
  const { state, copy } = useCopy(copyValue ?? code);
  const danger = kind === "destructive";
  return (
    <div className={cn("flex flex-col gap-2", className)} data-code-block={kind}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate font-mono text-[11px] text-muted-foreground">
          <span className={cn("font-semibold", danger ? "text-danger" : "text-primary")}>{prefixes[kind]}</span>
          {label}
        </span>
        <Button size="sm" variant={danger ? "danger" : "ghost"} onClick={copy} data-copied={state === "copied" || undefined}>
          {state === "copied" ? <Check size={14} strokeWidth={2.25} aria-hidden="true" /> : <Copy size={14} strokeWidth={1.75} aria-hidden="true" />}
          {copyLabel}
        </Button>
        <span role="status" className="sr-only">
          {state === "copied" ? "Copied" : state === "failed" ? "Could not copy" : ""}
        </span>
      </div>
      <div className="overflow-x-auto rounded-md bg-sunken p-4">
        <pre className="font-mono text-[11px] leading-relaxed text-on-sunken">
          <code>{code}</code>
        </pre>
      </div>
      {footnote != null && <p className="text-pretty text-[11.5px] leading-relaxed text-faint">{tied(footnote)}</p>}
    </div>
  );
}
