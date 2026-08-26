#!/usr/bin/env bun
/**
 * Slim the bundled iRedMail engine to the mail-core we actually use.
 *
 * What it removes:
 *   - nginx + PHP (packages, configs, and the install/setup calls that
 *     pull them in)
 *   - iRedAdmin / Roundcube / SOGo web apps (openship + Zero replace them)
 *   - Netdata, mlmmj, memcached (unused subsystems)
 *   - OpenLDAP and MySQL backends (we use PostgreSQL exclusively)
 *
 * After running, the engine installs only: Postfix, Dovecot, Amavis,
 * ClamAV, SpamAssassin, iRedAPD, fail2ban, PostgreSQL - plus the helpers
 * those daemons need.
 *
 * Idempotency: re-running on an already-slimmed tree is a no-op. After we
 * sync upstream iRedMail (rare), drop the fresh tarball at
 * `apps/email/engine/` and re-run this script.
 *
 * Usage:
 *   bun run apps/email/scripts/slim-engine.ts
 *   bun run apps/email/scripts/slim-engine.ts --engine /custom/path
 *   bun run apps/email/scripts/slim-engine.ts --dry-run
 */

import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ─── Args / setup ────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const enginePathFlag = args.indexOf("--engine");
const engineDir = enginePathFlag >= 0
  ? resolve(args[enginePathFlag + 1])
  : resolve(dirname(fileURLToPath(import.meta.url)), "..", "engine");

if (!existsSync(engineDir)) {
  console.error(`Engine directory not found: ${engineDir}`);
  process.exit(1);
}

if (!existsSync(join(engineDir, "iRedMail.sh"))) {
  console.error(`${engineDir} does not look like an iRedMail tree (no iRedMail.sh)`);
  process.exit(1);
}

// ─── Files / dirs to delete outright ─────────────────────────────────────────

const DELETIONS = [
  // Component configs
  "conf/iredadmin",
  "conf/roundcube",
  "conf/sogo",
  "conf/netdata",
  "conf/openldap",
  "conf/mysql",
  "conf/mlmmj",
  "conf/memcached",
  "conf/nginx",
  "conf/php",
  "conf/web_server",

  // Setup function modules
  "functions/iredadmin.sh",
  "functions/roundcubemail.sh",
  "functions/sogo.sh",
  "functions/netdata.sh",
  "functions/openldap.sh",
  "functions/ldap_server.sh",
  "functions/mysql.sh",
  "functions/mlmmj.sh",
  "functions/nginx.sh",
  "functions/php.sh",
  "functions/web_server.sh",

  // Sample config trees (heavy + unused)
  "samples/iredadmin",
  "samples/sogo",
  "samples/roundcubemail",
  "samples/nginx",
  "samples/mysql",
  "samples/openldap",
  "samples/php",
  "samples/netdata",
  "samples/memcached",
  "samples/mlmmj",

  // Dialog (interactive-config) scripts we never invoke
  "dialog/ldap_config.sh",
  "dialog/mysql_config.sh",
  "dialog/web_applications.sh",
];

// ─── Single-line patches ─────────────────────────────────────────────────────
//
// Each entry removes EVERY occurrence of a matching line in the file.
// Regex is matched against entire lines (the script feeds it `^…$`).

interface LinePatch {
  file: string;
  /** Match against a single line. Anchored implicitly. */
  match: RegExp;
  label: string;
}

