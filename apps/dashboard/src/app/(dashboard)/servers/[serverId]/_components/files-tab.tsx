"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { FileExplorer } from "@/components/file-manager/FileExplorer";
import { useI18n } from "@/components/i18n-provider";

interface FilesTabProps {
  serverId: string;
  serverName?: string;
}

/**
 * Server file-manager tab — aaPanel-style browse/edit/upload over the
 * control plane's SSH/SFTP connection. Same trust level as the terminal
 * tab beside it; permission-gated server-side (server:read/server:admin).
 */
export function FilesTab({ serverId, serverName }: FilesTabProps) {
  const { t } = useI18n();
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 px-1">
        <div className="flex size-9 items-center justify-center rounded-xl bg-muted ring-1 ring-border/50">
          <UiIcon name="folder-open" className="size-[18px] text-muted-foreground" />
        </div>
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-semibold text-foreground">
            {t.fileManager.title} {serverName ? <span className="text-muted-foreground">· {serverName}</span> : null}
          </h2>
          <p className="text-xs text-muted-foreground">{t.fileManager.description}</p>
        </div>
      </div>
      <FileExplorer serverId={serverId} />
    </div>
  );
}
