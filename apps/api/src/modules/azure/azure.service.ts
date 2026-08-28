/**
 * Azure DevOps REST helpers — orgs, repos, branches, files, Service Hooks.
 */

import { randomBytes } from "node:crypto";
import { buildGitUrl } from "@repo/core";
import { repos } from "@repo/db";
import { encrypt } from "../../lib/encryption";
import { sharedAzureWebhookUrl } from "../../lib/public-url";
import type { RequestContext } from "../../lib/request-context";
import { azureFetch, azureFetchText, azureRequest, getInstancePatOrg, getUserToken } from "./azure.auth";

const ADO = "https://dev.azure.com";
const VSSPS = "https://app.vssps.visualstudio.com";
/** Azure DevOps Service Hook publisher event — not an Openship audit `eventType`. */
const AZURE_SERVICE_HOOK_PUSH_EVENT = "git.push";

interface AzureList<T> {
  value?: T[];
}

interface AzureAccount {
  accountName?: string;
  accountUri?: string;
}

interface AzureProfile {
  id?: string;
  displayName?: string;
  emailAddress?: string;
}

export interface AzureRepo {
  id: string;
  name: string;
  org: string;
  project: string;
  defaultBranch: string;
  remoteUrl: string;
  webUrl: string;
  isDisabled: boolean;
}

interface AzureGitRepository {
  id: string;
  name: string;
  isDisabled?: boolean;
  defaultBranch?: string;
  remoteUrl?: string;
  webUrl?: string;
  project?: { name?: string; id?: string };
}

interface AzureRef {
  name: string;
  objectId?: string;
}

interface AzureItem {
  path?: string;
  isFolder?: boolean;
  gitObjectType?: string;
}

const AZURE_ORG_SLUG = /^[A-Za-z0-9][A-Za-z0-9-]{0,255}$/;

/** Organization slug from a typed name or a pasted Azure DevOps URL. */
export function normalizeAzureOrganization(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let slug = trimmed;
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      const vs = url.hostname.match(/^([^.]+)\.visualstudio\.com$/i);
      if (vs?.[1]) slug = vs[1];
      else if (url.hostname.replace(/^www\./i, "") === "dev.azure.com") {
        slug = url.pathname.split("/").filter(Boolean)[0] ?? "";
      } else {
        return null;
      }
    } catch {
      return null;
    }
  } else {
    slug = trimmed.replace(/^\/+|\/+$/g, "").split("/")[0] ?? "";
  }
  return AZURE_ORG_SLUG.test(slug) ? slug : null;
}

/**
 * Org-scoped PATs cannot call VSSPS /accounts. Probe the org's own REST surface
 * instead — that is what Code (Read) / Project (Read) actually grants.
 */
export async function verifyPatCanReadOrganization(token: string, org: string): Promise<void> {
  await azureRequest(`https://dev.azure.com/${encodeURIComponent(org)}/_apis/projects?$top=1`, token);
}

async function listOrganizationsViaOauth(ctx: RequestContext): Promise<string[]> {
  const me = await azureFetch<AzureProfile>(`${VSSPS}/_apis/profile/profiles/me`, ctx);
  if (!me.id) return [];
  const accounts = await azureFetch<AzureList<AzureAccount>>(
    `${VSSPS}/_apis/accounts?memberId=${encodeURIComponent(me.id)}`,
    ctx,
  );
  return (accounts.value ?? [])
    .map((a) => a.accountName)
    .filter((n): n is string => Boolean(n));
}

export async function listOrganizations(ctx: RequestContext): Promise<string[]> {
  const [oauthToken, patOrg] = await Promise.all([
    getUserToken(ctx.userId),
    getInstancePatOrg(),
  ]);
  const fromPat = patOrg ? [patOrg] : [];
  if (!oauthToken) return fromPat;

  let fromOauth: string[] = [];
  try {
    fromOauth = await listOrganizationsViaOauth(ctx);
  } catch {
    fromOauth = [];
  }
  return [...new Set([...fromOauth, ...fromPat])];
}

