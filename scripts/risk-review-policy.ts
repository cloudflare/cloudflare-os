// The risk-review gate's fixed rules: which band a change is in, which area it belongs to, and
// which paths always need a person. Everything here is a pure function of the changed files and of
// policy files read from the base branch, so the gate can apply it without running pull request code.
//
// Imports are limited to `node:` builtins and other `scripts/risk-review*` modules (see
// risk-review-imports.test.ts): the gate runs this file from the base branch, and a dependency
// resolved from the workspace could come from the pull request's lockfile.

import { matchesGlob } from "node:path/posix";

/** A risk band, lowest first. */
export type Band = "low" | "medium" | "high";

export const BANDS: readonly Band[] = ["low", "medium", "high"];

/**
 * Where a change may later merge without a person. `proven` is rung 1 (a proof holds, no AI);
 * `scored` is rung 2; the other three are rung 3's areas.
 */
export type Area = "proven" | "scored" | "kernel-small" | "agent-facing-api" | "kernel";

export const AREAS: readonly Area[] = ["proven", "scored", "kernel-small", "agent-facing-api", "kernel"];

/** Lines changed above which a change is high risk whatever its paths. */
export const MAX_LINES = 400;

/**
 * Files touched above which a change is high risk. Measured 2026-11-02: 3 of the 217 merged GitHub
 * pull requests with at most 400 changed lines touched more than 20 files (95th percentile: 14).
 */
export const MAX_FILES = 20;

/** Lines changed at or below which a kernel change can be in the `kernel-small` area. */
export const KERNEL_SMALL_LINES = 50;

/** A changed file, as `pulls.listFiles` returns it. */
export interface ChangedFile {
  filename: string;
  /** The path before a rename or copy, which matters as much as the new one. */
  previous_filename?: string;
  status: string;
  additions: number;
  deletions: number;
  changes: number;
  /** Absent for binary files and for diffs too large for the API to inline. */
  patch?: string;
}

/**
 * Paths that set a minimum band, highest first. High is the kernel, this gate and the rest of CI
 * and release, the supply-chain policy, and the security chokepoints REVIEW.md names outside the
 * kernel.
 */
const PATH_FLOORS: { band: Band; reason: string; globs: string[] }[] = [
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
      "REVIEW.md",
      "**/AGENTS.md",
      "**/CLAUDE.md",
      "**/.agents/**",
      "**/opencode.json",
      "**/opencode.jsonc",
      "**/.opencode/**",
    ],
  },
];

/**
 * Paths no AI may decide on, always a person: this gate and everything it reads or trusts (so a
 * pull request that an AI judges always runs `main`'s producer workflows and judge scripts), the
 * instructions AI reviewers follow, auth config, the supply-chain policy and release. Each entry
 * names its reason for the decision record. The one exception is a proven Actions bump (see
 * {@link classifyChangeset}); no AI decides that either.
 */
const NEVER_AUTO_PATHS: { reason: string; globs: string[] }[] = [
  { reason: "CI, repository policy or a producer workflow", globs: [".github/**"] },
  {
    reason: "gate or judge code",
    globs: ["scripts/risk-review*", "scripts/risk-review*/**", "scripts/automerge/**", "scripts/contribution-policy*"],
  },
  {
    reason: "instructions an AI reviewer follows",
    globs: [
      "REVIEW.md",
      "**/AGENTS.md",
      "**/CLAUDE.md",
      "**/.agents/**",
      "**/opencode.json",
      "**/opencode.jsonc",
      "**/.opencode/**",
    ],
  },
  { reason: "auth config", globs: ["packages/workshop-backend/src/auth/**"] },
  { reason: "supply-chain policy", globs: ["**/.npmrc"] },
  { reason: "release pipeline", globs: ["scripts/release/**"] },
];

/** Worker configs, which carry the Durable Object migrations. */
const WORKER_CONFIGS = ["**/cloudflare.config.ts", "**/wrangler.jsonc"];

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

const KERNEL = ["packages/workshop-backend/**", "packages/workshop-shared/src/api.ts", "packages/typed-storage/**"];

/** Declarations the agent receives as verbatim text. */
const AGENT_DECLARATIONS = [
  "packages/gatekeeper-*/src/*types.d.ts",
  "packages/mcp-shared/src/types.d.ts",
  "packages/workshop-backend/src/*-binding.d.ts",
];

const GATEKEEPER_CODE = ["packages/gatekeeper-*/src/**", "packages/mcp-shared/src/**"];

