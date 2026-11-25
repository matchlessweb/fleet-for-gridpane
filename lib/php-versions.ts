/**
 * PHP versions GridPane can serve. Keep in sync with GridPane's site settings UI.
 *
 * This list was previously hardcoded inline in the site detail page and stopped at
 * 8.3, so sites running 8.4 rendered as "7.4" — a <select> with no matching <option>
 * falls back to showing the first one, which misreported the live PHP version of
 * every 8.4 site. Always build the option list with `phpVersionOptions(current)` so
 * the site's actual version is present even if this list falls behind again.
 */
export const PHP_VERSIONS = ["7.4", "8.0", "8.1", "8.2", "8.3", "8.4", "8.5"] as const;

/** Options for a version select, guaranteed to contain `current`. */
export function phpVersionOptions(current?: string | null): string[] {
  const list = [...PHP_VERSIONS] as string[];
  if (current && !list.includes(current)) {
    return [...list, current].sort((a, b) => parseFloat(a) - parseFloat(b));
  }
  return list;
}
