import { beforeEach, describe, expect, it, vi } from "vitest";

const { azureFetch, azureRequest, getUserToken, getInstancePatOrg } = vi.hoisted(() => ({
  azureFetch: vi.fn(),
  azureRequest: vi.fn(),
  getUserToken: vi.fn(),
  getInstancePatOrg: vi.fn(),
}));

vi.mock("./azure.auth", () => ({
  azureFetch,
  azureRequest,
  getUserToken,
  getInstancePatOrg,
}));

vi.mock("../../lib/encryption", () => ({ encrypt: (value: string) => value }));
vi.mock("../../lib/public-url", () => ({ sharedAzureWebhookUrl: () => "https://example.test/hooks" }));
vi.mock("@repo/db", () => ({ repos: { project: { update: vi.fn() } } }));

import {
  listOrganizations,
  normalizeAzureOrganization,
  verifyPatCanReadOrganization,
} from "./azure.service";

const ctx = { userId: "user-1" } as any;

describe("normalizeAzureOrganization", () => {
  it("accepts a slug and strips a pasted Azure URL", () => {
    expect(normalizeAzureOrganization("acme")).toBe("acme");
    expect(normalizeAzureOrganization("https://dev.azure.com/acme/_git/app")).toBe("acme");
    expect(normalizeAzureOrganization("https://acme.visualstudio.com/DefaultCollection")).toBe(
      "acme",
    );
  });

  it("rejects empty or illegal names", () => {
    expect(normalizeAzureOrganization("")).toBeNull();
    expect(normalizeAzureOrganization("   ")).toBeNull();
    expect(normalizeAzureOrganization("acme/project")).toBe("acme");
    expect(normalizeAzureOrganization("bad org")).toBeNull();
  });
});

describe("listOrganizations", () => {
  beforeEach(() => {
    azureFetch.mockReset();
    getUserToken.mockReset();
    getInstancePatOrg.mockReset();
  });

  it("does not call VSSPS for a PAT — org-scoped PATs cannot list accounts", async () => {
    getUserToken.mockResolvedValue(null);
    getInstancePatOrg.mockResolvedValue("acme");

    await expect(listOrganizations(ctx)).resolves.toEqual(["acme"]);
    expect(azureFetch).not.toHaveBeenCalled();
  });

  it("returns no orgs for a PAT until the operator names the organization", async () => {
    getUserToken.mockResolvedValue(null);
    getInstancePatOrg.mockResolvedValue(null);

    await expect(listOrganizations(ctx)).resolves.toEqual([]);
    expect(azureFetch).not.toHaveBeenCalled();
  });

  it("lists Entra accounts from VSSPS and unions the PAT org", async () => {
    getUserToken.mockResolvedValue("aaa.bbb.ccc");
    getInstancePatOrg.mockResolvedValue("pat-org");
    azureFetch
      .mockResolvedValueOnce({ id: "member-1" })
      .mockResolvedValueOnce({ value: [{ accountName: "oauth-org" }] });

    await expect(listOrganizations(ctx)).resolves.toEqual(["oauth-org", "pat-org"]);
  });
});

describe("verifyPatCanReadOrganization", () => {
  beforeEach(() => {
    azureRequest.mockReset();
  });

  it("probes the org-scoped projects API (Code/Project read), not VSSPS accounts", async () => {
    azureRequest.mockResolvedValue({ value: [] });
    await verifyPatCanReadOrganization("pat-token", "acme");
    expect(azureRequest).toHaveBeenCalledWith(
      "https://dev.azure.com/acme/_apis/projects?$top=1",
      "pat-token",
    );
  });
});
