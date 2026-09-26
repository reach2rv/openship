import { describe, expect, it } from "vitest";
import { ValidationError } from "@repo/core";
import { inspectDotnetPrebuilt } from "../../src/lib/dotnet-prebuilt";
import type { RepoFile } from "../../src/lib/stack-detector";

function files(...names: string[]): RepoFile[] {
  return names.map((name) => ({ name, type: "file" }));
}

const LINUX_RUNTIMECONFIG = JSON.stringify({
  runtimeOptions: {
    tfm: "net8.0",
    framework: { name: "Microsoft.AspNetCore.App", version: "8.0.0" },
  },
});

const WIN_DEPS = JSON.stringify({
  runtimeTarget: { name: ".NETCoreApp,Version=v8.0/win-x64" },
});

describe("inspectDotnetPrebuilt", () => {
  it("returns null when a project/solution file is present (source wins)", () => {
    expect(
      inspectDotnetPrebuilt(files("HelloApi.csproj", "HelloApi.runtimeconfig.json", "HelloApi.dll")),
    ).toBeNull();
  });

  it("returns null when there is no publish layout", () => {
    expect(inspectDotnetPrebuilt(files("README.md", "package.json"))).toBeNull();
  });

  it("matches a linux framework-dependent publish at the folder root", () => {
    const match = inspectDotnetPrebuilt(files("HelloApi.dll", "HelloApi.runtimeconfig.json", "HelloApi.deps.json"), {
      "HelloApi.runtimeconfig.json": LINUX_RUNTIMECONFIG,
    });
    expect(match).toEqual({ assembly: "HelloApi", selfContained: false });
  });

  it("matches a nested single-folder publish", () => {
    const match = inspectDotnetPrebuilt(
      files("out/HelloApi.dll", "out/HelloApi.runtimeconfig.json"),
      { "out/HelloApi.runtimeconfig.json": LINUX_RUNTIMECONFIG },
    );
    expect(match?.assembly).toBe("HelloApi");
  });

  it("refuses a Windows RID", () => {
    expect(() =>
      inspectDotnetPrebuilt(files("HelloApi.dll", "HelloApi.runtimeconfig.json", "HelloApi.deps.json"), {
        "HelloApi.runtimeconfig.json": LINUX_RUNTIMECONFIG,
        "HelloApi.deps.json": WIN_DEPS,
      }),
    ).toThrow(ValidationError);
    expect(() =>
      inspectDotnetPrebuilt(files("HelloApi.dll", "HelloApi.runtimeconfig.json", "HelloApi.deps.json"), {
        "HelloApi.runtimeconfig.json": LINUX_RUNTIMECONFIG,
        "HelloApi.deps.json": WIN_DEPS,
      }),
    ).toThrow(/Windows/);
  });

  it("refuses a Windows .exe host", () => {
    expect(() =>
      inspectDotnetPrebuilt(files("HelloApi.exe", "HelloApi.runtimeconfig.json", "HelloApi.dll")),
    ).toThrow(/Windows/);
  });

  it("refuses a nupkg-only upload", () => {
    expect(() => inspectDotnetPrebuilt(files("Acme.Data.1.0.0.nupkg"))).toThrow(/NuGet/);
  });

  it("refuses a runtimeconfig without a sibling dll", () => {
    expect(() => inspectDotnetPrebuilt(files("HelloApi.runtimeconfig.json"))).toThrow(/dll/);
  });
});
