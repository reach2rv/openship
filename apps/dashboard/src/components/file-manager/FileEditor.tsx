"use client";

import { Icon as UiIcon } from "@repo/ui/icons";

import { useCallback, useEffect, useRef, useState } from "react";
import { filesApi, type FileEntry } from "@/lib/api/files";
import { getApiErrorMessage } from "@/lib/api";
import { useI18n, interpolate } from "@/components/i18n-provider";

interface FileEditorProps {
  serverId: string;
  file: FileEntry;
  path: string;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * Minimal text-file editor in a modal overlay — a monospace textarea with
 * Save (Ctrl+S / ⌘S). Deliberately dependency-free; a code editor
 * (Monaco/CodeMirror) can replace the textarea later without touching
 * the data flow.
 */
export function FileEditor({ serverId, file, path, onClose, onSaved }: FileEditorProps) {
  const { t } = useI18n();
  const [content, setContent] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [binary, setBinary] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    filesApi
      .readText(serverId, path)
      .then((res) => {
        if (cancelled) return;
        // Null bytes mean the file isn't text — editing would corrupt it.
        if (res.content.includes("\u0000")) {
          setBinary(true);
          setContent(null);
          return;
        }
        setContent(res.content);
        setDirty(false);
      })
      .catch((err) => {
        if (!cancelled) setError(getApiErrorMessage(err, t.fileManager.editorLoadFailed));
      });
    return () => {
      cancelled = true;
    };
  }, [serverId, path, t.fileManager.editorLoadFailed]);

  const save = useCallback(async () => {
    if (content === null || saving) return;
    setSaving(true);
    setError(null);
    try {
      await filesApi.saveText(serverId, path, content);
      setDirty(false);
      onSaved();
    } catch (err) {
      setError(getApiErrorMessage(err, t.fileManager.editorSaveFailed));
    } finally {
      setSaving(false);
    }
  }, [content, saving, serverId, path, onSaved, t.fileManager.editorSaveFailed]);

  // Ctrl+S / ⌘S saves while the editor is open.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
      <div className="flex h-full max-h-[85vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-border/50 bg-card shadow-xl">
        {/* Header */}
        <div className="flex items-center gap-3 border-b border-border/50 px-5 py-3">
          <UiIcon name="file-text" className="size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold text-foreground" title={path}>
              {file.name}
            </h3>
            <p className="truncate text-xs text-muted-foreground">{path}</p>
          </div>
          {dirty && (
            <span className="shrink-0 rounded-full bg-warning/10 px-2 py-0.5 text-[11px] font-medium text-warning">
              {t.fileManager.unsaved}
            </span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={content === null || !dirty || saving || binary}
            className="inline-flex shrink-0 items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {saving ? <UiIcon name="spinner" className="size-3.5 animate-spin" /> : <UiIcon name="save" className="size-3.5" />}
            {t.fileManager.save}
          </button>
          <button
            type="button"
            onClick={onClose}
            aria-label={t.fileManager.close}
            className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <UiIcon name="close" className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="min-h-0 flex-1 p-4">
          {error ? (
            <div className="flex h-full items-center justify-center text-sm text-destructive">{error}</div>
          ) : binary ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
              <UiIcon name="file-warning" className="size-6" />
              <p>{t.fileManager.binaryFile}</p>
            </div>
          ) : content === null ? (
            <div className="flex h-full items-center justify-center">
              <UiIcon name="spinner" className="size-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <textarea
              ref={textareaRef}
              value={content}
              spellCheck={false}
              onChange={(e) => {
                setContent(e.target.value);
                setDirty(true);
              }}
              className="h-full w-full resize-none rounded-xl border border-border/50 bg-background p-4 font-mono text-[13px] leading-relaxed text-foreground outline-none focus:ring-1 focus:ring-ring"
            />
          )}
        </div>

        {/* Footer hint */}
        <div className="border-t border-border/50 px-5 py-2 text-xs text-muted-foreground">
          {interpolate(t.fileManager.saveHint, { size: `${(file.size / 1024).toFixed(1)} KB` })}
        </div>
      </div>
    </div>
  );
}
