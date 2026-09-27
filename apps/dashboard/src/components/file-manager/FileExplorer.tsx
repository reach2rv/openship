"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { filesApi, type FileEntry } from "@/lib/api/files";
import { getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";
import { FileEditor } from "./FileEditor";

/** Where the explorer starts when the server offers no better hint. */
const DEFAULT_PATH = "/opt/openship";
/** Server refuses to return text past this size — download instead. */
const EDIT_MAX_BYTES = 5 * 1024 * 1024;

/** Extensions worth opening in the text editor; everything else is download-only. */
const TEXT_EXTENSIONS = new Set([
  "conf", "cnf", "ini", "env", "cfg", "config", "properties", "toml", "yaml", "yml",
  "json", "xml", "html", "htm", "css", "scss", "less", "js", "mjs", "cjs", "ts", "tsx",
  "jsx", "py", "rb", "go", "rs", "java", "php", "sh", "bash", "zsh", "sql", "txt",
  "log", "md", "csv", "service", "socket", "timer", "list", "sources", "pid", "lock",
]);

function fileIconName(entry: FileEntry): string {
  if (entry.type === "directory") return "folder";
  if (entry.type === "symlink") return "link";
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "ico"].includes(ext)) return "file-image";
  if (["zip", "tar", "gz", "tgz", "bz2", "xz", "7z", "rar"].includes(ext)) return "file-archive";
  if (TEXT_EXTENSIONS.has(ext)) return "file-code";
  return "file";
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function isTextEditable(entry: FileEntry): boolean {
  if (entry.type !== "file") return false;
  if (entry.size > EDIT_MAX_BYTES) return false;
  const ext = entry.name.split(".").pop()?.toLowerCase() ?? "";
  return TEXT_EXTENSIONS.has(ext) || !ext;
}

/** Parent path ("/opt/a" → "/opt", "/" → "/"). */
function parentOf(path: string): string {
  const idx = path.lastIndexOf("/");
  if (idx <= 0) return "/";
  return path.slice(0, idx);
}

