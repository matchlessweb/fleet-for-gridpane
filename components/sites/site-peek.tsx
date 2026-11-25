"use client";

import * as React from "react";
import Link from "next/link";
import type { Database } from "@/lib/database.types";
import { Button, Field, Peek, PeekSection, StatusPill } from "@/components/ui";
import { SiteLinkActions } from "@/components/sites/site-links";

export type PeekedSite = Database["public"]["Tables"]["sites"]["Row"] & {
  servers: { label: string | null; ip: string | null } | null;
  site_staging_state?: { is_active: boolean } | null;
};

const solidLink =
  "touch-hit inline-flex flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-md bg-primary px-4 py-2 text-[12.5px] font-semibold text-primary-foreground transition-colors duration-150 hover:opacity-90";

const NOT_SET = "not set";
const mono = "font-mono text-[11px] tabular-nums";

/**
 * SitePeek — one site at a glance, from the site list: where it lives and the
 * PHP settings GridPane holds for it. Everything shown is already in the list;
 * nothing is read again and nothing is inferred.
 */
export function SitePeek({
  site,
  onClose,
  onPrev,
  onNext,
  position,
  onEditNickname,
}: {
  site: PeekedSite | null;
  onClose: () => void;
  onPrev?: () => void;
  onNext?: () => void;
  position?: string;
  onEditNickname: (site: PeekedSite) => void;
}) {
  if (!site) return <Peek open={false} onClose={onClose} kind="" title="">{null}</Peek>;

  const serverName = site.servers?.label || "Unknown server";
  const staging = site.url.startsWith("staging.");

  return (
    <Peek
      open
      onClose={onClose}
      kind={staging ? "Staging site" : "Site"}
      kindDetail={serverName}
      title={site.url}
      subtitle={site.site_nickname || undefined}
      status={<StatusPill tone={site.is_wsod ? "danger" : "ok"}>{site.is_wsod ? "Error" : "Active"}</StatusPill>}
      onPrev={onPrev}
      onNext={onNext}
      position={position}
      actions={
        <>
          <Button onClick={() => onEditNickname(site)} className="flex-1 whitespace-nowrap">
            Edit nickname
          </Button>
          <Link href={`/sites/${site.id}`} className={solidLink}>
            Open site
          </Link>
        </>
      }
    >
      <PeekSection>
        <div className="flex items-center justify-between gap-3 py-0.5">
          <span className="eyebrow text-muted-foreground">Visit</span>
          <span className="flex items-center gap-1.5">
            <SiteLinkActions url={site.url} serverId={site.server_id} />
          </span>
        </div>
      </PeekSection>

      <PeekSection title="Where it lives">
        <Field label="Server">
          <span className="flex flex-col items-end">
            {site.server_id != null ? (
              <Link href={`/servers/${site.server_id}`} className="text-[12.5px] font-medium transition-colors duration-150 hover:text-primary">
                {serverName}
              </Link>
            ) : (
              <span className="text-[12.5px]">{serverName}</span>
            )}
            {site.servers?.ip && <span className="font-mono text-[11px] text-muted-foreground">{site.servers.ip}</span>}
          </span>
        </Field>
        {!staging && (
          <Field label="Staging">
            <span className={mono}>{site.site_staging_state?.is_active ? "active" : "none recorded"}</span>
          </Field>
        )}
      </PeekSection>

      <PeekSection title="PHP">
        <Field label="Version">
          <span className={mono}>{site.php_version || NOT_SET}</span>
        </Field>
        <Field label="Process manager">
          <span className={mono}>{site.pm || NOT_SET}</span>
        </Field>
        <Field label="Workers">
          <span className={mono}>{site.pm_max_children ?? NOT_SET}</span>
        </Field>
        <Field label="Memory limit">
          <span className={mono}>{site.memory_limit != null ? `${site.memory_limit} M` : NOT_SET}</span>
        </Field>
        <Field label="Max execution time">
          <span className={mono}>{site.max_execution_time != null ? `${site.max_execution_time} s` : NOT_SET}</span>
        </Field>
        <Field label="Upload limit">
          <span className={mono}>{site.upload_max_filesize != null ? `${site.upload_max_filesize} M` : NOT_SET}</span>
        </Field>
      </PeekSection>
    </Peek>
  );
}
