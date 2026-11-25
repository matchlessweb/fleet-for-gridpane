/**
 * Everything that names this deployment, in one place. Change this file to rebrand.
 *
 * Colors: the two values here tint the browser and phone chrome. The palette itself is the CSS
 * tokens at the top of `app/globals.css`; keep `themeColor` equal to `--background` there.
 */
export const fleetConfig = {
  /** Product name: page titles, the home-screen app name, the masthead link's label. */
  name: "Fleet",
  /** Under a home-screen icon. Keep it to about 12 characters. */
  shortName: "Fleet",
  /** The wordmark in the masthead and on the sign-in page. The dot after it takes the brand color. */
  wordmark: "FLEET",
  description: "GridPane fleet operations: servers, sites, backups, telemetry.",
  /** First words of the footer line. */
  footerLabel: "Fleet ledger",
  /**
   * The hostname passkeys are registered for (the relying-party domain set in Supabase Auth).
   * Passkey sign-in is offered only when the app is open on this hostname.
   */
  hostname: "fleet.example.com",
  /**
   * Where this deployment's code lives. The server scripts write it into the `Documentation=` line
   * of the sign-in service they install (scripts/install-fleet-sso-agent.sh).
   */
  repoUrl: "https://github.com/example/fleet",
  /**
   * The launchd label of the daily WAF refresh job on your Mac (scripts/install-waf-refresh.sh).
   * A reverse-DNS name under a domain of yours. Change it after installing and the old job stays
   * installed under the old label: remove that one first.
   */
  wafRefreshLabel: "com.example.fleet-waf-refresh",
  /** Browser and phone chrome, per theme. Equal to `--background` in app/globals.css. */
  themeColor: { light: "#FAFAF7", dark: "#131614" },
  /**
   * Names for what Fleet installs on servers. They are a contract with what is already installed:
   * change them on a fleet that is in use and Fleet stops recognizing its own files and jails.
   * The server scripts under scripts/ read the same names from this file (scripts/lib-fleet-names.sh),
   * or from FLEET_PREFIX, FLEET_JAIL_PREFIX and FLEET_NAME when those are set. `npm run config:test`
   * and `npm run names:test` fail if the app and the scripts fall out of step.
   */
  server: {
    /** Files and the Fail2Ban action: `<prefix>-cloudflare`, `/etc/logrotate.d/<prefix>-7g-logs`. 2 to 15 lowercase letters and digits, starting with a letter. */
    prefix: "fleet",
    /** Fail2Ban jails and filters: `<jailPrefix>-<site>-<four hex>-<kind>`. The same rule; a short one leaves more of the site's name in the jail's. */
    jailPrefix: "fleet",
    /** Site folders on a server that are deliberately not counted, each with its reason. */
    skippedFolders: [] as ReadonlyArray<{ site: string; reason: string }>,
  },
  /** Example text inside empty fields. */
  placeholders: { allowlistLabel: "Office" },
} as const;

export type FleetConfig = typeof fleetConfig;
