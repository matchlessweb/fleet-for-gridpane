"use client";

import { useCallback, useEffect, useState } from "react";
import { Fingerprint, Loader2, Trash2 } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { toast } from "sonner";
import { fleetConfig } from "@/fleet.config";
import { useClientValue } from "@/lib/use-client-value";
import {
  Button,
  IconButton,
  Modal,
  Panel,
  PanelHeader,
  Skeleton,
  StatusPill,
} from "@/components/ui";

type PasskeyRow = {
  id: string;
  friendly_name?: string;
  created_at: string;
  last_used_at?: string;
};

/** Passkeys are bound to the relying-party domain configured in Supabase. */
const RP_HOSTNAME: string = fleetConfig.hostname;

export function PasskeyManager() {
  const [passkeys, setPasskeys] = useState<PasskeyRow[] | null>(null);
  /** True when the Supabase project has passkeys switched off (a new project does). */
  const [passkeysOff, setPasskeysOff] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<PasskeyRow | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const onRpDomain = useClientValue(() => window.location.hostname === RP_HOSTNAME, false);

  const supabase = createClient();

  /** The account's passkeys; an empty list when they cannot be read. `off` is true when the project has passkeys switched off. */
  const fetchPasskeys = useCallback(async (): Promise<{ rows: PasskeyRow[]; off: boolean }> => {
    try {
      const { data, error } = await supabase.auth.passkey.list();
      if (error) throw error;
      return { rows: data ?? [], off: false };
    } catch (error) {
      // A project with passkeys switched off is a setting, not a fault: say so below and log nothing.
      if (error instanceof Error && /passkeys? (are|is) disabled/i.test(error.message)) {
        return { rows: [], off: true };
      }
      console.error("Error listing passkeys:", error);
      return { rows: [], off: false };
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadPasskeys = useCallback(async () => {
    const { rows, off } = await fetchPasskeys();
    setPasskeys(rows);
    setPasskeysOff(off);
  }, [fetchPasskeys]);

  useEffect(() => {
    void fetchPasskeys().then(({ rows, off }) => {
      setPasskeys(rows);
      setPasskeysOff(off);
    });
  }, [fetchPasskeys]);

  const registerPasskey = async () => {
    setIsRegistering(true);
    try {
      const { error } = await supabase.auth.registerPasskey();
      if (error) throw error;
      toast.success("Passkey added.");
      await loadPasskeys();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      // The user closing the OS prompt is a cancel, not a failure.
      if (!/abort|cancel|timed? ?out|not allowed/i.test(message)) {
        toast.error(message || "Could not add a passkey.");
      }
    } finally {
      setIsRegistering(false);
    }
  };

  const deletePasskey = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const { error } = await supabase.auth.passkey.delete({
        passkeyId: deleteTarget.id,
      });
      if (error) throw error;
      toast.success("Passkey removed.");
      setDeleteTarget(null);
      await loadPasskeys();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "";
      toast.error(message || "Could not remove the passkey.");
    } finally {
      setIsDeleting(false);
    }
  };

  const formatDate = (iso: string) =>
    new Date(iso).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });

  return (
    <section className="flex flex-col gap-4">
      <PanelHeader title="Passkeys" />
      <Panel className="p-5">
        <div className="flex max-w-2xl flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
            Sign in with Face ID, Touch ID, or a hardware key — one step, no
            password, no code. Passkeys work on {RP_HOSTNAME}; password and
            two-factor sign-in stay available everywhere as the{"\u00a0"}fallback.
          </p>

          {passkeysOff ? (
            <p className="text-[12px] leading-relaxed text-pretty text-faint">
              Passkeys are not turned on in this Supabase project. SETUP.md,
              step 3, item 5, says what they need.
            </p>
          ) : passkeys === null ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-9 w-full" />
              <Skeleton className="h-9 w-full" />
            </div>
          ) : passkeys.length > 0 ? (
            <ul className="flex flex-col divide-y divide-border rounded-md border border-border">
              {passkeys.map((pk) => (
                <li
                  key={pk.id}
                  className="flex items-center gap-3 px-3.5 py-2.5"
                >
                  <Fingerprint
                    size={15}
                    strokeWidth={1.75}
                    className="shrink-0 text-primary"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">
                      {pk.friendly_name || "Passkey"}
                    </p>
                    <p className="text-[11px] text-faint">
                      Added {formatDate(pk.created_at)}
                      {pk.last_used_at
                        ? ` · last used ${formatDate(pk.last_used_at)}`
                        : ""}
                    </p>
                  </div>
                  <IconButton
                    label="Remove passkey"
                    onClick={() => setDeleteTarget(pk)}
                  >
                    <Trash2 size={14} strokeWidth={1.75} />
                  </IconButton>
                </li>
              ))}
            </ul>
          ) : null}

          {!passkeysOff && (
            <div className="flex flex-wrap items-center gap-3">
              {passkeys !== null && passkeys.length > 0 && (
                <StatusPill tone="ok" led>
                  {passkeys.length === 1
                    ? "1 passkey active"
                    : `${passkeys.length} passkeys active`}
                </StatusPill>
              )}
              <Button
                variant={passkeys?.length ? "ghost" : "solid"}
                onClick={registerPasskey}
                disabled={isRegistering || !onRpDomain}
              >
                {isRegistering ? (
                  <Loader2 className="animate-spin" size={14} strokeWidth={1.75} />
                ) : (
                  <>
                    <Fingerprint size={14} strokeWidth={1.75} /> Add passkey
                  </>
                )}
              </Button>
            </div>
          )}

          {!passkeysOff && !onRpDomain && (
            <p className="text-[12px] leading-relaxed text-pretty text-faint">
              Passkeys are registered on the live dashboard — open{" "}
              <span className="font-mono">https://{RP_HOSTNAME}</span> to add
              one. This preview host cannot hold a passkey for that{"\u00a0"}domain.
            </p>
          )}
        </div>
      </Panel>

      <Modal
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        title="Remove passkey"
        meta="WEBAUTHN"
      >
        <div className="flex flex-col gap-4">
          <p className="text-[13px] leading-relaxed text-pretty text-muted-foreground">
            {`"${deleteTarget?.friendly_name || "This passkey"}" will no longer
            sign in to ${fleetConfig.name}. The credential also remains in the
            device's own passkey store until removed there.`}
          </p>
          <div className="flex flex-col-reverse items-stretch gap-2 border-t border-border pt-4 sm:flex-row sm:items-center sm:justify-end">
            <Button
              variant="ghost"
              onClick={() => setDeleteTarget(null)}
              disabled={isDeleting}
            >
              Cancel
            </Button>
            <Button variant="danger" onClick={deletePasskey} disabled={isDeleting}>
              {isDeleting ? (
                <Loader2 size={14} strokeWidth={1.75} className="animate-spin" />
              ) : (
                "Remove passkey"
              )}
            </Button>
          </div>
        </div>
      </Modal>
    </section>
  );
}
