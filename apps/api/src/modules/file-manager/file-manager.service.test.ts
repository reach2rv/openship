import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileManagerError,
  localFileManagerOps,
  resolveEntryName,
  resolveRemotePath,
} from "./file-manager.service";

describe("resolveRemotePath", () => {
  it("normalizes redundant segments and collapses traversal", () => {
    expect(resolveRemotePath("/opt/openship/./releases")).toBe("/opt/openship/releases");
    expect(resolveRemotePath("/opt/x/../y")).toBe("/opt/y");
    expect(resolveRemotePath("/opt//y///")).toBe("/opt/y");
  });

  it("keeps the root as /", () => {
    expect(resolveRemotePath("/")).toBe("/");
    expect(resolveRemotePath("/", { required: false })).toBe("/");
    expect(resolveRemotePath(undefined, { required: false })).toBe("/");
  });

  it("rejects relative paths, null bytes, and empty values", () => {
    expect(() => resolveRemotePath("opt/openship")).toThrow(FileManagerError);
    expect(() => resolveRemotePath("/a\0/b")).toThrow(/null byte/);
    expect(() => resolveRemotePath("")).toThrow(FileManagerError);
    expect(() => resolveRemotePath(null)).toThrow(FileManagerError);
  });
});

describe("resolveEntryName", () => {
  it("accepts plain names", () => {
    expect(resolveEntryName("app.conf")).toBe("app.conf");
    expect(resolveEntryName("my folder")).toBe("my folder");
  });

  it("rejects separators, dot segments, and empty values", () => {
    expect(() => resolveEntryName("a/b")).toThrow(FileManagerError);
    expect(() => resolveEntryName("a\\b")).toThrow(FileManagerError);
    expect(() => resolveEntryName("..")).toThrow(FileManagerError);
    expect(() => resolveEntryName(".")).toThrow(FileManagerError);
    expect(() => resolveEntryName("")).toThrow(FileManagerError);
    expect(() => resolveEntryName(undefined)).toThrow(FileManagerError);
    expect(() => resolveEntryName("a\0b")).toThrow(FileManagerError);
  });
});

describe("localFileManagerOps", () => {
  let root: string;
  let ops: ReturnType<typeof localFileManagerOps>;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "fm-test-"));
    ops = localFileManagerOps();
    await mkdir(join(root, "sub"));
    await writeFile(join(root, "hello.txt"), "hello world", "utf-8");
    await writeFile(join(root, "sub", "nested.txt"), "nested", "utf-8");
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("lists directories first with sizes and mtimes", async () => {
    const entries = await ops.list(root);
    expect(entries.map((e) => e.name)).toEqual(["sub", "hello.txt"]);
    const dir = entries[0];
    expect(dir.type).toBe("directory");
    const file = entries[1];
    expect(file.type).toBe("file");
    expect(file.size).toBe(11);
    expect(file.mtime).toBeGreaterThan(0);
  });

  it("stats a file", async () => {
    const st = await ops.stat(join(root, "hello.txt"));
    expect(st.type).toBe("file");
    expect(st.size).toBe(11);
    expect(st.path).toBe(join(root, "hello.txt"));
  });

  it("round-trips text through readText/writeText", async () => {
    const target = join(root, "written.txt");
    await ops.writeText(target, "line1\nline2");
    const { content, size, truncated } = await ops.readText(target);
    expect(content).toBe("line1\nline2");
    expect(size).toBe(11);
    expect(truncated).toBe(false);
  });

  it("refuses to edit files over the size cap", async () => {
    const big = join(root, "big.bin");
    await writeFile(big, Buffer.alloc(6 * 1024 * 1024));
    await expect(ops.readText(big)).rejects.toMatchObject({ status: 413 });
  });

  it("uploads a stream atomically", async () => {
    const { Readable } = await import("node:stream");
    const web = Readable.toWeb(
      Readable.from([Buffer.from("upload-"), Buffer.from("payload")]),
    ) as unknown as import("node:stream/web").ReadableStream<Uint8Array>;
    const { path, size } = await ops.upload(root, "uploaded.txt", web);
    expect(path.replace(/\\/g, "/")).toBe(join(root, "uploaded.txt").replace(/\\/g, "/"));
    expect(size).toBe(14);
    expect(await readFile(path, "utf-8")).toBe("upload-payload");
    // No temp siblings left behind.
    const leftovers = (await ops.list(root)).filter((e) => e.name.includes(".fm-part-"));
    expect(leftovers).toEqual([]);
  });

  it("creates directories recursively and renames", async () => {
    await ops.mkdir(join(root, "a/b/c"));
    await ops.writeText(join(root, "a/b/c/f.txt"), "x");
    await ops.rename(join(root, "a/b/c/f.txt"), join(root, "a/b/renamed.txt"));
    await expect(readFile(join(root, "a/b/renamed.txt"), "utf-8")).resolves.toBe("x");
  });

  it("deletes recursively", async () => {
    await ops.deletePath(join(root, "a"));
    await expect(ops.list(join(root, "a"))).rejects.toMatchObject({ status: 404 });
  });

  it("refuses to delete the filesystem root", async () => {
    await expect(ops.deletePath("/")).rejects.toMatchObject({ status: 400 });
  });

  it("maps ENOENT to 404 and surfaces it consistently", async () => {
    await expect(ops.stat(join(root, "missing.txt"))).rejects.toMatchObject({ status: 404 });
    await expect(ops.list(join(root, "missing-dir"))).rejects.toMatchObject({ status: 404 });
  });
});
