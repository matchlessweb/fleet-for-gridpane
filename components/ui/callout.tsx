import * as React from "react";
import { CircleAlert, CircleCheck, Info, TriangleAlert } from "lucide-react";
import { cn, tied } from "@/lib/utils";

export type CalloutTone = "note" | "success" | "warning" | "danger";

const tones: Record<CalloutTone, { box: string; icon: string; Icon: typeof Info }> = {
  note: { box: "border-line-strong bg-panel-2", icon: "text-muted-foreground", Icon: Info },
  success: { box: "border-primary/30 bg-primary/8", icon: "text-primary", Icon: CircleCheck },
  warning: { box: "border-warning/35 bg-warning/8", icon: "text-warning", Icon: TriangleAlert },
  danger: { box: "border-danger/35 bg-danger/8", icon: "text-danger", Icon: CircleAlert },
};

type CalloutProps = Omit<React.HTMLAttributes<HTMLDivElement>, "title" | "children"> & {
  tone?: CalloutTone;
  /** A few words in bold. Always ink, never the tone color: colored type on its own tint fails contrast. */
  title?: React.ReactNode;
  /** The message. */
  children?: React.ReactNode;
  /** One next step: a Button or a link. Sits at the right from `sm`, under the message on phones. */
  action?: React.ReactNode;
  /**
   * Set when the callout can appear after the page has loaded, so it is announced
   * politely. "assertive" interrupts: only for an error that follows the user's own action.
   */
  live?: boolean | "assertive";
  /** Tighter, for inside a form or a table. */
  dense?: boolean;
  className?: string;
};

/**
 * Callout — the one way to tell the user something inline: a soft tint in the
 * tone's color, an icon, a title, the message and an optional action. The icon
 * and the title carry the tone, so it never rides on color alone.
 */
export function Callout({ tone = "note", title, children, action, live = false, dense = false, className, ...props }: CalloutProps) {
  const { box, icon, Icon } = tones[tone];
  return (
    <div
      role={live === "assertive" ? "alert" : live ? "status" : undefined}
      data-tone={tone}
      className={cn("flex gap-3 rounded-md border", dense ? "px-3 py-2.5" : "px-4 py-3.5", "max-sm:flex-col sm:items-start", box, className)}
      {...props}
    >
      <div className="flex min-w-0 flex-1 gap-2.5">
        <Icon size={dense ? 14 : 15} strokeWidth={1.9} aria-hidden="true" className={cn("mt-[2px] shrink-0", icon)} />
        <div className="min-w-0 flex-1">
          {title != null && <div className={cn("font-semibold text-foreground", dense ? "text-[12px]" : "text-[12.5px]")}>{title}</div>}
          {children != null && (
            <div className={cn("text-pretty text-foreground/80", dense ? "text-[11.5px] leading-snug" : "text-[12px] leading-relaxed", title != null && "mt-0.5")}>
              {tied(children)}
            </div>
          )}
        </div>
      </div>
      {action != null && <div className="flex shrink-0 flex-wrap items-center gap-2 max-sm:pl-[25px] sm:self-center">{action}</div>}
    </div>
  );
}
