"use client";

import { ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { Tooltip, buttonClasses } from "@/components/ui";
import { armSso, noteSsoClick, ssoIsOn, ssoOpenHref, useSsoState } from "@/lib/sso/use-sso";

/**
 * Quick actions for a site: visit it, or open its WordPress admin.
 *
 * Mirrors the two icons GridPane's own panel puts beside every site.
 *
 * REAL ANCHORS, never window.open(). A popup opened outside a direct user
 * gesture is blocked by default in a standalone PWA, which is exactly how this
 * app is installed on the operator's phone.
 *
 * Both leave the app on iOS — a link to another origin always exits a
 * home-screen web app and lands in Safari. There is no cross-origin API to keep
 * it in-app, and GridPane's panel behaves identically, so this is expected
 * rather than a regression.
 *
 * WP ADMIN IS ONE OF TWO THINGS. For a site that has opted in to one-click
 * sign-in (and a person allowed to use it), the button opens /sso/open, which
 * asks the site's server for a sign-in link and goes to it. For every other
 * site, and whenever Fleet cannot tell, it is the plain /wp-admin link it has
 * always been: you land in the dashboard if the browser already holds a
 * WordPress session, otherwise on the login form.
 */

const ICON_LINK =
  "touch-hit inline-flex h-[33px] w-[33px] items-center justify-center bg-panel border border-line-strong rounded-md text-muted-foreground hover:text-foreground transition-colors duration-150";

/**
 * The WordPress mark itself, so the button is recognised at a glance. It is the
 * one filled icon beside lucide's strokes, on purpose: a hand-drawn W in a ring
 * read as a letter, not as WordPress. The path is the Simple Icons one (CC0);
 * the mark is a trademark of the WordPress Foundation and is used here only to
 * point at a site's own WordPress admin. It fills its box edge to edge, where a
 * lucide icon keeps a margin, so it is drawn a little larger to match by eye.
 */
function WordPressMark({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M21.469 6.825c.84 1.537 1.318 3.3 1.318 5.175 0 3.979-2.156 7.456-5.363 9.325l3.295-9.527c.615-1.54.82-2.771.82-3.864 0-.405-.026-.78-.07-1.11m-7.981.105c.647-.03 1.232-.105 1.232-.105.582-.075.514-.93-.067-.899 0 0-1.755.135-2.88.135-1.064 0-2.85-.15-2.85-.15-.585-.03-.661.855-.075.885 0 0 .54.061 1.125.09l1.68 4.605-2.37 7.08L5.354 6.9c.649-.03 1.234-.1 1.234-.1.585-.075.516-.93-.065-.896 0 0-1.746.138-2.874.138-.2 0-.438-.008-.69-.015C4.911 3.15 8.235 1.215 12 1.215c2.809 0 5.365 1.072 7.286 2.833-.046-.003-.091-.009-.141-.009-1.06 0-1.812.923-1.812 1.914 0 .89.513 1.643 1.06 2.531.411.72.89 1.643.89 2.977 0 .915-.354 1.994-.821 3.479l-1.075 3.585-3.9-11.61 .001.014zM12 22.784c-1.059 0-2.081-.153-3.048-.437l3.237-9.406 3.315 9.087c.024.053.05.101.078.149-1.12.393-2.325.609-3.582.609M1.211 12c0-1.564.336-3.05.935-4.39L7.29 21.709C3.694 19.96 1.212 16.271 1.211 12M12 0C5.385 0 0 5.385 0 12s5.385 12 12 12 12-5.385 12-12S18.615 0 12 0" />
    </svg>
  );
}

/**
 * Says what it does, not what the icon suggests. The WordPress mark is the
 * same glyph panels use for single sign-on, so without this the button borrows
 * SSO's promise without SSO's behaviour.
 */
function wpAdminHint(url: string) {
  return (
    <>
      {`wp-admin — ${url}`}
      <br />
      {"Not single sign-on: you'll sign in unless already logged in."}
    </>
  );
}

/**
 * `url` is the row's own hostname. Staging rows already arrive prefixed
 * (`staging.example.com`) from the synthetic clones in the sites list, so both
 * links resolve to the staging host without any extra handling — and, crucially,
 * without touching the row's `id`, which for a staging clone is its live
 * site's id made negative (lib/site-row-id.ts), not a site of its own.
 */
function ssoHint(url: string) {
  return (
    <>
      {`One-click sign-in — ${url}`}
      <br />
      {"Opens wp-admin already signed in."}
    </>
  );
}

/** The two forms of the WP admin link: where it goes, what it says, and what it does on the way. */
function useWpAdminLink(url: string, serverId: number | null | undefined) {
  const sso = ssoIsOn(useSsoState(), serverId, url);
  if (!sso || typeof serverId !== "number") {
    return {
      sso: false as const,
      href: `https://${url}/wp-admin`,
      hint: wpAdminHint(url),
      label: `Open wp-admin for ${url} in a new tab — sign in unless already logged in`,
      handlers: {},
    };
  }
  return {
    sso: true as const,
    href: ssoOpenHref(serverId, url),
    hint: ssoHint(url),
    label: `Sign in to wp-admin for ${url} in a new tab with one click`,
    handlers: {
      // Hovering or tabbing to the button tells the servers a click may follow.
      onPointerEnter: armSso,
      onFocus: armSso,
      onClick: () => noteSsoClick(serverId, url),
    },
  };
}

export function SiteLinkActions({
  url,
  serverId,
  className,
}: {
  url: string;
  /** The row's server. Without it the WP button is always the plain link. */
  serverId?: number | null;
  className?: string;
}) {
  const base = `https://${url}`;
  const wp = useWpAdminLink(url, serverId);

  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Tooltip label={`Visit ${url}`}>
        <a
          href={base}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={`Visit ${url} in a new tab`}
          className={ICON_LINK}
          // Rows elsewhere in the app carry their own click handlers; stop the
          // bubble so a link click never also triggers a row action.
          onClick={(e) => e.stopPropagation()}
        >
          <ExternalLink size={14} strokeWidth={1.75} />
        </a>
      </Tooltip>
      <Tooltip label={wp.hint} describes>
        <a
          href={wp.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={wp.label}
          data-sso={wp.sso ? "on" : "off"}
          className={cn(ICON_LINK, wp.sso && "border-primary/45 text-primary hover:text-primary")}
          onPointerEnter={wp.handlers.onPointerEnter}
          onFocus={wp.handlers.onFocus}
          onClick={(e) => {
            e.stopPropagation();
            wp.handlers.onClick?.();
          }}
        >
          <WordPressMark />
        </a>
      </Tooltip>
    </span>
  );
}

/** Labelled variant for the site detail header, where there is room for words. */
export function SiteLinkButtons({ url, serverId }: { url: string; serverId?: number | null }) {
  const wp = useWpAdminLink(url, serverId);

  return (
    <Tooltip label={wp.hint} describes>
      <a
        href={wp.href}
        target="_blank"
        rel="noopener noreferrer"
        data-sso={wp.sso ? "on" : "off"}
        className={buttonClasses()}
        onPointerEnter={wp.handlers.onPointerEnter}
        onFocus={wp.handlers.onFocus}
        onClick={wp.handlers.onClick}
      >
        <WordPressMark /> {wp.sso ? "Sign in to WP" : "WP Admin"}
      </a>
    </Tooltip>
  );
}
