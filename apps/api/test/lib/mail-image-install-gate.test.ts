import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The openship-mail image is the iRedMail installer run at `docker build`. A
 * failed install used to still produce a layer: `bash iRedMail.sh || true`,
 * then a SEPARATE RUN that noticed the binaries were missing. BuildKit cached
 * the empty install forever and only the next layer failed — issue #493
 * showing up as "all mail binaries missing" on every rebuild of the gate.
 *
 * Building the image here is not an option (minutes, Debian, network). These
 * tests pin the contract the Dockerfile and the vendored engine must keep.
 */

const EMAIL_DIR = join(import.meta.dirname, "../../../../apps/email");
const DOCKERFILE = readFileSync(join(EMAIL_DIR, "Dockerfile"), "utf8");
const GET_ALL = readFileSync(join(EMAIL_DIR, "engine/pkgs/get_all.sh"), "utf8");
const SHA_FILE = join(EMAIL_DIR, "engine/pkgs/pkgs.sha256");
const TARBALL = join(EMAIL_DIR, "engine/pkgs/misc/iRedAPD-6.1.tar.gz");

describe("openship-mail install gate (issue #493)", () => {
  it("asserts mail binaries in the same RUN as iRedMail.sh", () => {
    // Split on RUN so a later layer cannot be what "gates" a `|| true` install.
    const runs = DOCKERFILE.split(/^RUN /m).slice(1);
    const installRun = runs.find((r) => r.includes("bash iRedMail.sh"));
    expect(installRun).toBeDefined();
    expect(installRun).toContain("FATAL: iRedMail install left mail binaries missing");
    expect(installRun).toContain("doveadm pw -s SSHA512");
    expect(installRun).toContain("IREDMAIL_HOSTNAME=mail.build.invalid");
    // BuildKit mounts /etc/hosts read-only; RUN --add-host is not a Dockerfile flag.
    expect(installRun).not.toMatch(/>>\s*\/etc\/hosts/);
    expect(installRun).not.toMatch(/--add-host=/);
  });

  it("does not leave the binary gate in a later RUN than the installer", () => {
    const installIdx = DOCKERFILE.indexOf("bash iRedMail.sh");
    const gateIdx = DOCKERFILE.indexOf("FATAL: iRedMail install left mail binaries missing");
    expect(installIdx).toBeGreaterThan(-1);
    expect(gateIdx).toBeGreaterThan(installIdx);
    const between = DOCKERFILE.slice(installIdx, gateIdx);
    expect(between).not.toMatch(/^RUN /m);
  });

  it("vendors the iRedAPD tarball that pkgs.sha256 names", () => {
    expect(existsSync(TARBALL)).toBe(true);
    const expected = readFileSync(SHA_FILE, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.endsWith("misc/iRedAPD-6.1.tar.gz"));
    expect(expected).toBeDefined();
    const want = expected!.split(/\s+/)[0].toLowerCase();
    const got = createHash("sha256").update(readFileSync(TARBALL)).digest("hex");
    expect(got).toBe(want);
  });

  it("skips the iRedMail mirror fetch when that checksum already matches", () => {
    expect(GET_ALL).toContain("Using vendored misc tarballs");
    expect(GET_ALL).toContain("status_fetch_misc");
    expect(GET_ALL).toContain("${CMD_SHASUM_CHECK}");
  });
});
