"use client";

import { useSyncExternalStore } from "react";

/**
 * What the site buttons need: is one-click sign-in on, is it open to this
 * person, and which sites have opted in. One request per page, shared by every
 * button on it. Until it answers, and whenever it fails, everything is off and
 * the buttons are the plain links they have always been.
 */
export type SsoState = { enabled: boolean; mine: boolean; sites: ReadonlySet<string>; loaded: boolean };

const OFF: SsoState = { enabled: false, mine: false, sites: new Set(), loaded: false };
const MAX_AGE_MS = 60_000;

let current: SsoState = OFF;
let loadedAt = 0;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function load(force = false): Promise<void> {
  if (loading) return loading;
  if (!force && current.loaded && Date.now() - loadedAt < MAX_AGE_MS) return Promise.resolve();
  loading = fetch("/api/sso/state", { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((j: { enabled?: unknown; mine?: unknown; sites?: unknown } | null) => {
      current = {
        enabled: j?.enabled === true,
        mine: j?.mine === true,
        sites: new Set(Array.isArray(j?.sites) ? j.sites.filter((s): s is string => typeof s === "string") : []),
        loaded: true,
      };
      loadedAt = Date.now();
      loading = null;
      listeners.forEach((fn) => fn());
    });
  return loading;
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  void load();
  return () => {
    listeners.delete(onChange);
  };
}

export function useSsoState(): SsoState {
  return useSyncExternalStore(subscribe, () => current, () => OFF);
}

/** Call after changing a site's setting or the master switch. */
export const refreshSsoState = () => load(true);

export const ssoSiteKey = (serverId: number, hostname: string) => `${serverId}|${hostname}`;

/** Does this site, on this server, get the one-click button for this person? */
export function ssoIsOn(state: SsoState, serverId: number | null | undefined, hostname: string): boolean {
  return state.enabled && state.mine && typeof serverId === "number" && state.sites.has(ssoSiteKey(serverId, hostname));
}

export const ssoOpenHref = (serverId: number, hostname: string) => `/sso/open?server=${serverId}&host=${encodeURIComponent(hostname)}`;

/**
 * "Someone is about to click": the servers check for requests every second for
 * the next ten minutes, so the click itself is quick. At most once every five
 * minutes from one tab.
 */
let armedAt = 0;
export function armSso() {
  if (Date.now() - armedAt < 5 * 60_000) return;
  armedAt = Date.now();
  fetch("/api/sso/arm", { method: "POST", cache: "no-store" }).catch(() => {
    armedAt = 0;
  });
}

/**
 * The sign-in page starts by itself only when it was opened by a click on one
 * of Fleet's own buttons, seconds ago. Opened any other way (a pasted address,
 * a link on another site) it waits for a click.
 */
const INTENT_KEY = "fleet-sso-intent";
const INTENT_MAX_AGE_MS = 30_000;

export function noteSsoClick(serverId: number, hostname: string) {
  try {
    window.localStorage.setItem(INTENT_KEY, `${ssoSiteKey(serverId, hostname)}@${Date.now()}`);
  } catch {
    // Storage is blocked: the sign-in page will ask for one more click.
  }
}

export function takeSsoClick(serverId: number, hostname: string): boolean {
  try {
    const raw = window.localStorage.getItem(INTENT_KEY);
    window.localStorage.removeItem(INTENT_KEY);
    if (!raw) return false;
    const at = raw.lastIndexOf("@");
    const age = Date.now() - Number(raw.slice(at + 1));
    return raw.slice(0, at) === ssoSiteKey(serverId, hostname) && age >= 0 && age < INTENT_MAX_AGE_MS;
  } catch {
    return false;
  }
}
