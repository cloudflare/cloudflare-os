// The risk-review gate's fixed rules: how risky a change is (low, medium or high) and which paths
// always need a person. Everything here is a pure function of the changed files and of policy
// files read from the base branch, so the gate can apply it without running pull request code.
//
// Imports are limited to `node:` builtins and other judge modules, `scripts/risk-review*` and
// `scripts/automerge/` (see risk-review-imports.test.ts): the gate runs this file from the base
// branch, and a dependency resolved from the workspace could come from the pull request's lockfile.

import { matchesGlob } from "node:path/posix";
import { isDeepStrictEqual } from "node:util";

import { isInstructionPath } from "./automerge/instructions.ts";
import { maybeJson, maybeObject, type Json, type JsonObject } from "./automerge/json.ts";

/** A risk level, lowest first. */
export type Band = "low" | "medium" | "high";

const BANDS: readonly Band[] = ["low", "medium", "high"];

/** Lines changed above which a change is high risk whatever its paths. */
const MAX_LINES = 400;

/**
 * Files touched above which a change is high risk. Measured 2026-11-02: 3 of the 217 merged GitHub
 * pull requests with at most 400 changed lines touched more than 20 files (95th percentile: 14).
 */
const MAX_FILES = 20;

/** The fields of a changed file, as `pulls.listFiles` returns it, that the gate reads. */
export interface ChangedFile {
  filename: string;
  /** The path before a rename or copy, which matters as much as the new one. */
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
}

/** The paths a rule covers: any that match `globs` or satisfy `paths`, and none that match `except`. */
interface PathRule {
  globs: readonly string[];
  paths?: (path: string) => boolean;
  except?: readonly string[];
}

/**
 * Paths that set a minimum risk level, highest first. High is the kernel, this gate and the rest of
 * CI and release, the supply-chain policy, and the security chokepoints REVIEW.md names outside the
 * kernel.
 */
const PATH_FLOORS: (PathRule & { band: Band; reason: string })[] = [
  {
    band: "high",
    reason: "touches a designated sensitive path",
    globs: [
      ".github/**",
      "scripts/release/**",
      "scripts/risk-review*",
      "scripts/risk-review*/**",
      "scripts/automerge/**",
      "scripts/contribution-policy.ts",
      "pnpm-workspace.yaml",
      "**/.npmrc",
      "**/.pnpmfile.cjs",
      "**/.pnpmfile.mjs",
      "packages/workshop-backend/**",
      "packages/typed-storage/**",
      "packages/workshop-shared/src/api.ts",
      "packages/workshop-frontend/src/routes/connect.handoff.tsx",
      "packages/gatekeeper-kit/src/credential-stage.ts",
      "packages/gatekeeper-context/src/collection-access.ts",
      "packages/mcp-shared/src/tools.ts",
    ],
  },
  {
    band: "medium",
    reason:
      "changes shared code, a gatekeeper, the router, shared UI, the approval UI, observability, build " +
      "or dev tooling, dependencies, worker config, or the instructions an AI reviewer follows",
    globs: [
      "packages/workshop-shared/src/**",
      "packages/gatekeeper-*/src/**",
      "packages/mcp-shared/src/**",
      "packages/router/src/**",
      "packages/bundled-blueprints/**",
      "packages/configurator-ui/build/**",
      "packages/ui/**",
      "packages/observability/**",
      "packages/error-reporting/**",
      "packages/workshop-frontend/src/useResolveAction.tsx",
      "packages/workshop-frontend/src/useAutoApproval.ts",
      "scripts/**",
      "**/vite.config.ts",
      "**/vitest*.config.ts",
      "**/tsconfig*.json",
      "**/package.json",
      "pnpm-lock.yaml",
      "**/cloudflare.config.ts",
      "**/wrangler.jsonc",
    ],
    paths: isInstructionPath,
  },
];

/** Skills, which coding agents read. A skill's own files are not on the always-a-person list. */
const SKILLS_DIR = ".agents/skills/";

/** Whether a path is under `.agents/skills/`, where a symlink needs a person. */
export function isSkillPath(filename: string): boolean {
  return filename.startsWith(SKILLS_DIR);
}

