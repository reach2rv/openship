import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../config/env", () => ({
  env: { CLOUD_MODE: false, AZURE_CLIENT_ID: "id", AZURE_CLIENT_SECRET: "secret" },
}));
vi.mock("../../lib/auth", () => ({
  auth: { api: { getAccessToken: vi.fn() } },
}));
vi.mock("@repo/db", () => ({
  repos: { instanceSettings: { get: vi.fn(), upsert: vi.fn() } },
}));
vi.mock("../../lib/encryption", () => ({
  encrypt: (value: string) => value,
  decrypt: (value: string) => value,
}));

import { azureRequest } from "./azure.auth";

describe("azureRequest", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats HTTP 203 as a failed PAT (Azure sign-in HTML, not JSON)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("<html>sign in</html>", { status: 203, headers: { "content-type": "text/html" } }),
      ),
    );

    await expect(
      azureRequest("https://app.vssps.visualstudio.com/_apis/profile/profiles/me", "org-scoped-pat"),
    ).rejects.toThrow(/authentication failed \(203\)/);
  });

  it("sends Basic auth for opaque PATs and Bearer for Entra JWTs", async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await azureRequest("https://dev.azure.com/acme/_apis/projects", "not-a-jwt");
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toMatch(/^Basic /);

    await azureRequest(
      "https://dev.azure.com/acme/_apis/projects",
      "aaa.bbb.ccc",
    );
    expect(fetchMock.mock.calls[1][1].headers.Authorization).toBe("Bearer aaa.bbb.ccc");
  });
});
