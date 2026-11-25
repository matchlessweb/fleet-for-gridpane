/**
 * Ids for the rows in the sites list, and the id in a site page's address.
 *
 * A staging copy has no row of its own in the database: the sites list shows
 * one beside its live site and needs an id for it that no real site can have.
 * Real ids are positive whole numbers, so a copy's id is its live site's id
 * made negative.
 *
 * It used to be "the live id plus 1,000,000", read back as "anything from
 * 1,000,000 up is a copy". GridPane's own ids then passed a million, and every
 * newer site's page was read as the staging copy of a site that does not exist
 * (not found). The same rule could also have pointed a save at another site.
 */

/** The list's id for the staging copy of a live site. */
export const stagingRowId = (liveSiteId: number): number => -liveSiteId;

/**
 * Read the id in /sites/<id>. A negative id is the staging copy of that live
 * site. Anything that is not a whole number other than zero is no site at all.
 */
export function readSiteParam(raw: string | null | undefined): { siteId: number; staging: boolean } | null {
  if (typeof raw !== "string" || !/^-?[1-9][0-9]{0,14}$/.test(raw)) return null;
  const n = Number(raw);
  return { siteId: Math.abs(n), staging: n < 0 };
}
