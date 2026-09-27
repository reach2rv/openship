import { Hono } from "hono";
import { Type } from "@sinclair/typebox";
import { secureRouter } from "../../lib/secure-router";
import * as ctrl from "./file-manager.controller";

/**
 * Self-hosted server file manager (aaPanel-style browse/edit/upload) over
 * the control plane's pooled SSH/SFTP connections. localOnly like the
 * terminal: in cloud mode every route 404s.
 *
 * Permission model: full-filesystem browsing is an administrative
 * capability (parity with the terminal tab — arbitrary file write is
 * arbitrary code execution), so reads use `server:read` and every
 * mutation uses `server:admin`.
 */
const r = secureRouter(new Hono(), {
  module: "file-manager",
  basePath: "/api/file-manager",
  localOnly: true,
  ids: { server: "serverId" },
  mcpExcluded:
    "Self-hosted browser file manager over SFTP. Use the exec tool for bounded remote file operations over MCP.",
});

const PathQuery = Type.Object({ path: Type.Optional(Type.String()) });
const UploadQuery = Type.Object({
  path: Type.Optional(Type.String()),
  name: Type.Optional(Type.String()),
});
const MkdirBody = Type.Object({ path: Type.String() });
const RenameBody = Type.Object({ from: Type.String(), to: Type.String() });
const DeleteBody = Type.Object({ paths: Type.Array(Type.String(), { minItems: 1 }) });

r.get("/:serverId", { tag: "server:read", query: PathQuery }, ctrl.list);
r.get("/:serverId/stat", { tag: "server:read", query: PathQuery }, ctrl.stat);
r.get("/:serverId/content", { tag: "server:read", query: PathQuery }, ctrl.readText);
r.put("/:serverId/content", { tag: "server:admin", query: PathQuery }, ctrl.saveText);
r.get("/:serverId/download", { tag: "server:read", query: PathQuery }, ctrl.download);
r.post("/:serverId/upload", { tag: "server:admin", query: UploadQuery }, ctrl.upload);
r.post("/:serverId/mkdir", { tag: "server:admin", body: MkdirBody }, ctrl.mkdir);
r.post("/:serverId/rename", { tag: "server:admin", body: RenameBody }, ctrl.rename);
r.post("/:serverId/delete", { tag: "server:admin", body: DeleteBody }, ctrl.remove);

export const fileManagerRoutes = r.hono;