/**
 * Whether a change to this path is on the always-a-person list because AI reviewers follow it:
 * every instruction path but a skill's own files, and an instruction file or directory of its own
 * inside a skill. A skill's own files keep the medium floor of every instruction path, so rung 2,
 * which takes only low risk, takes none; leaving them off the list keeps that a matter of risk
 * level. The reviewers read the base version of every instruction path, so a skill edit cannot
 * steer its own review; a symlink there can, and `skillSymlinks` sends it to a person.
 */
function isReviewerInstruction(path: string): boolean {
  return isInstructionPath(isSkillPath(path) ? path.slice(SKILLS_DIR.length) : path);
}

/**
 * Paths no AI may decide on, always a person: this gate and everything it reads or trusts (so a
 * pull request that an AI judges always runs `main`'s producer workflows and judge scripts), the
 * instructions AI reviewers follow, auth config, the supply-chain policy and release. Each entry
 * names its reason for the decision record.
 */
const NEVER_AUTO_PATHS: (PathRule & { reason: string })[] = [
  { reason: "CI, repository policy or a producer workflow", globs: [".github/**"] },
  {
    reason: "gate or judge code",
    globs: ["scripts/risk-review*", "scripts/risk-review*/**", "scripts/automerge/**", "scripts/contribution-policy*"],
  },
  { reason: "instructions an AI reviewer follows", globs: [], paths: isReviewerInstruction },
  { reason: "auth config", globs: ["packages/workshop-backend/src/auth/**"] },
  { reason: "supply-chain policy", globs: ["**/.npmrc", "**/.pnpmfile.cjs", "**/.pnpmfile.mjs"] },
  { reason: "release pipeline", globs: ["scripts/release/**"] },
  {
    // Wrangler looks for `wrangler.json` before `wrangler.jsonc`, in the Worker's directory and
    // every one above it, and `wrangler deploy` follows `.wrangler/deploy/config.json`. Either
    // would deploy a config that the generated `wrangler.jsonc` does not show.
    reason: "a Wrangler config other than the generated wrangler.jsonc",
    globs: ["**/wrangler.json", "**/wrangler.toml", "**/.wrangler/**"],
  },
];

/**
 * Files an escape snapshot entry does not raise the risk level for: lockfiles and prose outside
 * `.agents/`, which nearly every pull request touches and which no reviewer judges by their past.
 */
const ESCAPE_IGNORED = { globs: ["**/pnpm-lock.yaml", "docs/**", "plans/**", "**/*.md"], except: ["**/.agents/**"] };

/**
 * The Worker config that deploys: Wrangler and the release manifest (`scripts/release/
 * manifest-lib.ts`) read `wrangler.jsonc`, and `cloudflare.config.ts` takes effect only through it.
 */
const DEPLOYED_CONFIG = "**/wrangler.jsonc";

/** `pnpm-workspace.yaml` is on the policy list except when only catalog versions change. */
const WORKSPACE_FILE = "pnpm-workspace.yaml";

/** Code whose change is high risk wherever it sits: storage, RPC and capability seams. */
const SEAMS: { reason: string; globs: string[] }[] = [
  { reason: "storage", globs: ["**/storage-schema/**", "packages/typed-storage/**"] },
  { reason: "RPC", globs: ["packages/workshop-shared/src/api.ts", "**/*-binding.d.ts"] },
  {
    reason: "capability",
    globs: [
      "packages/workshop-backend/src/user.ts",
      "packages/workshop-backend/src/overseer.ts",
      "packages/gatekeeper-kit/src/credential-stage.ts",
      "packages/gatekeeper-context/src/collection-access.ts",
      "packages/mcp-shared/src/tools.ts",
    ],
  },
];

/**
 * `matchesGlob` per path segment, where a `**` segment matches any number of segments, dot-segments
 * included (`matchesGlob` alone never crosses those). A trailing `**` needs at least one segment, so
 * `packages/workshop-backend/**` does not match a file named `packages/workshop-backend`.
 */
function matchesPath(filename: string, glob: string): boolean {
  return matchSegments(filename.split("/"), glob.split("/"));
}