function joinPath(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

type DialogState =
  | { kind: "newFolder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entries: FileEntry[] }
  | null;

interface FileExplorerProps {
  serverId: string;
}

/**
 * aaPanel-style file browser for a server: breadcrumb navigation, upload
 * (button + drag-drop), new folder, rename, delete, download, and a
 * text-file editor. All operations go through the file-manager API,
 * which streams over the control plane's pooled SSH/SFTP connection.
 */
export function FileExplorer({ serverId }: FileExplorerProps) {
  const { t } = useI18n();
  const [path, setPath] = useState(DEFAULT_PATH);
  const [pathInput, setPathInput] = useState(DEFAULT_PATH);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [dialogText, setDialogText] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [editingFile, setEditingFile] = useState<{ entry: FileEntry; path: string } | null>(null);
  const [uploads, setUploads] = useState<{ name: string; size: number }[]>([]);
  const [dragging, setDragging] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const listId = useRef(0);

  const load = useCallback(
    async (target: string) => {
      const id = ++listId.current;
      setLoading(true);
      setError(null);
      try {
        const res = await filesApi.list(serverId, target);
        if (id !== listId.current) return; // stale response
        setEntries(res.entries);
        setPath(res.path);
        setPathInput(res.path);
        setSelected(new Set());
      } catch (err) {
        if (id !== listId.current) return;
        setError(getApiErrorMessage(err, t.fileManager.loadFailed));
        setEntries([]);
      } finally {
        if (id === listId.current) setLoading(false);
      }
    },
    [serverId, t.fileManager.loadFailed],
  );

  useEffect(() => {
    if (serverId) void load(DEFAULT_PATH);
  }, [serverId, load]);

  const breadcrumbs = useMemo(() => {
    const parts = path.split("/").filter(Boolean);
    const crumbs: { name: string; path: string }[] = [{ name: "/", path: "/" }];
    let acc = "";
    for (const part of parts) {
      acc += `/${part}`;
      crumbs.push({ name: part, path: acc });
    }
    return crumbs;
  }, [path]);

  const navigate = useCallback(
    (target: string) => {
      if (target !== path) void load(target);
    },
    [path, load],
  );

  const download = useCallback(
    async (entry: FileEntry) => {
      const target = joinPath(path, entry.name);
      try {
        const blob = await filesApi.download(serverId, target);
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = entry.name;
        a.click();
        URL.revokeObjectURL(url);
      } catch (err) {
        setError(getApiErrorMessage(err, t.fileManager.downloadFailed));
      }
    },
    [path, serverId, t.fileManager.downloadFailed],
  );

  const openEntry = useCallback(
    (entry: FileEntry) => {
      const target = joinPath(path, entry.name);
      if (entry.type === "directory") {
        navigate(target);
      } else if (entry.type === "symlink") {
        // Symlinks may resolve to a directory or a file; ask the server.
        navigate(target);
      } else if (isTextEditable(entry)) {
        setEditingFile({ entry, path: target });
      } else {
        void download(entry);
      }
    },
    [path, navigate, download],
  );

  const confirmDialog = useCallback(async () => {
    if (!dialog) return;
    setDialogBusy(true);
    setError(null);
    try {
      if (dialog.kind === "newFolder") {
        const name = dialogText.trim();
        if (!name) return;
        await filesApi.mkdir(serverId, joinPath(path, name));
      } else if (dialog.kind === "rename") {
        const name = dialogText.trim();
        if (!name || name === dialog.entry.name) return;
        await filesApi.rename(serverId, joinPath(path, dialog.entry.name), joinPath(path, name));
      } else if (dialog.kind === "delete") {
        const targets = dialog.entries.map((e) => joinPath(path, e.name));
        await filesApi.remove(serverId, targets);
      }
      setDialog(null);
      setDialogText("");
      await load(path);
    } catch (err) {
      setError(getApiErrorMessage(err, t.fileManager.actionFailed));
    } finally {
      setDialogBusy(false);
    }
  }, [dialog, dialogText, serverId, path, load, t.fileManager.actionFailed]);

  const uploadFiles = useCallback(
    async (list: FileList | File[]) => {
      const files = Array.from(list);
      if (files.length === 0) return;
      setError(null);
      setUploads(files.map((f) => ({ name: f.name, size: f.size })));
      const failures: string[] = [];
      for (const file of files) {
        try {
          await filesApi.upload(serverId, path, file);
        } catch (err) {
          failures.push(`${file.name}: ${getApiErrorMessage(err, t.fileManager.uploadFailed)}`);
        }
      }
      setUploads([]);
      if (failures.length > 0) {
        setError(failures.join(" · "));
      }
      await load(path);
    },
    [serverId, path, load, t.fileManager.uploadFailed],
  );

  const toggleSelect = useCallback((name: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }, []);

  const selectedEntries = useMemo(
    () => entries.filter((e) => selected.has(e.name)),
    [entries, selected],
  );

  return (
    <div className="overflow-hidden rounded-2xl border border-border/50 bg-card">
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/50 px-4 py-3">
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            navigate(pathInput.trim() || "/");
          }}
        >
          <UiIcon name="folder-open" className="size-4 shrink-0 text-muted-foreground" />
          <input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            spellCheck={false}
            aria-label={t.fileManager.pathLabel}
            className="min-w-0 flex-1 rounded-lg border border-border/50 bg-background px-3 py-1.5 font-mono text-xs text-foreground outline-none focus:ring-1 focus:ring-ring"
          />
        </form>
        <button
          type="button"
          onClick={() => void load(path)}
          aria-label={t.fileManager.refresh}
          title={t.fileManager.refresh}
          className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground ring-1 ring-border/50 transition-colors hover:bg-muted hover:text-foreground"
        >
          <UiIcon name="refresh" className="size-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setDialog({ kind: "newFolder" });
            setDialogText("");
          }}
          className="inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium text-foreground ring-1 ring-border/50 transition-colors hover:bg-muted"
        >
          <UiIcon name="folder-plus" className="size-3.5" />
          {t.fileManager.newFolder}
        </button>
        <button
          type="button"
          onClick={() => uploadInputRef.current?.click()}
          className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
        >
          <UiIcon name="upload" className="size-3.5" />
          {t.fileManager.upload}
        </button>
        <input
          ref={uploadInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) void uploadFiles(e.target.files);
            e.target.value = "";
          }}
        />
      </div>

      {/* Breadcrumbs */}
      <div className="flex flex-wrap items-center gap-0.5 border-b border-border/50 px-4 py-2 text-xs">
        {breadcrumbs.length > 1 && (
          <button
            type="button"
            onClick={() => navigate(parentOf(path))}
            aria-label={t.fileManager.goUp}
            title={t.fileManager.goUp}
            className="mr-1 inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <UiIcon name="arrow-left" className="size-3.5 rtl:rotate-180" />
          </button>
        )}
        {breadcrumbs.map((crumb, i) => (
          <span key={crumb.path} className="flex items-center gap-0.5">
            {i > 0 && <UiIcon name="chevron-right" className="size-3 text-muted-foreground/50 rtl:rotate-180" />}
            <button
              type="button"
              onClick={() => navigate(crumb.path)}
              className={
                "rounded px-1 py-0.5 font-mono transition-colors hover:bg-muted hover:text-foreground " +
                (i === breadcrumbs.length - 1 ? "font-semibold text-foreground" : "text-muted-foreground")
              }
            >
              {crumb.name}
            </button>
          </span>
        ))}
      </div>

      {/* Error banner */}
      {error && (
        <div className="flex items-center gap-2 border-b border-border/50 bg-destructive/10 px-4 py-2 text-xs text-destructive">
          <UiIcon name="warning" className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <button type="button" onClick={() => setError(null)} aria-label={t.fileManager.close}>
            <UiIcon name="close" className="size-3.5" />
          </button>
        </div>
      )}

      {/* Uploads in flight */}
      {uploads.length > 0 && (
        <div className="flex items-center gap-2 border-b border-border/50 px-4 py-2 text-xs text-muted-foreground">
          <UiIcon name="spinner" className="size-3.5 animate-spin" />
          {interpolate(t.fileManager.uploadingCount, { count: String(uploads.length) })}
        </div>
      )}

      {/* Listing */}
      <div
        className="relative"
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          if (e.dataTransfer.files.length > 0) void uploadFiles(e.dataTransfer.files);
        }}
      >
        {dragging && (
          <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center bg-primary/10 text-sm font-medium text-primary">
            {t.fileManager.dropToUpload}
          </div>
        )}
        {loading ? (
          <div className="flex h-48 items-center justify-center">
            <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
          </div>
        ) : entries.length === 0 ? (
          <div className="flex h-48 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <UiIcon name="folder-open" className="size-6" />
            <p>{t.fileManager.emptyDir}</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/50 text-start text-xs text-muted-foreground">
                <th className="w-8 px-4 py-2" />
                <th className="px-2 py-2 text-start font-medium">{t.fileManager.colName}</th>
                <th className="hidden px-2 py-2 text-start font-medium sm:table-cell">{t.fileManager.colSize}</th>
                <th className="hidden px-2 py-2 text-start font-medium md:table-cell">{t.fileManager.colModified}</th>
                <th className="px-4 py-2 text-end font-medium">{t.fileManager.colActions}</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const isSelected = selected.has(entry.name);
                return (
                  <tr
                    key={entry.name}
                    className={
                      "border-b border-border/30 transition-colors last:border-0 hover:bg-muted/50 " +
                      (isSelected ? "bg-primary/5" : "")
                    }
                  >
                    <td className="px-4 py-2">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(entry.name)}
                        aria-label={interpolate(t.fileManager.selectEntry, { name: entry.name })}
                        className="size-3.5 accent-[var(--primary)]"
                      />
                    </td>
                    <td className="px-2 py-2">
                      <button
                        type="button"
                        onClick={() => openEntry(entry)}
                        className="flex min-w-0 items-center gap-2 text-start"
                      >
                        <UiIcon
                          name={fileIconName(entry) as never}
                          className={
                            "size-4 shrink-0 " +
                            (entry.type === "directory" ? "text-primary" : "text-muted-foreground")
                          }
                        />
                        <span className="truncate text-foreground" title={entry.name}>
                          {entry.name}
                        </span>
                        {entry.type === "symlink" && (
                          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                            {t.fileManager.symlink}
                          </span>
                        )}
                      </button>
                    </td>
                    <td className="hidden px-2 py-2 text-xs text-muted-foreground sm:table-cell">
                      {entry.type === "directory" ? "—" : formatSize(entry.size)}
                    </td>
                    <td className="hidden px-2 py-2 text-xs text-muted-foreground md:table-cell">
                      {entry.mtime > 0
                        ? new Date(entry.mtime).toLocaleString(undefined, {
                            year: "numeric",
                            month: "short",
                            day: "numeric",
                            hour: "2-digit",
                            minute: "2-digit",
                          })
                        : "—"}
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center justify-end gap-1">
                        {entry.type === "file" && (
                          <button
                            type="button"
                            onClick={() => void download(entry)}
                            aria-label={t.fileManager.download}
                            title={t.fileManager.download}
                            className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                          >
                            <UiIcon name="download" className="size-3.5" />
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => {
                            setDialog({ kind: "rename", entry });
                            setDialogText(entry.name);
                          }}
                          aria-label={t.fileManager.rename}
                          title={t.fileManager.rename}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                        >
                          <UiIcon name="edit" className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setDialog({ kind: "delete", entries: [entry] });
                            setDialogText("");
                          }}
                          aria-label={t.fileManager.delete}
                          title={t.fileManager.delete}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
                        >
                          <UiIcon name="trash" className="size-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Selection action bar */}
      {selectedEntries.length > 0 && (
        <div className="flex items-center gap-3 border-t border-border/50 px-4 py-2 text-xs">
          <span className="text-muted-foreground">
            {interpolate(t.fileManager.selectedCount, { count: String(selectedEntries.length) })}
          </span>
          <button
            type="button"
            onClick={() => {
              setDialog({ kind: "delete", entries: selectedEntries });
              setDialogText("");
            }}
            className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 font-medium text-destructive ring-1 ring-destructive/30 transition-colors hover:bg-destructive/10"
          >
            <UiIcon name="trash" className="size-3.5" />
            {t.fileManager.deleteSelected}
          </button>
          <button
            type="button"
            onClick={() => setSelected(new Set())}
            className="text-muted-foreground transition-colors hover:text-foreground"
          >
            {t.fileManager.clearSelection}
          </button>
        </div>
      )}

      {/* Dialogs (new folder / rename / delete confirm) */}
      {dialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
          <div className="w-full max-w-md overflow-hidden rounded-2xl border border-border/50 bg-card shadow-xl">
            <div className="px-5 py-4">
              <h3 className="text-sm font-semibold text-foreground">
                {dialog.kind === "newFolder" && t.fileManager.newFolderTitle}
                {dialog.kind === "rename" && t.fileManager.renameTitle}
                {dialog.kind === "delete" && t.fileManager.deleteTitle}
              </h3>
              {dialog.kind === "delete" ? (
                <p className="mt-2 text-sm text-muted-foreground">
                  {dialog.entries.length === 1
                    ? interpolate(t.fileManager.deleteOneConfirm, { name: dialog.entries[0].name })
                    : interpolate(t.fileManager.deleteManyConfirm, { count: String(dialog.entries.length) })}
                </p>
              ) : (
                <input
                  autoFocus
                  value={dialogText}
                  onChange={(e) => setDialogText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void confirmDialog();
                    if (e.key === "Escape") setDialog(null);
                  }}
                  placeholder={t.fileManager.namePlaceholder}
                  className="mt-3 w-full rounded-lg border border-border/50 bg-background px-3 py-2 font-mono text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
                />
              )}
            </div>
            <div className="flex items-center justify-end gap-2 border-t border-border/50 px-5 py-3">
              <button
                type="button"
                onClick={() => setDialog(null)}
                className="rounded-lg px-4 py-2 text-sm text-foreground transition-colors hover:bg-muted"
              >
                {t.fileManager.cancel}
              </button>
              <button
                type="button"
                onClick={() => void confirmDialog()}
                disabled={dialogBusy || (dialog.kind !== "delete" && dialogText.trim() === "")}
                className={
                  "inline-flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors disabled:cursor-not-allowed disabled:opacity-50 " +
                  (dialog.kind === "delete" ? "bg-destructive hover:bg-destructive/90" : "bg-primary hover:bg-primary/90")
                }
              >
                {dialogBusy && <UiIcon name="spinner" className="size-3.5 animate-spin" />}
                {dialog.kind === "delete" ? t.fileManager.delete : t.fileManager.confirm}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Text editor overlay */}
      {editingFile && (
        <FileEditor
          serverId={serverId}
          file={editingFile.entry}
          path={editingFile.path}
          onClose={() => setEditingFile(null)}
          onSaved={() => void load(path)}
        />
      )}
    </div>
  );
}