/**
 * Words in a changed gatekeeper line that put the change in rung 3's agent-facing API area: scopes,
 * resource URL patterns, auto-approvable actions, `readOnlyHint`, bindings, `describe()`,
 * auto-provisioning, request paths, OAuth and tokens. A lexical match over-approximates, so it can
 * only move a change out of rung 2, never into it.
 */
const AGENT_FACING_WORDS =
  /scope|resourceUrlPattern|autoApprovable|readOnlyHint|binding|describe\s*\(|autoProvision|createAccount|oauth|token|requestPath|urlFor|apiPath/i;

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
 * Returns the minimum band a path sets.
 *
 * @param filename Repository-relative path.
 */
export function pathFloor(filename: string): Band {
  return PATH_FLOORS.find(({ globs }) => matchesAny(filename, globs))?.band ?? "low";
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
  /** `path: class` for each Durable Object class a Worker config newly deletes, or `path: unreadable`. */
  deletedClasses: string[];
}

/** The band, area and policy reasons of one change. */
export interface Classification {
  band: Band;
  bandReasons: string[];
  /** Why no AI may decide; empty when one may. */
  neverAuto: string[];
  /** The rung 2 or rung 3 area an AI decision would come from. */
  area: Exclude<Area, "proven">;
  /** Whether the change is a proven Actions bump, exempt from the `.github/**` policy rule. */
  workflowBump: boolean;
}

/** A workflow file GitHub runs: directly under `.github/workflows/`. */
const WORKFLOW_FILE = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Classifies a change. Every rule can only raise the band or add a policy reason.
 *
 * @param input The changed files; whether `listFiles` returned every one (it stops at 3,000); what
 *     the gate read from file contents; the escape snapshot from the base branch, or `undefined` when
 *     it is missing or malformed; the time of the decision, for the escape window; and, only when
 *     Dependabot opened the pull request and its Actions proof holds, the workflows the gate reads
 *     from. Such a change is exempt from the `.github/**` rule when every changed file is an existing
 *     workflow, modified in place (not added, removed or renamed), that is not one of those.
 */
export function classifyChangeset({ files, listed, facts, escapes, now, provenActionsBump }: {
  files: ChangedFile[];
  listed: boolean;
  facts: ContentFacts;
  escapes: EscapeSnapshot | undefined;
  now: Date;
  provenActionsBump?: { gateInputs: ReadonlySet<string> };
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
      Date.parse(entry.fixed) >= since && files.some((file) => pathsOf(file).includes(entry.path)));
    if (hits.length > 0) {
      band = raiseOne(band);
      const shown = [...new Set(hits.map(({ path, culprit }) => `${path} (${culprit})`))].slice(0, 3).join(", ");
      bandReasons.push(`${band}: raised one band: touches files with a recent escaped defect (${shown})`);
    }
  }

  const workflowBump = provenActionsBump !== undefined && files.length > 0 &&
    files.every(({ filename, previous_filename, status }) =>
      status === "modified" && previous_filename === undefined && WORKFLOW_FILE.test(filename) &&
      !provenActionsBump.gateInputs.has(filename));
  for (const { reason, globs } of NEVER_AUTO_PATHS) {
    if (workflowBump && globs.includes(".github/**")) continue;
    const matched = files.filter((file) => pathsOf(file).some((path) => matchesAny(path, globs)));
    if (matched.length > 0) neverAuto.push(`${reason} (${names(matched)})`);
  }
  if (files.some((file) => pathsOf(file).includes(WORKSPACE_FILE)) && !facts.workspaceCatalogOnly) {
    neverAuto.push(`supply-chain policy (${WORKSPACE_FILE} beyond catalog versions)`);
  }
  if (facts.deletedClasses.length > 0) {
    neverAuto.push(`deletes Durable Object classes (${facts.deletedClasses.join(", ")})`);
  }

  return { band, bandReasons, neverAuto, area: areaOf(files, band, lines, seams.length > 0), workflowBump };
}

function areaOf(files: ChangedFile[], band: Band, lines: number, seam: boolean): Classification["area"] {
  const touches = (globs: readonly string[]) => files.some((file) => pathsOf(file).some((path) => matchesAny(path, globs)));
  const agentFacing = touches(AGENT_DECLARATIONS) || files.some(changesAgentFacingGatekeeperCode);
  if (touches(KERNEL)) {
    const small = lines <= KERNEL_SMALL_LINES && !seam && !agentFacing;
    return small ? "kernel-small" : "kernel";
  }
  if (agentFacing) return "agent-facing-api";
  return band === "high" ? "kernel" : "scored";
}