function matchSegments(path: string[], glob: string[]): boolean {
  const [pattern, ...rest] = glob;
  if (pattern === undefined) return path.length === 0;
  if (pattern === "**") {
    if (rest.length === 0) return path.length > 0;
    return path.some((_, start) => matchSegments(path.slice(start), rest)) || matchSegments([], rest);
  }
  const [segment, ...remaining] = path;
  return segment !== undefined && matchesGlob(segment, pattern) && matchSegments(remaining, rest);
}

function matchesAny(filename: string, globs: readonly string[]): boolean {
  return globs.some((glob) => matchesPath(filename, glob));
}

function matchesRule(filename: string, { globs, paths, except = [] }: PathRule): boolean {
  return (matchesAny(filename, globs) || paths?.(filename) === true) && !matchesAny(filename, except);
}

/** Both paths of a changed file: a rename away from a path counts as changing it. */
function pathsOf({ filename, previous_filename }: ChangedFile): string[] {
  return previous_filename === undefined ? [filename] : [previous_filename, filename];
}

function describePath({ filename, previous_filename }: ChangedFile): string {
  return previous_filename === undefined ? filename : `${previous_filename} → ${filename}`;
}

function maxBand(a: Band, b: Band): Band {
  return BANDS.indexOf(a) >= BANDS.indexOf(b) ? a : b;
}

function raiseOne(band: Band): Band {
  return BANDS[Math.min(BANDS.indexOf(band) + 1, BANDS.length - 1)] ?? "high";
}

/**
 * Returns the minimum risk level a path sets.
 *
 * @param filename Repository-relative path.
 */
export function pathFloor(filename: string): Band {
  return PATH_FLOORS.find((rule) => matchesRule(filename, rule))?.band ?? "low";
}

function fileFloor(file: ChangedFile): Band {
  return pathsOf(file).map(pathFloor).reduce(maxBand, "low");
}

function names(files: ChangedFile[]): string {
  const shown = files.slice(0, 3).map(describePath).join(", ");
  return files.length > 3 ? `${shown}, and ${files.length - 3} more` : shown;
}

/** One changed file's entry in the escape snapshot, from a culprit of an escaped defect. */
export interface EscapeEntry {
  path: string;
  /** The day the escape's fix merged, `YYYY-MM-DD`. */
  fixed: string;
  culprit: string;
  fix: string;
}

/** `.github/automerge-escape-files.json`. */
export interface EscapeSnapshot {
  windowDays: number;
  files: EscapeEntry[];
}

/** What the gate read from the head and base contents of files whose diff alone is not enough. */
export interface ContentFacts {
  /** Whether `pnpm-workspace.yaml` changed only catalog version values; true when it did not change. */
  workspaceCatalogOnly: boolean;
  /** `path: name` for each dependency a `package.json` gained, or `path: unreadable`. */
  newDependencies: string[];
  /**
   * `path: reason` for each way a `wrangler.jsonc` change may drop Durable Object data: a class an
   * appended migration deletes, another operation that is not adding classes, an appended
   * migration with no tag or a used one, rewritten migrations, a file `removed`, or one that is
   * `unreadable`.
   */
  durableObjectRisks: string[];
  /** Paths under `.agents/skills/` that are a symlink at base or head, or whose type is unreadable. */
  skillSymlinks: string[];
}

/** The risk level and policy reasons of one change. */
interface Classification {
  band: Band;
  bandReasons: string[];
  /** Why no AI may decide; empty when one may. */
  neverAuto: string[];
}

/**
 * Classifies a change. Every rule can only raise the risk level or add a policy reason.
 *
 * @param input The changed files; whether `listFiles` returned every one (it stops at 3,000); what
 *     the gate read from file contents; the escape snapshot from the base branch, or `undefined` when
 *     it is missing or malformed; and the time of the decision, for the escape window.
 */
