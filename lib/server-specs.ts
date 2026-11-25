/**
 * Where a server's specs actually come from.
 *
 * GridPane populates `servers.cpu` / `servers.ram` only for nodes it provisioned
 * through an integrated provider. Anything added as a "Custom" VPS returns null
 * from its API forever (verified by calling the server endpoint directly).
 * That is why a bring-your-own node reads "no report yet" until its agent reports, while one
 * provisioned through an integrated provider does not.
 *
 * So specs are resolved in this order:
 *   1. measured  — the fleet agent read it off the box (server_hardware)
 *   2. recorded  — whatever is on the servers row: GridPane's value, or a number
 *                  typed into the Configure modal
 *   3. unknown   — neither
 *
 * Measured wins because it survives a resize and cannot drift the way a typed
 * value does.
 */

export type ServerHardware = {
  server_id: number;
  cpu_cores: number | null;
  ram_total_mb: number | null;
  vendor: string | null;
  product: string | null;
  reported_at: string;
};

export type SpecSource = "measured" | "recorded" | "unknown";

export type ResolvedSpec = {
  /** Ready to render, e.g. "4 cores". Null when nothing is known. */
  text: string | null;
  source: SpecSource;
  /** Exact reading, for a tooltip — only set when measured. */
  exact?: string;
};

/** A value the server's agent measures, before its first report. */
export const PENDING_LABEL = "no report yet";
/** A value read from GridPane, before a sync has read it. */
export const NOT_SYNCED_LABEL = "not synced yet";

/** GridPane writes the string "undefined" into these columns often enough to matter. */
function recorded(value: string | null | undefined): string | null {
  if (!value || value === "undefined" || value === "null") return null;
  return value;
}

export function resolveCores(
  server: { cpu?: string | null } | null,
  hardware?: ServerHardware | null
): ResolvedSpec {
  if (hardware?.cpu_cores) {
    return {
      text: `${hardware.cpu_cores} ${hardware.cpu_cores === 1 ? "core" : "cores"}`,
      source: "measured",
      exact: `${hardware.cpu_cores} logical cores reported by the host`,
    };
  }
  const fromRecord = recorded(server?.cpu);
  if (fromRecord) {
    const n = parseInt(fromRecord, 10);
    if (!Number.isNaN(n)) return { text: `${n} ${n === 1 ? "core" : "cores"}`, source: "recorded" };
  }
  return { text: null, source: "unknown" };
}

/**
 * Plan sizes a host actually sells. An OS never reports the full nominal figure —
 * the kernel reserves a slice — so a 32 GB box measures ~30.6 GiB. Snapping to the
 * ladder shows the size you bought; the exact reading stays available as a tooltip.
 */
const PLAN_SIZES_GB = [1, 2, 4, 6, 8, 12, 16, 24, 32, 48, 64, 96, 128, 192, 256, 384, 512];

export function nominalRamGb(totalMb: number): number | null {
  const measured = totalMb / 1024;
  for (const size of PLAN_SIZES_GB) {
    // Within 10% under the plan size, and never above it.
    if (measured <= size && measured >= size * 0.9) return size;
  }
  return null;
}

export function resolveRam(
  server: { ram?: string | null } | null,
  hardware?: ServerHardware | null
): ResolvedSpec {
  if (hardware?.ram_total_mb) {
    const nominal = nominalRamGb(hardware.ram_total_mb);
    const measuredGb = hardware.ram_total_mb / 1024;
    return {
      text: nominal ? `${nominal} GB` : `${measuredGb.toFixed(1)} GB`,
      source: "measured",
      exact: `${hardware.ram_total_mb} MiB usable, measured on the host`,
    };
  }
  const fromRecord = recorded(server?.ram);
  if (fromRecord) {
    const mb = parseInt(fromRecord, 10);
    if (!Number.isNaN(mb)) return { text: `${mb / 1024} GB`, source: "recorded" };
  }
  return { text: null, source: "unknown" };
}

