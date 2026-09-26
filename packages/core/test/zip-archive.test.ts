import { describe, expect, it } from "vitest";
import { deflateRawSync, inflateRawSync } from "node:zlib";
import {
  assertSafeZipPath,
  inflateZipEntries,
  isGzipBuffer,
  isZipBuffer,
  listZipEntries,
} from "../src/zip-archive";

function storeZip(name: string, payload: Uint8Array): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const header = new Uint8Array(30 + nameBytes.length + payload.length);
  const view = new DataView(header.buffer);
  view.setUint32(0, 0x04034b50, true);
  view.setUint16(8, 0, true); // stored
  view.setUint32(18, payload.length, true);
  view.setUint32(22, payload.length, true);
  view.setUint16(26, nameBytes.length, true);
  header.set(nameBytes, 30);
  header.set(payload, 30 + nameBytes.length);
  return header;
}

describe("zip-archive", () => {
  it("detects zip vs gzip magic", () => {
    expect(isZipBuffer(new Uint8Array([0x50, 0x4b, 0x03, 0x04]))).toBe(true);
    expect(isGzipBuffer(new Uint8Array([0x1f, 0x8b, 0x08]))).toBe(true);
    expect(isZipBuffer(new Uint8Array([0x1f, 0x8b]))).toBe(false);
  });

  it("lists a stored entry", () => {
    const payload = new TextEncoder().encode("hello");
    const zip = storeZip("HelloApi.dll", payload);
    const entries = listZipEntries(zip);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.name).toBe("HelloApi.dll");
    expect(entries[0]!.compression).toBe(0);
  });

  it("inflates a deflated entry", async () => {
    const payload = new TextEncoder().encode("published");
    const compressed = deflateRawSync(payload);
    const nameBytes = new TextEncoder().encode("app.dll");
    const header = new Uint8Array(30 + nameBytes.length + compressed.length);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(8, 8, true);
    view.setUint32(18, compressed.length, true);
    view.setUint32(22, payload.length, true);
    view.setUint16(26, nameBytes.length, true);
    header.set(nameBytes, 30);
    header.set(compressed, 30 + nameBytes.length);

    const files = await inflateZipEntries(listZipEntries(header), (src) => inflateRawSync(src));
    expect(new TextDecoder().decode(files[0]!.data)).toBe("published");
  });

  it("rejects zip-slip names", () => {
    expect(() => assertSafeZipPath("../evil.dll")).toThrow(/path-traversal/);
    expect(() => assertSafeZipPath("/tmp/x")).toThrow(/absolute/);
  });
});