const LINE_PATCHES: LinePatch[] = [
  // iRedMail.sh: stop sourcing the deleted conf modules
  {
    file: "iRedMail.sh",
    match: /^\. \$\{CONF_DIR\}\/(?:nginx|php|iredadmin|roundcube|sogo|netdata|openldap|mysql|mlmmj|memcached|web_server)$/,
    label: "iRedMail.sh: drop deleted conf sources",
  },
  // iRedMail.sh: stop sourcing the deleted function modules
  {
    file: "iRedMail.sh",
    match: /^\. \$\{FUNCTIONS_DIR\}\/(?:nginx|php|iredadmin|roundcubemail|sogo|netdata|openldap|ldap_server|mysql|mlmmj|web_server)\.sh$/,
    label: "iRedMail.sh: drop deleted function sources",
  },
  // iRedMail.sh: drop the configure-time calls for the deleted subsystems
  {
    file: "iRedMail.sh",
    match: /^check_status_before_run (?:web_server_config|mlmmj_config|mlmmjadmin_config)$/,
    label: "iRedMail.sh: drop deleted setup calls",
  },

  // pkgs/get_all.sh: don't try to source the deleted conf/iredadmin module.
  // The script otherwise prints a "No such file" warning at startup and
  // proceeds with undefined iRedAdmin vars (harmless once we trim pkgs.sha256
  // below, but the noise is confusing).
  {
    file: "pkgs/get_all.sh",
    match: /^\. \$\{CONF_DIR\}\/iredadmin$/,
    label: "pkgs/get_all.sh: drop dead conf/iredadmin source",
  },

  // pkgs/pkgs.sha256: keep only the iRedAPD tarball - the engine slim
  // dropped iRedAdmin/Roundcube/SOGo/Netdata/mlmmjadmin, so we don't need
  // to fetch (or sha-verify) any of their tarballs anymore. Saves a
  // ~3 MB download per install AND avoids `sha256sum -c` failing when
  // those files don't get fetched.
  {
    file: "pkgs/pkgs.sha256",
    match: /^\S+\s+misc\/(?:iRedAdmin|mlmmjadmin|netdata|roundcubemail)-/,
    label: "pkgs.sha256: drop unused-tarball entries (keep iRedAPD only)",
  },

  // functions/cleanup.sh: drop the hardcoded "Web admin panel (iRedAdmin)"
  // URL from the post-install summary. The line is unconditional in the
  // engine - it prints even when iRedAdmin was never installed, which is
  // confusing. openship's dashboard surfaces the real credentials.
  {
    file: "functions/cleanup.sh",
    match: /^\* - Web admin panel \(iRedAdmin\): /,
    label: "cleanup.sh: drop misleading iRedAdmin URL from final summary",
  },
];

// ─── Multi-line shell block patches ──────────────────────────────────────────
//
// Each entry locates an `if … ; then … fi` opening line and removes the
// entire block through the matching `fi` at the same indent level. Robust
// to nested ifs because we match indent depth, not just braces.

interface BlockPatch {
  file: string;
  /** Match the OPENING line of the block (typically the `if`). */
  openingMatch: RegExp;
  label: string;
}

const BLOCK_PATCHES: BlockPatch[] = [
  // packages.sh: drop the force-enable of PHP when WEB_SERVER=NGINX
  {
    file: "functions/packages.sh",
    openingMatch: /^\s*if \[ X"\$\{WEB_SERVER\}" == X'NGINX' \]; then\s*$/,
    label: "packages.sh: drop WEB_SERVER=NGINX → PHP forcing (and nginx pkg block)",
  },
  // packages.sh: drop the whole PHP packages block
  {
    file: "functions/packages.sh",
    openingMatch: /^\s*if \[ X"\$\{IREDMAIL_USE_PHP\}" == X'YES' \]; then\s*$/,
    label: "packages.sh: drop PHP packages block",
  },
  // packages.sh: drop Roundcube extras block (PHP add-ons)
  {
    file: "functions/packages.sh",
    openingMatch: /^\s*if \[ X"\$\{USE_ROUNDCUBE\}" == X'YES' \]; then\s*$/,
    label: "packages.sh: drop Roundcube extras",
  },
  // packages.sh: drop SOGo packages
  {
    file: "functions/packages.sh",
    openingMatch: /^\s*if \[ X"\$\{USE_SOGO\}" == X'YES' \]; then\s*$/,
    label: "packages.sh: drop SOGo packages",
  },
  // packages.sh: drop Netdata packages
  {
    file: "functions/packages.sh",
    openingMatch: /^\s*if \[ X"\$\{USE_NETDATA\}" == X'YES' \]; then\s*$/,
    label: "packages.sh: drop Netdata packages",
  },
  // optional_components.sh: each USE_* dispatch is a two-line `[ … ] && \  <newline>  check_status_before_run …`
  // Those aren't `if … fi` blocks - we handle them via LINE_PATCHES below. Skip.
];

// ─── Text-find-replace patches ───────────────────────────────────────────────
//
// Use sparingly - these don't delete, they substitute text. Each entry
// applies once per file (idempotent: if `find` is missing but `replace` is
// already present, we treat it as already patched).

interface TextPatch {
  file: string;
  find: string;
  replace: string;
  label: string;
  /** Presence of this substring means the patch is already applied. Used when
   *  `replace` can miss `includes()` because of CRLF vs the in-memory LF source. */
  sentinel?: string;
}