export function classifyChangeset({ files, listed, facts, escapes, now }: {
  files: ChangedFile[];
  listed: boolean;
  facts: ContentFacts;
  escapes: EscapeSnapshot | undefined;
  now: Date;
}): Classification {
  let band: Band = "low";
  const bandReasons: string[] = [];
  const raise = (to: Band, reason: string) => {
    band = maxBand(band, to);
    bandReasons.push(`${to}: ${reason}`);
  };

  for (const { band: floor, reason } of PATH_FLOORS) {
    const matched = files.filter((file) => fileFloor(file) === floor);
    if (matched.length > 0) raise(floor, `${reason} (${names(matched)})`);
  }
  const neverAuto: string[] = [];
  // An unlisted file's path is unknown, so it could be any floor's or a policy file.
  if (!listed) {
    raise("high", "some changed files were not listed, so their paths went unchecked");
    neverAuto.push("some changed files were not listed");
  }
  const lines = files.reduce((sum, file) => sum + file.additions + file.deletions, 0);
  if (lines > MAX_LINES) raise("high", `${lines} lines changed, over ${MAX_LINES}`);
  if (files.length > MAX_FILES) raise("high", `${files.length} files changed, over ${MAX_FILES}`);
  const seams = SEAMS.filter(({ globs }) => files.some((file) => pathsOf(file).some((path) => matchesAny(path, globs))));
  for (const { reason } of seams) raise("high", `changes ${reason} code`);
  if (facts.newDependencies.length > 0) raise("high", `adds dependencies (${facts.newDependencies.join(", ")})`);

  if (escapes === undefined) {
    band = raiseOne(band);
    bandReasons.push(`${band}: raised one band: the escape list is missing or malformed`);
  } else {
    const since = now.getTime() - escapes.windowDays * 86_400_000;
    const hits = escapes.files.filter((entry) =>
      Date.parse(entry.fixed) >= since && !matchesRule(entry.path, ESCAPE_IGNORED) &&
      files.some((file) => pathsOf(file).includes(entry.path)));
    if (hits.length > 0) {
      band = raiseOne(band);
      const shown = [...new Set(hits.map(({ path, culprit }) => `${path} (${culprit})`))].slice(0, 3).join(", ");
      bandReasons.push(`${band}: raised one band: touches files with a recent escaped defect (${shown})`);
    }
  }

  for (const rule of NEVER_AUTO_PATHS) {
    const matched = files.filter((file) => pathsOf(file).some((path) => matchesRule(path, rule)));
    if (matched.length > 0) neverAuto.push(`${rule.reason} (${names(matched)})`);
  }
  if (facts.skillSymlinks.length > 0) neverAuto.push(`a symlink under .agents/skills/ (${facts.skillSymlinks.join(", ")})`);
  if (files.some((file) => pathsOf(file).includes(WORKSPACE_FILE)) && !facts.workspaceCatalogOnly) {
    neverAuto.push(`supply-chain policy (${WORKSPACE_FILE} beyond catalog versions)`);
  }
  if (facts.durableObjectRisks.length > 0) {
    neverAuto.push(`may drop Durable Object data (${facts.durableObjectRisks.join(", ")})`);
  }
  return { band, bandReasons, neverAuto };
}

/**
 * Whether `head` differs from `base` only in the values of existing catalog entries: the same
 * lines outside `catalog:`/`catalogs:`, and inside them the same keys in the same order. A new or
 * removed entry is a new dependency, not a version bump.
 */
export function isCatalogVersionBump(base: string, head: string): boolean {
  const before = base.split("\n");
  const after = head.split("\n");
  if (before.length !== after.length) return false;
  let inCatalog = false;
  for (const [index, line] of before.entries()) {
    const other = after[index];
    if (other === undefined) return false;
    const topLevel = /^([A-Za-z][\w-]*):/.exec(line);
    if (topLevel) inCatalog = topLevel[1] === "catalog" || topLevel[1] === "catalogs";
    if (line === other) continue;
    if (!inCatalog) return false;
    const entry = catalogEntry(line);
    const changed = catalogEntry(other);
    if (!entry || !changed || entry.key !== changed.key || entry.indent !== changed.indent) return false;
  }
  return true;
}

