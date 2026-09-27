/**
 * File-manager HTTP handlers.
 *
 * All paths are absolute on the TARGET server (see file-manager.service.ts
 * for the two backends). Permission gating happens at the router via
 * server:read / server:admin tags; this controller only resolves the
 * org-scoped server row (existence + isLocal routing) and delegates.
 *
 * Mutating routes rely on the router's auto-audit; each handler stamps
 * `auditAfter` with the target path so audit rows name what changed
 * without ever recording file contents.
 */

import type { Context } from "hono";
import { Readable } from "node:stream";
import { posix } from "node:path";
import { repos } from "@repo/db";
import { getRequestContext } from "../../lib/request-context";
import {
  FileManagerError,
  MAX_UPLOAD_BYTES,
  fileManagerOpsFor,
  resolveEntryName,
  resolveRemotePath,
} from "./file-manager.service";

async function opsFor(c: Context, rawServerId: string | undefined) {
  if (!rawServerId) throw new FileManagerError("serverId is required", 400);
  const ctx = getRequestContext(c);
  const server = await repos.server.getInOrganization(rawServerId, ctx.organizationId);
  if (!server) throw new FileManagerError("Server not found", 404);
  return { ops: fileManagerOpsFor(server), serverId: rawServerId };
}

function stampAudit(c: Context, detail: Record<string, unknown>) {
  c.set("auditAfter", detail);
}

function contentDispositionName(name: string): string {
  const safe = name.replace(/[^\w.() \-]/g, "_");
  return `attachment; filename="${safe}"`;
}

export async function list(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const path = resolveRemotePath(c.req.query("path") ?? "/", { required: false });
  const entries = await ops.list(path);
  return c.json({ path, serverId, entries });
}

export async function stat(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const path = resolveRemotePath(c.req.query("path"));
  const info = await ops.stat(path);
  return c.json({ serverId, stat: info });
}

export async function readText(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const path = resolveRemotePath(c.req.query("path"));
  const { content, size, truncated } = await ops.readText(path);
  return c.json({ serverId, path, content, size, truncated });
}

export async function saveText(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const path = resolveRemotePath(c.req.query("path"));
  const content = await c.req.text();
  await ops.writeText(path, content);
  stampAudit(c, { serverId, path, bytes: Buffer.byteLength(content, "utf-8") });
  return c.json({ success: true, serverId, path });
}

export async function download(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const path = resolveRemotePath(c.req.query("path"));
  const { stream, size } = await ops.readStream(path);
  c.req.raw.signal.addEventListener("abort", () => stream.destroy());
  const headers = new Headers({
    "content-type": "application/octet-stream",
    "content-disposition": contentDispositionName(posix.basename(path)),
  });
  if (size !== null) headers.set("content-length", String(size));
  return new Response(Readable.toWeb(stream) as ReadableStream, { headers });
}

export async function upload(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const dir = resolveRemotePath(c.req.query("path") ?? "/", { required: false });
  const name = resolveEntryName(c.req.query("name") ?? c.req.header("x-file-name"));
  const declared = c.req.header("content-length");
  if (declared && Number(declared) > MAX_UPLOAD_BYTES) {
    throw new FileManagerError(`Upload exceeds the ${MAX_UPLOAD_BYTES} byte limit`, 413);
  }
  if (!c.req.raw.body) throw new FileManagerError("Request body is required", 400);
  const { path, size } = await ops.upload(dir, name, c.req.raw.body);
  stampAudit(c, { serverId, path, bytes: size });
  return c.json({ success: true, serverId, path, size });
}

export async function mkdir(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const body = await c.req.json().catch(() => ({}));
  const path = resolveRemotePath(body?.path);
  await ops.mkdir(path);
  stampAudit(c, { serverId, path });
  return c.json({ success: true, serverId, path });
}

export async function rename(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const body = await c.req.json().catch(() => ({}));
  const from = resolveRemotePath(body?.from);
  const to = resolveRemotePath(body?.to);
  await ops.rename(from, to);
  stampAudit(c, { serverId, from, to });
  return c.json({ success: true, serverId, from, to });
}

export async function remove(c: Context) {
  const { serverId, ops } = await opsFor(c, c.req.param("serverId"));
  const body = await c.req.json().catch(() => ({}));
  const paths = Array.isArray(body?.paths) ? body.paths : [];
  if (paths.length === 0) throw new FileManagerError("paths must be a non-empty array", 400);
  const resolved = paths.map((p: unknown) => resolveRemotePath(p));
  for (const path of resolved) {
    await ops.deletePath(path);
  }
  stampAudit(c, { serverId, paths: resolved });
  return c.json({ success: true, serverId, paths: resolved });
}