const TEXT_PATCHES: TextPatch[] = [
  // get_all.sh: skip the mirror fetch when pkgs/misc already hashes. wget -c
  // still contacts the mirror for a complete file; a dead mirror used to abort
  // the whole installer and, with Docker `|| true`, cache a binary-less image.
  {
    file: "pkgs/get_all.sh",
    find: "prepare_dirs\n\n# Check required commands, and install packages which offer the commands.\n",
    replace:
      "prepare_dirs\n\n" +
      "# Prefer in-tree misc tarballs whose sha256 already matches pkgs.sha256.\n" +
      "# `wget -c` still contacts IREDMAIL_MIRROR even when the file is complete; a\n" +
      "# dead or rate-limited mirror aborted get_all.sh, iRedMail.sh exited 255, and\n" +
      "# Docker's `|| true` cached an image with no mail stack (issue #493).\n" +
      'if [ X"${status_fetch_misc}" != X"DONE" ] && [ -f "${_ROOTDIR}/${SHASUM_CHECK_FILE}" ]; then\n' +
      '    if (cd "${_ROOTDIR}" && ${CMD_SHASUM_CHECK} ${SHASUM_CHECK_FILE}); then\n' +
      '        ECHO_INFO "Using vendored misc tarballs (sha256 already matches ${SHASUM_CHECK_FILE})."\n' +
      "        echo 'export status_fetch_misc=\"DONE\"' >> ${STATUS_FILE}\n" +
      "        echo 'export status_verify_downloaded_packages=\"DONE\"' >> ${STATUS_FILE}\n" +
      '        export status_fetch_misc="DONE"\n' +
      '        export status_verify_downloaded_packages="DONE"\n' +
      "    fi\n" +
      "fi\n\n" +
      "# Check required commands, and install packages which offer the commands.\n",
    label: "get_all.sh: skip mirror fetch when vendored tarballs already hash",
    sentinel: "Using vendored misc tarballs",
  },
  // fail2ban.sh: redirect stderr on the every-minute cron line so cron
  // doesn't mail root once a minute when fail2ban's psql auth is broken
  // (the real failure surfaces in /var/log/fail2ban.log instead).
  {
    file: "functions/fail2ban.sh",
    find: "* * * * * ${SHELL_BASH} /usr/local/bin/fail2ban_banned_db unban_db\n",
    replace: "* * * * * ${SHELL_BASH} /usr/local/bin/fail2ban_banned_db unban_db >/dev/null 2>&1\n",
    label: "fail2ban.sh: silence cron stderr to stop root-mail spam",
  },
];

// optional_components.sh has lines like:
//   [ X"${USE_IREDADMIN}" == X'YES' ] && \
//       check_status_before_run iredadmin_setup
// The `\` makes them one logical line continued. We delete both physical
// lines as a pair when the first matches.

interface PairPatch {
  file: string;
  match: RegExp;
  label: string;
}

const PAIR_PATCHES: PairPatch[] = [
  {
    file: "functions/optional_components.sh",
    match: /^\s*\[ X"\$\{USE_(?:IREDADMIN|ROUNDCUBE|SOGO|NETDATA)\}" == X'YES' \] && \\$/,
    label: "optional_components: drop USE_* dispatch pairs",
  },
];

// ─── Apply ───────────────────────────────────────────────────────────────────

let deleted = 0;
let alreadyGone = 0;
let patched = 0;
let alreadyPatched = 0;

console.log(`slim-engine - ${dryRun ? "DRY RUN" : "applying"}`);
console.log(`engine: ${engineDir}`);
console.log("");

// Deletions
for (const rel of DELETIONS) {
  const abs = join(engineDir, rel);
  if (!existsSync(abs)) {
    alreadyGone++;
    continue;
  }
  const kind = statSync(abs).isDirectory() ? "dir" : "file";
  console.log(`  rm  ${rel}/  (${kind})`);
  if (!dryRun) rmSync(abs, { recursive: true, force: true });
  deleted++;
}

// Line patches
const lineEdits = new Map<string, RegExp[]>();
for (const p of LINE_PATCHES) {
  if (!lineEdits.has(p.file)) lineEdits.set(p.file, []);
  lineEdits.get(p.file)!.push(p.match);
}

