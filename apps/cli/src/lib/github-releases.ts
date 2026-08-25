/**
 * Shared helpers for pulling release assets from the openship GitHub releases —
 * used by `openship install` (desktop app) and `openship up` (dashboard bundle).
 * All assets are published by .github/workflows/release.yml with a `.sha256`
 * sidecar; callers verify downloads against it.
 */
import { GITHUB_REPO } from "@repo/core";
import { parseSha256 } from "./cache";

export const REPO = GITHUB_REPO;
export const RELEASES = `https://github.com/${REPO}/releases`;
const LATEST_API = `https://api.github.com/repos/${REPO}/releases/latest`;

/** Resolve the newest published release tag (e.g. "v0.1.9"). */
export async function resolveLatestTag(): Promise<string> {
  const res = await fetch(LATEST_API, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "openship-cli" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`GitHub latest-release lookup failed: HTTP ${res.status}`);
  const data = (await res.json()) as { tag_name?: string };
  if (!data.tag_name) throw new Error("Latest release has no tag_name");
  return data.tag_name;
}

/** URL of a release asset for a tag. */
export function assetUrl(tag: string, name: string): string {
  return `${RELEASES}/download/${tag}/${name}`;
}

/** Fetch a `.sha256` sidecar body, or null on 404 (asset published without one). */
export async function fetchSidecar(url: string): Promise<string | null> {
  const res = await fetch(url, {
    headers: { "User-Agent": "openship-cli" },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Sidecar fetch failed: HTTP ${res.status}`);
  return res.text();
}

/** Expected sha256 for an asset from its sidecar, or null if none is published. */
export async function expectedSha256(tag: string, name: string): Promise<string | null> {
  const body = await fetchSidecar(`${assetUrl(tag, name)}.sha256`);
  return body ? parseSha256(body) : null;
}
