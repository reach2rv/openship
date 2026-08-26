import { describe, expect, it } from "vitest";

import { assetUrl, RELEASES, REPO } from "../../src/lib/github-releases";

describe("github-releases constants", () => {
  it("points at this fork's GitHub releases page", () => {
    expect(REPO).toBe("reach2rv/openship");
    expect(RELEASES).toBe("https://github.com/reach2rv/openship/releases");
  });
});

describe("assetUrl", () => {
  it("builds a release download URL from a tag + asset name", () => {
    expect(assetUrl("v1.2.3", "Openship-arm64.dmg")).toBe(
      "https://github.com/reach2rv/openship/releases/download/v1.2.3/Openship-arm64.dmg",
    );
  });
});