for (const [relFile, patterns] of lineEdits) {
  const absFile = join(engineDir, relFile);
  if (!existsSync(absFile)) {
    console.log(`  skip ${relFile}  (file missing)`);
    continue;
  }
  const lines = readFileSync(absFile, "utf8").split("\n");
  let droppedHere = 0;
  const kept = lines.filter((line: string) => {
    if (patterns.some((p) => p.test(line))) {
      droppedHere++;
      return false;
    }
    return true;
  });

  if (droppedHere === 0) {
    alreadyPatched++;
    continue;
  }
  console.log(`  patch ${relFile}  (-${droppedHere} lines)`);
  if (!dryRun) writeFileSync(absFile, kept.join("\n"));
  patched++;
}

// Pair patches - for `[ … ] && \` continuation pattern
for (const p of PAIR_PATCHES) {
  const absFile = join(engineDir, p.file);
  if (!existsSync(absFile)) continue;
  const lines = readFileSync(absFile, "utf8").split("\n");
  const out: string[] = [];
  let droppedHere = 0;
  for (let i = 0; i < lines.length; i++) {
    if (p.match.test(lines[i])) {
      // Drop this line AND the next (the `check_status_before_run …`).
      droppedHere += 2;
      i++; // skip next
      continue;
    }
    out.push(lines[i]);
  }
  if (droppedHere === 0) {
    alreadyPatched++;
    continue;
  }
  console.log(`  patch ${p.file}  (-${droppedHere} lines, pair removals)`);
  if (!dryRun) writeFileSync(absFile, out.join("\n"));
  patched++;
}

// Text patches - find-replace substitutions
for (const p of TEXT_PATCHES) {
  const absFile = join(engineDir, p.file);
  if (!existsSync(absFile)) {
    console.log(`  skip ${p.file}  (file missing)`);
    continue;
  }
  const content = readFileSync(absFile, "utf8");
  if ((p.sentinel && content.includes(p.sentinel)) || content.includes(p.replace)) {
    alreadyPatched++;
    continue;
  }
  if (!content.includes(p.find)) {
    console.log(`  warn ${p.file}  (find string missing - ${p.label})`);
    continue;
  }
  const next = content.replace(p.find, p.replace);
  console.log(`  patch ${p.file}  (${p.label})`);
  if (!dryRun) writeFileSync(absFile, next);
  patched++;
}

// Block patches - remove `if … fi` shell blocks by indent matching
for (const p of BLOCK_PATCHES) {
  const absFile = join(engineDir, p.file);
  if (!existsSync(absFile)) continue;

  let content = readFileSync(absFile, "utf8");
  let removedTotal = 0;
  // Loop so we strip every occurrence (e.g. packages.sh has multiple
  // `if WEB_SERVER == NGINX` blocks - both go).
  for (;;) {
    const result = removeShellBlock(content, p.openingMatch);
    if (!result.removed) break;
    content = result.content;
    removedTotal += result.removedLines;
  }
  if (removedTotal === 0) {
    alreadyPatched++;
    continue;
  }
  console.log(`  patch ${p.file}  (-${removedTotal} lines, ${p.label})`);
  if (!dryRun) writeFileSync(absFile, content);
  patched++;
}

console.log("");
console.log(
  `done: ${deleted} deleted, ${alreadyGone} already gone, ${patched} patched, ${alreadyPatched} already patched`,
);
if (dryRun) console.log("(dry-run: no files were modified)");

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Remove a shell `if … then … fi` block from `content`. Finds the first
 * line matching `openingMatch`, then advances until it sees `fi` at the
 * same indent depth - that's the matching close. Cuts the inclusive range.
 *
 * Returns { removed: false } if no opening line matches. Throws if it
 * finds an opening but can't find a matching `fi` (corruption).
 */
function removeShellBlock(
  content: string,
  openingMatch: RegExp,
): { content: string; removed: boolean; removedLines: number } {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!openingMatch.test(lines[i])) continue;

    const openIndent = (lines[i].match(/^(\s*)/)?.[1] ?? "").length;
    for (let j = i + 1; j < lines.length; j++) {
      const lineIndent = (lines[j].match(/^(\s*)/)?.[1] ?? "").length;
      const trimmed = lines[j].trim();
      if (lineIndent === openIndent && trimmed === "fi") {
        const removedLines = j - i + 1;
        lines.splice(i, removedLines);
        return { content: lines.join("\n"), removed: true, removedLines };
      }
    }
    throw new Error(
      `slim-engine: opening line matched at line ${i + 1} but no matching fi found: "${lines[i]}"`,
    );
  }
  return { content, removed: false, removedLines: 0 };
}
