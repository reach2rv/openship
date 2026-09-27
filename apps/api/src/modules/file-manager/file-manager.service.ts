/**
 * File-manager operations layer.
 *
 * Two backends behind one interface:
 *  - local servers (`servers.is_local`) → node:fs/promises on the control
 *    plane itself (the server row IS this machine);
 *  - remote servers → SFTP over the pooled SSH executor from sshManager.
 *
 * Paths are absolute POSIX paths on the TARGET server. The path guard
 * exists to reject malformed/traversal input early — not to chroot: a
 * user granted server admin already has full shell access via the
 * terminal, so whole-filesystem browsing is the intended trust level.
 */

import { posix } from "node:path";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { SFTPWrapper } from "ssh2";
import type { Server } from "@repo/db";
import { AppError } from "@repo/core";
import { sshManager } from "@repo/platform/engine/lib/ssh-manager";
import * as fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";

export class FileManagerError extends AppError {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message, status, "FILE_MANAGER_ERROR");
    this.name = "FileManagerError";
  }
}

/** Size cap for text files opened in the editor. */
export const MAX_EDIT_BYTES = 5 * 1024 * 1024;
/** Size cap for a single upload request. */
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024;

export interface FileEntry {
  name: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  /** Epoch ms */
  mtime: number;
  mode: number;
}

export interface FileStatInfo extends FileEntry {
  path: string;
}

/**
 * Reject malformed paths and collapse traversal before it reaches a
 * backend. Returns the normalized absolute path. Unlike a chroot this
 * does NOT restrict how far up the tree an admin may go — it guarantees
 * the path stays syntactically where the caller put it.
 */
export function resolveRemotePath(input: unknown, { required = true } = {}): string {
  if (input === undefined || input === null || input === "") {
    if (required) throw new FileManagerError("path is required", 400);
    return "/";
  }
  if (typeof input !== "string") throw new FileManagerError("path must be a string", 400);
  if (input.includes("\0")) throw new FileManagerError("path contains a null byte", 400);
  if (!input.startsWith("/")) throw new FileManagerError("path must be absolute", 400);
  const normalized = posix.normalize(input);
  if (normalized.split("/").includes("..")) {
    throw new FileManagerError("path must not traverse outside itself", 400);
  }
  return normalized.length > 1 ? normalized.replace(/\/+$/, "") : "/";
}

/** Validate a bare file/directory name (no separators) for mkdir/upload/rename targets. */
export function resolveEntryName(input: unknown): string {
  if (typeof input !== "string" || input.trim() === "" || input === "." || input === "..") {
    throw new FileManagerError("a valid name is required", 400);
  }
  if (input.includes("/") || input.includes("\\") || input.includes("\0")) {
    throw new FileManagerError("name must not contain path separators", 400);
  }
  return input;
}

function fileKindFromMode(mode: number): FileEntry["type"] {
  switch (mode & 0o170000) {
    case 0o040000:
      return "directory";
    case 0o120000:
      return "symlink";
    case 0o100000:
      return "file";
    default:
      return "other";
  }
}

function entry(name: string, type: FileEntry["type"], size: number, mtime: number, mode: number): FileEntry {
  return { name, type, size, mtime, mode };
}

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries.sort((a, b) => {
    if (a.type === "directory" && b.type !== "directory") return -1;
    if (b.type === "directory" && a.type !== "directory") return 1;
    return a.name.localeCompare(b.name);
  });
}

/** Map backend errors onto HTTP statuses. */
function toFileManagerError(err: unknown, path: string): unknown {
  const code = (err as { code?: string })?.code ?? "";
  if (code === "ENOENT" || code === "ENOTDIR") {
    return new FileManagerError(`No such file or directory: ${path}`, 404);
  }
  if (code === "EACCES" || code === "EPERM") {
    return new FileManagerError(`Permission denied: ${path}`, 403);
  }
  if (code === "EISDIR") {
    return new FileManagerError(`Is a directory: ${path}`, 400);
  }
  if (code === "ENOTEMPTY") {
    return new FileManagerError(`Directory not empty: ${path}`, 400);
  }
  if (code === "EEXIST") {
    return new FileManagerError(`Already exists: ${path}`, 409);
  }
  return err;
}

