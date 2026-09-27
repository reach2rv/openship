/**
 * Server file-manager API client.
 *
 * JSON endpoints go through the shared wrapper. Upload/download stream
 * raw bytes, so they use fetch directly (the wrapper only returns text/
 * JSON, and uploads must NOT be JSON-stringified). Both attach the same
 * cookie auth + X-Organization-Id header the wrapper sends.
 */

import { api, getApiBaseUrl, getActiveOrganizationId, ApiError } from "./client";
import { endpoints } from "./endpoints";

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  /** Epoch ms */
  mtime: number;
  mode: number;
}

export interface DirectoryListing {
  path: string;
  serverId: string;
  entries: FileEntry[];
}

export interface FileContent {
  serverId: string;
  path: string;
  content: string;
  size: number;
  truncated: boolean;
}

function authHeaders(extra: HeadersInit = {}): Headers {
  const headers = new Headers(extra);
  const orgId = getActiveOrganizationId();
  if (orgId) headers.set("X-Organization-Id", orgId);
  return headers;
}

function fileManagerUrl(path: string, params?: Record<string, string>): string {
  const url = new URL(path, getApiBaseUrl());
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) url.searchParams.set(k, v);
    }
  }
  return url.toString();
}

async function raiseForStatus(res: Response): Promise<Response> {
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    let parsed: unknown = text;
    try {
      parsed = JSON.parse(text);
    } catch {
      /* keep as string */
    }
    throw new ApiError(res.status, res.statusText, parsed);
  }
  return res;
}

export const filesApi = {
  list(serverId: string, path: string): Promise<DirectoryListing> {
    return api.get<DirectoryListing>(endpoints.files.list(serverId), {
      params: { path },
      dedupe: false,
    });
  },

  readText(serverId: string, path: string): Promise<FileContent> {
    return api.get<FileContent>(endpoints.files.content(serverId), {
      params: { path },
      dedupe: false,
      timeout: 30_000,
    });
  },

  /** Save a text file. Body must be raw text — a Blob keeps the wrapper from JSON-stringifying it. */
  async saveText(serverId: string, path: string, content: string): Promise<void> {
    await api.put(
      endpoints.files.content(serverId),
      new Blob([content], { type: "text/plain; charset=utf-8" }),
      { params: { path }, timeout: 30_000 },
    );
  },

  /** Download a file as a Blob (caller triggers the browser save). */
  async download(serverId: string, path: string): Promise<Blob> {
    const res = await raiseForStatus(
      await fetch(fileManagerUrl(endpoints.files.download(serverId), { path }), {
        credentials: "include",
        headers: authHeaders(),
      }),
    );
    return res.blob();
  },

  /** Upload a file into `dir`. Raw body streaming; 2 GB server-side cap. */
  async upload(serverId: string, dir: string, file: File): Promise<{ path: string; size: number }> {
    const res = await raiseForStatus(
      await fetch(fileManagerUrl(endpoints.files.upload(serverId), { path: dir, name: file.name }), {
        method: "POST",
        credentials: "include",
        headers: authHeaders({ "Content-Type": "application/octet-stream" }),
        body: file,
      }),
    );
    return res.json();
  },

  async mkdir(serverId: string, path: string): Promise<void> {
    await api.post(endpoints.files.mkdir(serverId), { path });
  },

  async rename(serverId: string, from: string, to: string): Promise<void> {
    await api.post(endpoints.files.rename(serverId), { from, to });
  },

  async remove(serverId: string, paths: string[]): Promise<void> {
    await api.post(endpoints.files.remove(serverId), { paths });
  },
};
