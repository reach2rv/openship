import { ValidationError } from "@repo/core";
import type { RepoFile } from "./stack-detector";

export type DotnetPrebuiltMatch = {
  assembly: string;
  selfContained: boolean;
};

function basename(path: string): string {
  const slash = path.replace(/\\/g, "/").lastIndexOf("/");
  return slash >= 0 ? path.slice(slash + 1) : path;
}

function dirOf(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(0, slash) : "";
}

function hasProjectFile(files: RepoFile[]): boolean {
  return files.some((file) => /\.(csproj|fsproj|sln)$/i.test(file.name));
}

function runtimeConfigPaths(files: RepoFile[]): string[] {
  return files.filter((file) => /\.runtimeconfig\.json$/i.test(file.name)).map((file) => file.name);
}

function lookupContent(fileContents: Record<string, string> | undefined, name: string): string | undefined {
  if (!fileContents) return undefined;
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(fileContents)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function windowsRid(text: string | undefined): boolean {
  if (!text) return false;
  return /\bwin(-|$)/i.test(text) || /\/win-x(64|86)\b/i.test(text);
}

function isSelfContained(runtimeConfig: Record<string, unknown> | null): boolean {
  const options = runtimeConfig?.runtimeOptions;
  if (!options || typeof options !== "object") return false;
  const opts = options as Record<string, unknown>;
  if (opts.isSelfContained === true) return true;
  return Array.isArray(opts.includedFrameworks) && opts.includedFrameworks.length > 0;
}

function hasMatchingDll(files: RepoFile[], assembly: string, directory: string): boolean {
  const want = `${assembly}.dll`.toLowerCase();
  return files.some((file) => {
    if (basename(file.name).toLowerCase() !== want) return false;
    return dirOf(file.name) === directory;
  });
}

function hasWindowsHost(files: RepoFile[], assembly: string, directory: string): boolean {
  const exe = `${assembly}.exe`.toLowerCase();
  return files.some((file) => {
    if (basename(file.name).toLowerCase() !== exe) return false;
    return dirOf(file.name) === directory;
  });
}

/**
 * Source trees (csproj/sln) are not prebuilt. A published layout is a
 * `*.runtimeconfig.json` whose stem matches a sibling `*.dll`.
 *
 * Throws {@link ValidationError} for a publish tree we refuse to run (Windows
 * RID, nupkg-only, config without a host dll). Returns null when this is not
 * a .NET publish tree.
 */
export function inspectDotnetPrebuilt(
  files: RepoFile[],
  fileContents?: Record<string, string>,
): DotnetPrebuiltMatch | null {
  if (hasProjectFile(files)) return null;

  const nupkgs = files.filter((file) => /\.nupkg$/i.test(file.name));
  const configs = runtimeConfigPaths(files);

  if (nupkgs.length > 0 && configs.length === 0) {
    throw new ValidationError(
      "This looks like a NuGet package (.nupkg), not a runnable app. Publish the web/worker project with `dotnet publish -r linux-x64` (or linux-arm64) and upload that folder or zip.",
    );
  }

  if (configs.length === 0) return null;

  const configPath = configs[0]!;
  const assembly = basename(configPath).replace(/\.runtimeconfig\.json$/i, "");
  const directory = dirOf(configPath);
  const configJson = parseJson(lookupContent(fileContents, configPath));
  const depsName = directory ? `${directory}/${assembly}.deps.json` : `${assembly}.deps.json`;
  const depsJson = parseJson(lookupContent(fileContents, depsName));
  const ridBlob = JSON.stringify({ config: configJson, deps: depsJson });

  if (windowsRid(ridBlob) || hasWindowsHost(files, assembly, directory)) {
    throw new ValidationError(
      "This publish targets Windows. Openship's bare host is Linux — publish with `dotnet publish -c Release -r linux-x64 --self-contained false` (or linux-arm64) and upload that output.",
    );
  }

  if (!hasMatchingDll(files, assembly, directory)) {
    throw new ValidationError(
      `Found ${basename(configPath)} but no matching ${assembly}.dll in the same folder. Upload the ` +
        "`dotnet publish` output directory (the folder that contains the dll and runtimeconfig), not a class library.",
    );
  }

  return { assembly, selfContained: isSelfContained(configJson) };
}