function changesAgentFacingGatekeeperCode(file: ChangedFile): boolean {
  if (!pathsOf(file).some((path) => matchesAny(path, GATEKEEPER_CODE))) return false;
  if (pathsOf(file).some((path) => AGENT_FACING_WORDS.test(path))) return true;
  // A diff the API did not inline is unread, so it may change anything.
  if (file.patch === undefined) return file.changes > 0;
  return file.patch.split("\n").some((line) =>
    /^[+-](?![+-]{2} )/.test(line) && AGENT_FACING_WORDS.test(line.slice(1)));
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
 * package in this repository, not a new third-party one, so it is left out.
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
    return spec !== was && !namesSamePackage(spec);
  });
  return [...new Set(added.map(([key]) => key.slice(key.indexOf(" ") + 1)))];
}

/** A JSON value, as `JSON.parse` returns it. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

/** Narrows a JSON value to an object. */
export function asObject(value: Json | undefined): { [key: string]: Json } | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

/** Parses JSON text, or returns `undefined` when it is not JSON. */
export function parseJson(text: string): Json | undefined {
  try {
    const value: Json = JSON.parse(text);
    return value;
  } catch (error) {
    // Malformed JSON is a named domain case: every caller treats it as a missing input.
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
}

/** Every declared dependency's spec, keyed `<field> <name>`. */
function dependencyMap(text: string): Map<string, string> | undefined {
  const manifest = asObject(parseJson(text));
  if (!manifest) return undefined;
  const map = new Map<string, string>();
  for (const field of DEPENDENCY_FIELDS) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    const object = asObject(entries);
    if (!object) return undefined;
    for (const [name, spec] of Object.entries(object)) {
      if (typeof spec !== "string") return undefined;
      map.set(`${field} ${name}`, spec);
    }
  }
  return map;
}

/**
 * The class names in a Worker config's Durable Object deletion lists (`deleted_classes`), the
 * migrations that drop a class's data. `undefined` when any mention of the key is not followed by a
 * list of plain string literals (a spread, an identifier, a template), since its classes cannot be
 * read.
 */
function deletedClassNames(text: string): string[] | undefined {
  const mentions = text.match(/deleted_?[cC]lasses/g)?.length ?? 0;
  const lists = [...text.matchAll(/deleted_?[cC]lasses["']?\s*:\s*\[([^\]]*)\]/g)];
  if (lists.length !== mentions) return undefined;
  const classes: string[] = [];
  for (const [, body = ""] of lists) {
    const items = body.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//g, "").split(",").map((item) => item.trim()).filter(Boolean);
    for (const item of items) {
      const name = /^(["'])([^"'\\]+)\1$/.exec(item)?.[2];
      if (name === undefined) return undefined;
      classes.push(name);
    }
  }
  return classes;
}

/**
 * The Durable Object classes a Worker config's head deletes beyond those its base already deleted,
 * however the lists are laid out.
 *
 * @returns The new names, or `undefined` when either side's deletion lists cannot be read.
 */
export function addedClassDeletions(base: string | undefined, head: string): string[] | undefined {
  const before = deletedClassNames(base ?? "");
  const after = deletedClassNames(head);
  if (!before || !after) return undefined;
  const added: string[] = [];
  for (const name of after) {
    const index = before.indexOf(name);
    if (index >= 0) before.splice(index, 1);
    else added.push(name);
  }
  return added;
}

/** A file whose contents, not only its diff, the classifier reads. */
export type ContentsKind = "workspace" | "manifest" | "worker-config";

/** Whether the classifier needs a file's contents, not only its diff. */
export function needsContents(filename: string): ContentsKind | undefined {
  if (filename === WORKSPACE_FILE) return "workspace";
  if (matchesPath(filename, "**/package.json")) return "manifest";
  return matchesAny(filename, WORKER_CONFIGS) ? "worker-config" : undefined;
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
  const root = asObject(text === undefined ? undefined : parseJson(text));
  const windowDays = root?.window_days;
  const files = root?.files;
  if (root?.schema !== 1 || typeof windowDays !== "number" || !Number.isInteger(windowDays) || windowDays < 1) {
    return undefined;
  }
  if (!Array.isArray(files)) return undefined;
  const entries: EscapeEntry[] = [];
  for (const value of files) {
    const entry = asObject(value);
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