export async function listRepos(ctx: RequestContext, org: string): Promise<AzureRepo[]> {
  const data = await azureFetch<AzureList<AzureGitRepository>>(
    `${ADO}/${encodeURIComponent(org)}/_apis/git/repositories`,
    ctx,
  );
  return (data.value ?? [])
    .filter((r) => !r.isDisabled && r.name && r.project?.name)
    .map((r) => ({
      id: r.id,
      name: r.name,
      org,
      project: r.project!.name!,
      defaultBranch: (r.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
      remoteUrl: r.remoteUrl || buildGitUrl("azure", org, r.name, r.project!.name!),
      webUrl: r.webUrl || `${ADO}/${org}/${r.project!.name!}/_git/${r.name}`,
      isDisabled: Boolean(r.isDisabled),
    }));
}

export async function getRepository(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
): Promise<AzureRepo> {
  const data = await azureFetch<AzureGitRepository>(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}`,
    ctx,
  );
  return {
    id: data.id,
    name: data.name,
    org,
    project: data.project?.name || project,
    defaultBranch: (data.defaultBranch ?? "refs/heads/main").replace(/^refs\/heads\//, ""),
    remoteUrl: data.remoteUrl || buildGitUrl("azure", org, data.name, project),
    webUrl: data.webUrl || `${ADO}/${org}/${project}/_git/${data.name}`,
    isDisabled: Boolean(data.isDisabled),
  };
}

export async function listBranches(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
): Promise<{ name: string }[]> {
  const data = await azureFetch<AzureList<AzureRef>>(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/refs?filter=heads/`,
    ctx,
  );
  return (data.value ?? [])
    .map((r) => r.name.replace(/^refs\/heads\//, ""))
    .filter(Boolean)
    .map((name) => ({ name }));
}

export async function listItems(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  opts?: { path?: string; branch?: string },
): Promise<AzureItem[]> {
  const url = new URL(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items`,
  );
  url.searchParams.set("recursionLevel", opts?.path ? "OneLevel" : "Full");
  if (opts?.path) url.searchParams.set("scopePath", opts.path.startsWith("/") ? opts.path : `/${opts.path}`);
  if (opts?.branch) {
    url.searchParams.set("versionDescriptor.version", opts.branch);
    url.searchParams.set("versionDescriptor.versionType", "branch");
  }
  const data = await azureFetch<AzureList<AzureItem>>(url.toString(), ctx);
  return data.value ?? [];
}

export async function getItemContent(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  path: string,
  branch?: string,
): Promise<string | undefined> {
  const url = new URL(
    `${ADO}/${encodeURIComponent(org)}/${encodeURIComponent(project)}/_apis/git/repositories/${encodeURIComponent(repo)}/items`,
  );
  url.searchParams.set("path", path.startsWith("/") ? path : `/${path}`);
  url.searchParams.set("includeContent", "true");
  url.searchParams.set("download", "true");
  if (branch) {
    url.searchParams.set("versionDescriptor.version", branch);
    url.searchParams.set("versionDescriptor.versionType", "branch");
  }
  return azureFetchText(url.toString(), ctx);
}

export async function registerServiceHook(
  ctx: RequestContext,
  org: string,
  project: string,
  repo: string,
  secret: string,
): Promise<{ subscriptionId: string; encryptedSecret: string }> {
  const repository = await getRepository(ctx, org, project, repo);
  const body = {
    publisherId: "tfs",
    eventType: AZURE_SERVICE_HOOK_PUSH_EVENT,
    resourceVersion: "1.0",
    consumerId: "webHooks",
    consumerActionId: "httpRequest",
    publisherInputs: {
      projectId: undefined as string | undefined,
      repository: repository.id,
    },
    consumerInputs: {
      url: sharedAzureWebhookUrl(),
      basicAuthUsername: "openship",
      basicAuthPassword: secret,
    },
  };
  const created = await azureFetch<{ id: string }>(
    `${ADO}/${encodeURIComponent(org)}/_apis/hooks/subscriptions`,
    ctx,
    { method: "POST", body },
  );
  if (!created.id) throw new Error("Azure DevOps did not return a Service Hook id");
  return { subscriptionId: created.id, encryptedSecret: encrypt(secret) };
}

export async function enableProjectHook(
  ctx: RequestContext,
  projectId: string,
  org: string,
  project: string,
  repo: string,
): Promise<string> {
  const secret = randomBytes(32).toString("hex");
  const { subscriptionId, encryptedSecret } = await registerServiceHook(
    ctx,
    org,
    project,
    repo,
    secret,
  );
  await repos.project.update(projectId, {
    autoDeploy: true,
    webhookExternalId: subscriptionId,
    webhookSecret: encryptedSecret,
  });
  return subscriptionId;
}

export async function deleteServiceHook(
  ctx: RequestContext,
  org: string,
  subscriptionId: string,
): Promise<void> {
  await azureFetch(
    `${ADO}/${encodeURIComponent(org)}/_apis/hooks/subscriptions/${encodeURIComponent(subscriptionId)}`,
    ctx,
    { method: "DELETE" },
  );
}
