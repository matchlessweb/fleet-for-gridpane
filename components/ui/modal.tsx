"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useMounted } from "@/lib/use-mounted";
import { IconButton } from "./button";
import { useOverlay } from "./use-overlay";

type ModalProps = {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  meta?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
};

/**
 * Modal — a centered box for a form or a longer task. For a yes-or-no
 * question use ConfirmDialog; for a look at one row use Peek.
 */
export function Modal({
  open,
  onClose,
  title,
  meta,
  children,
  className,
  contentClassName,
}: ModalProps) {
  const mounted = useMounted();
  const hostRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const close = useOverlay(open, onClose, hostRef);

  if (!mounted || !open) return null;

  return createPortal(
    <div
      ref={hostRef}
      data-overlay-root=""
      className="fixed inset-0 z-[100] flex items-center justify-center p-5 pb-[calc(20px+env(safe-area-inset-bottom))]"
    >
      <div
        aria-hidden="true"
        onClick={close}
        className="absolute inset-0 bg-foreground/25 backdrop-blur-[2px] anim-fade"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={title != null ? titleId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[85dvh] w-full max-w-lg flex-col bg-panel border border-line-strong rounded-lg shadow-2xl outline-none anim-pop",
          className
        )}
      >
        <div className="flex items-baseline gap-2.5 border-b border-border px-5 py-3.5">
          {/* Rulehead TEXT only — the header strip's hairline replaces the
              full-width ink rule, so the utility's own pb/rule is zeroed. */}
          {title != null && (
            <span id={titleId} className="rulehead pb-0 border-b-0!">{title}</span>
          )}
          {/* min-w-0 + truncate: a long meta (a site's address) shortens instead of
              pushing the close button past the panel's edge on a phone. */}
          {meta != null && <span className="eyebrow min-w-0 truncate text-faint">{meta}</span>}
          <IconButton
            label="Close"
            keys="Esc"
            onClick={close}
            className="ml-auto shrink-0 self-center"
          >
            <X size={14} strokeWidth={1.75} />
          </IconButton>
        </div>
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto px-5 py-4", contentClassName)}
        >
          {children}
        </div>
      </div>
    </div>,
    document.body
  );
}
