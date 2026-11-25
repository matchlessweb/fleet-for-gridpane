"use client";

import * as React from "react";
import { createPortal } from "react-dom";

const HOVER_DELAY = 400;
const PRESS_DELAY = 480;
const TOUCH_LINGER = 1600;
const GAP = 6;
const GUTTER = 8;

type TooltipOptions = {
  /** Names the control. For an icon button this is also its accessible name. */
  label: React.ReactNode;
  /** Its key, shown beside the name: "⌘K", "/", "Esc". */
  keys?: string;
  /** True when the text adds to the control's name instead of repeating it. */
  describes?: boolean;
  disabled?: boolean;
};

type TriggerProps = {
  ref: React.RefCallback<HTMLElement>;
  onPointerEnter: React.PointerEventHandler;
  onPointerLeave: React.PointerEventHandler;
  onPointerDown: React.PointerEventHandler;
  onPointerUp: React.PointerEventHandler;
  onPointerCancel: React.PointerEventHandler;
  onFocus: React.FocusEventHandler;
  onBlur: React.FocusEventHandler;
  onClickCapture: React.MouseEventHandler;
  "aria-describedby"?: string;
};

/**
 * useTooltip — the hint that names a control and shows its key. It replaces
 * the browser's `title` text, which never shows on touch or for keyboard
 * users: here a mouse gets it after a short rest, the keyboard as soon as
 * focus lands, and a finger on a long press (which then does not press the
 * control). The bubble is a portal, so the control's own box and its place in
 * a flex row are untouched.
 */
export function useTooltip({ label, keys, describes = false, disabled = false }: TooltipOptions) {
  const id = React.useId();
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ left: number; top: number } | null>(null);
  const trigger = React.useRef<HTMLElement | null>(null);
  const bubble = React.useRef<HTMLDivElement | null>(null);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPress = React.useRef(false); // the hint came from a long press and the finger is still down
  const swallowUntil = React.useRef(0); // the click that follows lifting that finger is not a press

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = React.useCallback(() => {
    clear();
    setOpen(false);
    setPos(null);
  }, []);
  const showAfter = (ms: number, then?: () => void) => {
    clear();
    timer.current = setTimeout(() => {
      timer.current = null;
      setOpen(true);
      then?.();
    }, ms);
  };

  React.useEffect(() => clear, []);

  // Place it over the control, or under it when there is no room, and keep it on screen.
  React.useLayoutEffect(() => {
    if (!open || !trigger.current || !bubble.current) return;
    const t = trigger.current.getBoundingClientRect();
    const b = bubble.current.getBoundingClientRect();
    const above = t.top - GAP - b.height;
    const top = above >= GUTTER ? above : t.bottom + GAP;
    const left = Math.max(GUTTER, Math.min(t.left + t.width / 2 - b.width / 2, window.innerWidth - b.width - GUTTER));
    setPos({ left: Math.round(left), top: Math.round(top) });
  }, [open, label, keys]);

  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open, hide]);

  const triggerProps: TriggerProps = {
    ref: (el) => {
      trigger.current = el;
    },
    onPointerEnter: (e) => {
      if (!disabled && e.pointerType === "mouse") showAfter(HOVER_DELAY);
    },
    onPointerLeave: (e) => {
      if (e.pointerType === "mouse") return hide();
      // A finger: this also fires right after it lifts. A hint still waiting to show is dropped; one that is
      // showing keeps the timer that takes it away, or gets one if the finger slid off while holding.
      if (!open) clear();
      else if (!timer.current) timer.current = setTimeout(hide, TOUCH_LINGER);
    },
    onPointerDown: (e) => {
      if (disabled) return;
      if (e.pointerType === "mouse") return hide();
      // A long press shows the name and is then not a press.
      longPress.current = false;
      swallowUntil.current = 0;
      showAfter(PRESS_DELAY, () => {
        longPress.current = true;
      });
    },
    onPointerUp: (e) => {
      if (e.pointerType === "mouse") return;
      if (timer.current && !open) return clear();
      if (longPress.current) {
        // Only the click this lift produces is held back. A press that is abandoned (the finger slides off, a
        // scroll takes over) produces none, and the next real tap must go through.
        longPress.current = false;
        swallowUntil.current = performance.now() + 700;
      }
      if (open && !timer.current) timer.current = setTimeout(hide, TOUCH_LINGER);
    },
    onPointerCancel: () => {
      longPress.current = false;
      swallowUntil.current = 0;
      hide();
    },
    onFocus: (e) => {
      if (!disabled && e.currentTarget.matches(":focus-visible")) setOpen(true);
    },
    onBlur: () => hide(),
    onClickCapture: (e) => {
      if (performance.now() > swallowUntil.current) return;
      swallowUntil.current = 0;
      e.preventDefault();
      e.stopPropagation();
    },
    ...(describes && open ? { "aria-describedby": id } : {}),
  };

  const node =
    open && typeof document !== "undefined"
      ? createPortal(
          <div
            ref={bubble}
            id={id}
            role={describes ? "tooltip" : undefined}
            aria-hidden={describes ? undefined : true}
            data-tooltip=""
            style={pos ? { left: pos.left, top: pos.top } : { left: 0, top: 0, visibility: "hidden" }}
            className="anim-fade pointer-events-none fixed z-[400] flex max-w-[min(280px,calc(100vw-16px))] items-center gap-2 rounded-md bg-foreground px-2 py-[5px] text-[11.5px] font-medium leading-snug text-background shadow-2xl"
          >
            <span>{label}</span>
            {keys != null && (
              <kbd className="shrink-0 rounded-sm border border-background/35 px-1 font-mono text-[10px] leading-[1.5]">{keys}</kbd>
            )}
          </div>,
          document.body
        )
      : null;

  return { triggerProps, tooltip: node };
}

type AnyProps = Record<string, unknown>;
const chain =
  (ours: (e: never) => void, theirs: unknown) =>
  (e: never) => {
    if (typeof theirs === "function") (theirs as (e: never) => void)(e);
    ours(e);
  };

/**
 * Tooltip — wraps exactly one control and adds the hint to it, with no extra
 * element around it. `IconButton` has this built in; use this for anything else
 * that needs naming (a link that is only an icon, a figure's label).
 */
export function Tooltip({ children, ...options }: TooltipOptions & { children: React.ReactElement<AnyProps> }) {
  const { triggerProps, tooltip } = useTooltip(options);
  const child = React.Children.only(children);
  const theirs = child.props;
  const merged: AnyProps = {};
  for (const [name, ours] of Object.entries(triggerProps)) {
    if (name === "ref") {
      const theirRef = theirs.ref as React.Ref<HTMLElement> | undefined;
      merged.ref = (el: HTMLElement | null) => {
        (ours as React.RefCallback<HTMLElement>)(el);
        if (typeof theirRef === "function") theirRef(el);
        else if (theirRef && typeof theirRef === "object") (theirRef as React.RefObject<HTMLElement | null>).current = el;
      };
    } else if (typeof ours === "function") {
      merged[name] = chain(ours as (e: never) => void, theirs[name]);
    } else if (ours != null) {
      merged[name] = ours;
    }
  }
  return (
    <>
      {React.cloneElement(child, merged)}
      {tooltip}
    </>
  );
}
