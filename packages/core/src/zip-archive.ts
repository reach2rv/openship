/**
 * Minimal ZIP reader (local-file headers + stored/deflate entries).
 * Used to accept Visual Studio / `dotnet publish` zip uploads without a
 * third-party zip library. Zip-Slip names are rejected by the caller.
 */

export function isZipBuffer(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

export function isGzipBuffer(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

export type ZipListedEntry = {
  name: string;
  directory: boolean;
  compression: number;
  compressed: Uint8Array;
  uncompressedSize: number;
};

function u16(view: DataView, offset: number): number {
  return view.getUint16(offset, true);
}

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true);
}

const decoder = new TextDecoder("utf-8");

/**
 * Walk local file headers. Data-descriptor zips (bit 3) are refused — publish
 * zips write sizes in the local header.
 */
export function listZipEntries(bytes: Uint8Array): ZipListedEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ZipListedEntry[] = [];
  let offset = 0;

  while (offset + 30 <= bytes.length) {
    const sig = u32(view, offset);
    if (sig === 0x02014b50 || sig === 0x06054b50) break; // central dir / EOCD
    if (sig !== 0x04034b50) {
      throw new Error("Rejected upload: zip is truncated or not a zip archive");
    }

    const flags = u16(view, offset + 6);
    const compression = u16(view, offset + 8);
    const compressedSize = u32(view, offset + 18);
    const uncompressedSize = u32(view, offset + 22);
    const nameLen = u16(view, offset + 26);
    const extraLen = u16(view, offset + 28);
    if (flags & 0x8) {
      throw new Error("Rejected upload: zip uses data descriptors Openship does not read");
    }

    const nameStart = offset + 30;
    const nameEnd = nameStart + nameLen;
    const dataStart = nameEnd + extraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > bytes.length) {
      throw new Error("Rejected upload: zip entry is truncated");
    }

    const name = decoder.decode(bytes.subarray(nameStart, nameEnd)).replace(/\\/g, "/");
    const directory = name.endsWith("/");
    out.push({
      name,
      directory,
      compression,
      compressed: bytes.subarray(dataStart, dataEnd),
      uncompressedSize,
    });
    offset = dataEnd;
  }

  return out;
}

export function assertSafeZipPath(name: string): void {
  const entry = name.trim();
  if (!entry || entry === "/") return;
  if (entry.startsWith("/") || entry.startsWith("~") || /^[A-Za-z]:/.test(entry)) {
    throw new Error("Rejected upload: archive contains an absolute path");
  }
  if (entry.split("/").some((seg) => seg === "..")) {
    throw new Error("Rejected upload: archive contains a path-traversal entry");
  }
}

export async function inflateZipEntries(
  entries: ZipListedEntry[],
  inflateRaw: (src: Uint8Array) => Uint8Array | Promise<Uint8Array>,
): Promise<{ name: string; data: Uint8Array }[]> {
  const files: { name: string; data: Uint8Array }[] = [];
  for (const entry of entries) {
    assertSafeZipPath(entry.name);
    if (entry.directory || !entry.name) continue;
    if (entry.compression === 0) {
      files.push({ name: entry.name, data: entry.compressed });
      continue;
    }
    if (entry.compression !== 8) {
      throw new Error(`Rejected upload: zip compression method ${entry.compression} is not supported`);
    }
    const data = await inflateRaw(entry.compressed);
    files.push({ name: entry.name, data });
  }
  return files;
}