async function run<T>(path: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toFileManagerError(err, path);
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface FileManagerOps {
  list(path: string): Promise<FileEntry[]>;
  stat(path: string): Promise<FileStatInfo>;
  /** Bounded text read for the editor. Throws FileManagerError(413) past MAX_EDIT_BYTES. */
  readText(path: string): Promise<{ content: string; truncated: boolean; size: number }>;
  /** Raw file byte stream for download. Caller owns destroying it. */
  readStream(path: string): Promise<{ stream: Readable; size: number | null }>;
  writeText(path: string, content: string): Promise<void>;
  /** Stream an uploaded body into dir/name atomically (write to a temp sibling, then rename). */
  upload(dir: string, name: string, body: WebReadableStream): Promise<{ path: string; size: number }>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  deletePath(path: string): Promise<void>;
}

/* ------------------------------------------------------------------ */
/*  Local backend (servers.is_local)                                   */
/* ------------------------------------------------------------------ */

export function localFileManagerOps(): FileManagerOps {
  return {
    async list(path) {
      const dirents = await run(path, () => fs.readdir(path, { withFileTypes: true }));
      const entries = await Promise.all(
        dirents.map(async (d) => {
          const full = posix.join(path, d.name);
          try {
            const st = await fs.lstat(full);
            return entry(d.name, fileKindFromMode(st.mode), st.size, st.mtimeMs, st.mode);
          } catch {
            return entry(d.name, "other", 0, 0, 0);
          }
        }),
      );
      return sortEntries(entries);
    },

    async stat(path) {
      const st = await run(path, () => fs.stat(path));
      return {
        path,
        name: posix.basename(path),
        type: fileKindFromMode(st.mode),
        size: st.size,
        mtime: st.mtimeMs,
        mode: st.mode,
      };
    },

    async readText(path) {
      const st = await run(path, () => fs.stat(path));
      if (st.isDirectory()) throw new FileManagerError(`Is a directory: ${path}`, 400);
      const size = st.size;
      if (size > MAX_EDIT_BYTES) {
        throw new FileManagerError(`File is too large to edit (${size} bytes)`, 413);
      }
      const content = await run(path, () => fs.readFile(path, "utf-8"));
      return { content, truncated: false, size };
    },

    async readStream(path) {
      const st = await run(path, () => fs.stat(path));
      if (st.isDirectory()) throw new FileManagerError(`Is a directory: ${path}`, 400);
      return { stream: createReadStream(path), size: st.size };
    },

    async writeText(path, content) {
      await run(path, () => fs.writeFile(path, content, "utf-8"));
    },

    async upload(dir, name, body) {
      const target = posix.join(dir, name);
      const tmp = posix.join(dir, `.${name}.fm-part-${randomBytes(4).toString("hex")}`);
      let size = 0;
      const ws = createWriteStream(tmp);
      try {
        await run(target, async () => {
          const nodeStream = Readable.fromWeb(body);
          nodeStream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
              nodeStream.destroy(new FileManagerError(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`, 413));
            }
          });
          await new Promise<void>((resolve, reject) => {
            nodeStream.pipe(ws).on("finish", () => resolve()).on("error", reject);
          });
        });
        await run(target, () => fs.rename(tmp, target));
      } catch (err) {
        await fs.rm(tmp, { force: true }).catch(() => {});
        ws.destroy();
        throw err;
      }
      return { path: target, size };
    },

    async mkdir(path) {
      await run(path, () => fs.mkdir(path, { recursive: true }));
    },

    async rename(from, to) {
      await run(from, () => fs.rename(from, to));
    },

    async deletePath(path) {
      if (path === "/") throw new FileManagerError("Refusing to delete the filesystem root", 400);
      await run(path, () => fs.rm(path, { recursive: true }));
    },
  };
}

/* ------------------------------------------------------------------ */
/*  Remote backend (SFTP over pooled SSH executor)                     */
/* ------------------------------------------------------------------ */

function sftpKind(attrs: { mode: number }): FileEntry["type"] {
  return fileKindFromMode(attrs.mode);
}

export function remoteFileManagerOps(serverId: string): FileManagerOps {
  async function withSftp<T>(fn: (sftp: SFTPWrapper) => Promise<T>): Promise<T> {
    return sshManager.withExecutor(serverId, async (executor) => {
      const anyExec = executor as unknown as {
        withSftp?: (fn: (sftp: SFTPWrapper) => Promise<unknown>) => Promise<unknown>;
      };
      if (typeof anyExec.withSftp === "function") {
        return anyExec.withSftp(fn) as Promise<T>;
      }
      throw new FileManagerError("Executor does not expose an SFTP channel", 500);
    });
  }

  return {
    async list(path) {
      const raw = await run(path, () =>
        withSftp((sftp) =>
          new Promise<Array<{ name: string; attrs: { mode: number; size: number; mtime: number } }>>(
            (resolve, reject) => {
              sftp.readdir(path, (err, list) => (err ? reject(err) : resolve(list as never)));
            },
          ),
        ),
      );
      return sortEntries(
        raw.map((e) =>
          entry(e.name, sftpKind(e.attrs), e.attrs.size, e.attrs.mtime * 1000, e.attrs.mode),
        ),
      );
    },

    async stat(path) {
      const attrs = await run(path, () =>
        withSftp(
          (sftp) =>
            new Promise<{ mode: number; size: number; mtime: number }>((resolve, reject) => {
              sftp.stat(path, (err, st) =>
                err ? reject(err) : resolve({ mode: st.mode, size: st.size, mtime: st.mtime }),
              );
            }),
        ),
      );
      return {
        path,
        name: posix.basename(path),
        type: sftpKind(attrs),
        size: attrs.size,
        mtime: attrs.mtime * 1000,
        mode: attrs.mode,
      };
    },

    async readText(path) {
      return withSftp(async (sftp) => {
        const size = await run(
          path,
          () =>
            new Promise<number>((resolve, reject) => {
              sftp.stat(path, (err, st) => (err ? reject(err) : resolve(st.size)));
            }),
        );
        if (size > MAX_EDIT_BYTES) {
          throw new FileManagerError(`File is too large to edit (${size} bytes)`, 413);
        }
        const content = await run(
          path,
          () =>
            new Promise<string>((resolve, reject) => {
              sftp.readFile(path, { encoding: "utf-8" }, (err, data) =>
                err ? reject(err) : resolve(data.toString("utf-8")),
              );
            }),
        );
        return { content, truncated: false, size };
      });
    },

    async readStream(path) {
      const st = await this.stat(path);
      if (st.type === "directory") throw new FileManagerError(`Is a directory: ${path}`, 400);
      const stream = await withSftp((sftp) => {
        const rs = sftp.createReadStream(path);
        return Promise.resolve(rs);
      });
      return { stream, size: st.size };
    },

    async writeText(path, content) {
      await run(path, () =>
        withSftp(
          (sftp) =>
            new Promise<void>((resolve, reject) => {
              sftp.writeFile(path, content, { encoding: "utf-8" }, (err) =>
                err ? reject(err) : resolve(),
              );
            }),
        ),
      );
    },

    async upload(dir, name, body) {
      const target = posix.join(dir, name);
      const tmp = posix.join(dir, `.${name}.fm-part-${randomBytes(4).toString("hex")}`);
      let size = 0;
      await run(target, () =>
        withSftp(async (sftp) => {
          const ws = sftp.createWriteStream(tmp);
          const nodeStream = Readable.fromWeb(body);
          nodeStream.on("data", (chunk: Buffer) => {
            size += chunk.length;
            if (size > MAX_UPLOAD_BYTES) {
              nodeStream.destroy(new FileManagerError(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`, 413));
            }
          });
          await new Promise<void>((resolve, reject) => {
            ws.on("close", () => resolve());
            ws.on("error", reject);
            nodeStream.pipe(ws);
            nodeStream.on("error", reject);
          });
          await new Promise<void>((resolve, reject) => {
            sftp.rename(tmp, target, (err) => (err ? reject(err) : resolve()));
          });
        }),
      ).catch(async (err) => {
        await withSftp(
          (sftp) =>
            new Promise<void>((resolve) => {
              sftp.unlink(tmp, () => resolve());
            }),
        ).catch(() => {});
        throw err;
      });
      return { path: target, size };
    },

    async mkdir(path) {
      // SFTP mkdir is single-level; recursive mkdir via shell matches SshExecutor's own pattern.
      await sshManager.withExecutor(serverId, (executor) => executor.exec(`mkdir -p -- ${shellQuote(path)}`));
    },

    async rename(from, to) {
      // `mv` over exec (rather than sftp.rename) survives cross-device moves.
      await sshManager.withExecutor(serverId, (executor) =>
        executor.exec(`mv -- ${shellQuote(from)} ${shellQuote(to)}`),
      );
    },

    async deletePath(path) {
      if (path === "/") throw new FileManagerError("Refusing to delete the filesystem root", 400);
      await sshManager.withExecutor(serverId, (executor) =>
        executor.exec(`rm -rf -- ${shellQuote(path)}`),
      );
    },
  };
}

/** Build the ops backend for a server row. */
export function fileManagerOpsFor(server: Pick<Server, "id" | "isLocal">): FileManagerOps {
  return server.isLocal ? localFileManagerOps() : remoteFileManagerOps(server.id);
}
