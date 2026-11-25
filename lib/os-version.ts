/**
 * Operating system labels.
 *
 * `servers.os_version` is GridPane's image slug, copied at sync: "ubuntu-22-04-x64".
 * It records the release GridPane provisioned. GridPane moves sites to a new
 * server rather than upgrading Ubuntu in place, so this matches what runs unless
 * someone upgraded a box by hand.
 */

/** GridPane writes the string "undefined" into text columns often enough to matter. */
function present(value: string | null | undefined): string | null {
  const v = value?.trim();
  if (!v || v === "undefined" || v === "null") return null;
  return v;
}

/**
 * "ubuntu-24-04-x64" → "Ubuntu 24.04 LTS". Anything that does not look like a
 * GridPane Ubuntu slug is shown as stored rather than guessed at. Null when unknown.
 */
export function formatOsVersion(raw: string | null | undefined): string | null {
  const v = present(raw);
  if (!v) return null;
  const m = /^ubuntu-(\d{2})-(\d{2})(?:-[a-z0-9_]+)?$/i.exec(v);
  if (!m) return v;
  const [, major, minor] = m;
  // Ubuntu's long-term releases are the April release of even years.
  const lts = minor === "04" && Number(major) % 2 === 0;
  return `Ubuntu ${major}.${minor}${lts ? " LTS" : ""}`;
}

/** Filter value for a server's OS; servers with none share one bucket. */
export const OS_UNKNOWN = "unknown";

export function osFilterKey(raw: string | null | undefined): string {
  return present(raw) ?? OS_UNKNOWN;
}
