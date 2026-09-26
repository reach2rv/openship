import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { extractUploadedArchive, unwrapSingleRoot } from "../../../src/modules/projects/folder/folder.service";

function storeZip(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length + payload.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint32(18, payload.length, true);
  view.setUint32(22, payload.length, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  header.set(payload, 30 + nameBytes.length);
  return header;
}

describe("extractUploadedArchive", () => {
  it("extracts a zip and unwraps a single root folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-zip-"));
    const zipPath = join(dir, "app.zip");
    try {
      await writeFile(zipPath, storeZip("publish/HelloApi.dll", new TextEncoder().encode("dll")));
      const dest = join(dir, "dest");
      await mkdir(dest, { recursive: true });
      await extractUploadedArchive(zipPath, dest);
      await unwrapSingleRoot(dest);
      expect(await readFile(join(dest, "HelloApi.dll"), "utf8")).toBe("dll");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects zip-slip entries before writing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "openship-slip-"));
    const zipPath = join(dir, "evil.zip");
    try {
      await writeFile(zipPath, storeZip("../evil.dll", new TextEncoder().encode("nope")));
      await expect(extractUploadedArchive(zipPath, join(dir, "dest"))).rejects.toThrow(/path-traversal/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