function catalogEntry(line: string): { indent: string; key: string } | undefined {
  // A version or range only: `npm:`, `github:`, `file:` or `link:` would swap the package itself.
  const match = /^(\s+)(['"]?[@\w./-]+['"]?):\s*(['"]?)[\^~]?\d[\w.+-]*\3\s*(#.*)?$/.exec(line);
  return match ? { indent: match[1] ?? "", key: match[2] ?? "" } : undefined;
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** One comparator of a semver range: an optional operator, then a full or partial version. */
const RANGE_PART =
  /^(?:[\^~]|[<>]=?|=)?v?(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|(?:\d+|[xX*])(?:\.(?:\d+|[xX*])){0,2})$/;

/**
 * Whether a spec names a version of the same package: a version or range, `catalog:` or
 * `workspace:`. Anything else (`npm:`, `github:`, `file:`, `link:`, a URL or a dist-tag) can bring
 * in another package, or one an attacker controls.
 */
function namesSamePackage(spec: string): boolean {
  if (/^catalog:[\w.-]*$/.test(spec) || spec.startsWith("workspace:")) return true;
  return spec.trim().split(/\s+/).every((part) => part === "||" || part === "-" || RANGE_PART.test(part));
}

/**
 * The dependencies a `package.json` declares in `head` but not in `base`, and those whose spec
 * changed to one that can name another package. Each field is compared on its own, since pnpm
 * reads a name from one field, not the last one listed. A new `workspace:` dependency names a
 * package in this repository, not a new third-party one, so it is left out. A `workspace:`
 * dependency whose spec changes to anything but `workspace:` swaps the local package for one from a
 * registry, so it counts as added.
 *
 * @returns The names, or `undefined` when either side is not a JSON object.
 */
export function addedDependencies(base: string | undefined, head: string | undefined): string[] | undefined {
  const before = base === undefined ? new Map<string, string>() : dependencyMap(base);
  const after = head === undefined ? new Map<string, string>() : dependencyMap(head);
  if (!before || !after) return undefined;
  const added = [...after].filter(([key, spec]) => {
    const was = before.get(key);
    if (was === undefined) return !spec.startsWith("workspace:");
    if (was.startsWith("workspace:") && !spec.startsWith("workspace:")) return true;
    return spec !== was && !namesSamePackage(spec);
  });
  return [...new Set(added.map(([key]) => key.slice(key.indexOf(" ") + 1)))];
}

/**
 * Manifest settings that can swap a package, the package manager or the runtime, or run code at
 * install, without declaring a dependency: the package manager and runtime pins pnpm switches to
 * (`packageManager`, `devEngines`, `engines`), the override and patch tables older pnpm, npm and
 * Yarn read from the manifest (`pnpm`, `overrides`, `resolutions`), and the install lifecycle
 * scripts, including pnpm's own `pnpm:devPreinstall`.
 */
const INSTALL_FIELDS = ["packageManager", "devEngines", "engines", "pnpm", "overrides", "resolutions"];
const INSTALL_SCRIPTS = ["pnpm:devPreinstall", "preinstall", "install", "postinstall", "preprepare", "prepare", "postprepare"];

/**
 * The install settings a `package.json` changes between `base` and `head` (see `INSTALL_FIELDS`
 * and `INSTALL_SCRIPTS`), named `pnpm`, `overrides`, `resolutions` or `scripts.<name>`.
 *
 * @returns The changed names, or `undefined` when either side is not a JSON object.
 */
export function changedInstallSettings(base: string | undefined, head: string | undefined): string[] | undefined {
  const before = base === undefined ? {} : maybeObject(maybeJson(base));
  const after = head === undefined ? {} : maybeObject(maybeJson(head));
  if (!before || !after) return undefined;
  const scriptsBefore = maybeObject(before.scripts) ?? {};
  const scriptsAfter = maybeObject(after.scripts) ?? {};
  return [
    ...INSTALL_FIELDS.filter((field) => jsonDiffers(before[field], after[field])),
    ...INSTALL_SCRIPTS.filter((name) => jsonDiffers(scriptsBefore[name], scriptsAfter[name])).map((name) => `scripts.${name}`),
  ];
}

function jsonDiffers(a: Json | undefined, b: Json | undefined): boolean {
  return JSON.stringify(a ?? null) !== JSON.stringify(b ?? null);
}

/** Every declared dependency's spec, keyed `<field> <name>`. */
function dependencyMap(text: string): Map<string, string> | undefined {
  const manifest = maybeObject(maybeJson(text));
  if (!manifest) return undefined;
  const map = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    const object = maybeObject(entries);
    if (!object) return undefined;
    for (const [name, spec] of Object.entries(object)) {
      if (typeof spec !== "string") return undefined;
      map.set(`${field} ${name}`, spec);
    }
  }
  return map;
}

/**
 * Reads a `wrangler.jsonc` in the one form the generator writes: `//` comment lines, then strict
 * JSON. Anything else a JSONC reader would accept is not read here (a comment anywhere else, a
 * trailing comma, a line break other than `\n`), so this never reads a file differently from the
 * reader that deploys it.
 *
 * @returns The value, and every string in the JSON, decoded; `undefined` for any other text.
 */
function readGeneratedConfig(text: string): { value: Json; strings: Json[] } | undefined {
  // A comment line ends at any line break, and `\r`, U+2028 and U+2029 are line breaks too.
  if (/[\r\u2028\u2029]/.test(text)) return undefined;
  const lines = text.split("\n");
  const json = lines.slice(lines.findIndex((line) => !line.startsWith("//"))).join("\n");
  const value = maybeJson(json);
  if (value === undefined) return undefined;
  // In valid JSON a quote only ever opens or closes a string, so this finds each one.
  return { value, strings: (json.match(/"(?:[^"\\]|\\.)*"/g) ?? []).map((string) => maybeJson(string) ?? null) };
}

/** A migration's keys that only add Durable Object classes. Any other operation needs a person. */
const ADDS_CLASSES = ["tag", "new_classes", "new_sqlite_classes"];

/** One Durable Object migration, as `wrangler.jsonc` holds it. */
type Migration = JsonObject;

/** What one place in a `wrangler.jsonc` (the top level, or an environment) deploys. */
interface Deployment {
  /** The Worker's `name` there, as written. */
  name: Json | undefined;
  /** Its Durable Object migrations; empty when it lists none. */
  migrations: Migration[];
}

/**
 * Reads what a `wrangler.jsonc` says about its Workers' Durable Objects, by place: `null` for the
 * top level, else an environment's name.
 *
 * `undefined` when the file is not in the generated form or a migrations list is not a list of
 * objects. Also when the file holds a `__proto__` key, which some readers turn into inherited
 * properties, or when `migrations` or `deleted_classes` occurs as a string anywhere this did not
 * read it as that key (a repeated key that a later one shadows, the word as a value or under
 * another setting): what this reads must be what any reader reads.
 */
function readWorkerConfig(text: string): Map<string | null, Deployment> | undefined {
  const config = readGeneratedConfig(text);
  const root = maybeObject(config?.value);
  const environments = root?.env === undefined ? {} : maybeObject(root.env);
  if (!config || !root || !environments) return undefined;
  const places: [string | null, Json][] = [[null, root], ...Object.entries(environments)];
  const deployments = new Map<string | null, Deployment>();
  let lists = 0;
  let deletions = 0;
  for (const [place, value] of places) {
    const holder = maybeObject(value);
    if (!holder) return undefined;
    const migrations: Migration[] = [];
    if (holder.migrations !== undefined) {
      lists++;
      if (!Array.isArray(holder.migrations)) return undefined;
      for (const entry of holder.migrations) {
        const migration = maybeObject(entry);
        if (!migration) return undefined;
        if (migration.deleted_classes !== undefined) deletions++;
        migrations.push(migration);
      }
    }
    deployments.set(place, { name: holder.name, migrations });
  }
  const occurs = (word: string) => config.strings.filter((string) => string === word).length;
  return occurs("__proto__") === 0 && occurs("migrations") === lists && occurs("deleted_classes") === deletions
    ? deployments
    : undefined;
}

/**
 * Why a `wrangler.jsonc` change needs a person for its Durable Object data. Empty when it keeps
 * each Worker's name and migrations, or only appends migrations that add classes.
 *
 * Migrations are append-only: Wrangler finds the deployed migration by the first entry with its
 * tag and applies every entry after it, by position, so a list that is reordered, retagged, edited
 * or cut, or that uses a tag twice, can run an old deletion again. Nothing here compares class
 * names between base and head, so no look-alike in the base can stand for a deletion it "already
 * made". Each reason is one of:
 * - `unreadable`: either side is not a file this reads exactly;
 * - `renames the Worker`: under a new name, at the top level or in an environment, a plain
 *   `wrangler deploy` creates a new Worker without the old one's Durable Objects;
 * - `rewrites migrations`: somewhere the head's list does not start with the base's;
 * - `appends a migration with no tag`: its `tag` is missing, empty or not a string;
 * - `reuses the tag <tag>`: an earlier migration in the same list already has it;
 * - `deletes <class>`: for each class an appended migration deletes;
 * - `<operation> in <tag>`: any other operation in an appended migration that is not adding
 *   classes (`renamed_classes`, `transferred_classes`, one this does not know).
 */
export function durableObjectRisks(base: string | undefined, head: string): string[] {
  const before = base === undefined ? new Map<string | null, Deployment>() : readWorkerConfig(base);
  const after = readWorkerConfig(head);
  if (!before || !after) return ["unreadable"];
  const risks: string[] = [];
  for (const [place, was] of before) {
    const now = after.get(place);
    if (now && !isDeepStrictEqual(was.name, now.name) && risks.length === 0) risks.push("renames the Worker");
    // Compared as values: text forms lose differences (`1e400` and `null` both print as `null`).
    if (was.migrations.some((migration, index) => !isDeepStrictEqual(migration, now?.migrations[index]))) {
      return [...risks, "rewrites migrations"];
    }
  }
  for (const [place, now] of after) {
    const kept = before.get(place)?.migrations.length ?? 0;
    const used = new Set<string>();
    for (const [index, migration] of now.migrations.entries()) {
      const tag = typeof migration.tag === "string" && migration.tag !== "" ? migration.tag : undefined;
      if (index >= kept) {
        if (tag === undefined) risks.push("appends a migration with no tag");
        else if (used.has(tag)) risks.push(`reuses the tag ${tag}`);
        for (const [operation, value] of Object.entries(migration)) {
          if (ADDS_CLASSES.includes(operation)) continue;
          if (operation === "deleted_classes" && Array.isArray(value) && value.every((name) => typeof name === "string")) {
            risks.push(...value.map((name) => `deletes ${String(name)}`));
          } else {
            risks.push(`${operation} in ${tag ?? "an untagged migration"}`);
          }
        }
      }
      if (tag !== undefined) used.add(tag);
    }
  }
  return risks;
}

/** A file whose contents, not only its diff, the classifier reads. */
export type ContentsKind = "workspace" | "manifest" | "worker-config";

/** Whether the classifier needs a file's contents, not only its diff. */
export function needsContents(filename: string): ContentsKind | undefined {
  if (filename === WORKSPACE_FILE) return "workspace";
  if (matchesPath(filename, "**/package.json")) return "manifest";
  return matchesPath(filename, DEPLOYED_CONFIG) ? "worker-config" : undefined;
}

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

/**
 * Parses `.github/maintainers`: one GitHub login per line, no `@`, no comments, blank lines ignored.
 * Matching is case-insensitive, so logins come back lowercased. A missing file, or any line that is
 * not a login, means nobody is a maintainer.
 */
export function parseMaintainers(text: string | undefined): ReadonlySet<string> {
  if (text === undefined) return new Set();
  const logins = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  if (!logins.every((login) => LOGIN.test(login))) return new Set();
  return new Set(logins.map((login) => login.toLowerCase()));
}

/** Parses the escape snapshot, or returns `undefined` when it is missing or malformed. */
export function parseEscapeSnapshot(text: string | undefined): EscapeSnapshot | undefined {
  const root = maybeObject(text === undefined ? undefined : maybeJson(text));
  const windowDays = root?.window_days;
  const files = root?.files;
  if (root?.schema !== 1 || typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 1) {
    return undefined;
  }
  if (!Array.isArray(files)) return undefined;
  const entries: EscapeEntry[] = [];
  for (const value of files) {
    const entry = maybeObject(value);
    const { path, fixed, culprit, fix } = entry ?? {};
    if (
      typeof path !== "string" || typeof culprit !== "string" || typeof fix !== "string" ||
      typeof fixed !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(fixed) || Number.isNaN(Date.parse(fixed))
    ) {
      return undefined;
    }
    entries.push({ path, fixed, culprit, fix });
  }
  return { windowDays, files: entries };
}