/**
 * Numeric forms for filtering and sorting, resolved the same way as the labels.
 *
 * These return null rather than 0 for an unknown spec. `Number(null)` is 0, not
 * NaN, which is how "0 cores" and "0 GB RAM" ended up as real options in the
 * servers filter dropdowns — every spec-less node collapsed onto a zero bucket.
 */
export function effectiveCores(
  server: { cpu?: string | null } | null,
  hardware?: ServerHardware | null
): number | null {
  if (hardware?.cpu_cores) return hardware.cpu_cores;
  const n = parseInt(server?.cpu ?? "", 10);
  return Number.isNaN(n) || n <= 0 ? null : n;
}

/** Whole GB, normalised so a measured 7751 MiB box filters alongside a recorded 8192 MB one. */
export function effectiveRamGb(
  server: { ram?: string | null } | null,
  hardware?: ServerHardware | null
): number | null {
  if (hardware?.ram_total_mb) {
    return nominalRamGb(hardware.ram_total_mb) ?? Math.round(hardware.ram_total_mb / 1024);
  }
  const mb = parseInt(server?.ram ?? "", 10);
  return Number.isNaN(mb) || mb <= 0 ? null : Math.round(mb / 1024);
}

/**
 * Hypervisors that hand back a generic string instead of naming themselves.
 * When we get one of these, the reading tells us nothing and GridPane's own
 * label is the better answer.
 */
const GENERIC_VENDORS = new Set([
  "qemu",
  "bochs",
  "kvm",
  "unknown",
  "none",
  "not specified",
  "default string",
  "system manufacturer",
  "to be filled by o.e.m.",
]);

export function isMeaningfulVendor(vendor: string | null | undefined): boolean {
  if (!vendor) return false;
  return !GENERIC_VENDORS.has(vendor.trim().toLowerCase());
}

export type ResolvedProvider = {
  /** Who actually runs the metal, e.g. "Vultr" or "Hetzner". */
  label: string;
  source: "detected" | "gridpane";
  /**
   * GridPane's own name for the node, when it says something different from
   * the vendor — "PeakFreq" for its managed Vultr provisioning, "Custom" for a
   * bring-your-own box. Null when the two agree and there is nothing to
   * disambiguate.
   */
  managedAs: string | null;
};

/**
 * The provider label.
 *
 * Two separate facts live here and collapsing them loses information: the
 * hardware vendor the box reports, and how GridPane came to manage it. A Vultr
 * instance spun up on a personal API key and one provisioned through PeakFreq
 * are the same metal under different management, and they must not read alike.
 *
 * So: the detected vendor is the label, and GridPane's name rides along as a
 * badge whenever it differs. We do NOT infer the vendor from GridPane's side —
 * if the box won't say who it runs on, GridPane's label stands alone.
 */
export function resolveProvider(
  gridpaneLabel: string,
  hardware?: ServerHardware | null
): ResolvedProvider {
  if (isMeaningfulVendor(hardware?.vendor)) {
    const label = hardware!.vendor!.trim();
    const differs = label.toLowerCase() !== gridpaneLabel.trim().toLowerCase();
    return { label, source: "detected", managedAs: differs ? gridpaneLabel : null };
  }
  return { label: gridpaneLabel, source: "gridpane", managedAs: null };
}

/** One sentence explaining where the label came from. Shared by both branches. */
export function providerCaption(
  provider: ResolvedProvider,
  hardware?: ServerHardware | null
): string {
  if (provider.source !== "detected") {
    if (!hardware) {
      return "GridPane's label. Once the fleet agent runs here, the host reports its own vendor.";
    }
    return `GridPane's label — this host reports a generic vendor${
      hardware.vendor ? ` ("${hardware.vendor}")` : ""
    }, so there is nothing better to show.`;
  }

  const model = hardware?.product ? ` · ${hardware.product}` : "";
  if (!provider.managedAs) {
    return `${provider.label} detected on the host${model}.`;
  }
  if (provider.managedAs.trim().toLowerCase() === "custom") {
    return `${provider.label} detected on the host${model}. Added to GridPane as a custom VPS, which is why GridPane reports no specs for it.`;
  }
  return `${provider.label} detected on the host${model}. Provisioned and managed through ${provider.managedAs}.`;
}
