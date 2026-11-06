#!/usr/bin/env node

// proof-deps: a Dependabot npm pull request that only moves existing dependencies to mature,
// advisory-free minor or patch versions.
//
// Holds when every rule below passes:
//   - Dependabot opened it from its npm branch. Whether Dependabot wrote every commit is the
//     gate's check (author, committer and signature, through the API), not this proof's.
//   - It changes only package.json files, pnpm-lock.yaml, and catalog version lines in
//     pnpm-workspace.yaml (any other workspace key is on the never-AI list), and nothing under
//     packages/workshop-backend (the kernel).
//   - A manifest keeps its dependency names and changes only exact, caret or tilde versions, each a
//     minor or patch move (0.x moves count as breaking when the minor changes).
//   - The lockfile names no package that the base did not, and touches no section beyond
//     importers, catalogs, packages and snapshots. Every package version present at both base and
//     head keeps its integrity and resolution, read from the whole lockfile on each side.
//   - Every version the lockfile adds was published at least `minimumReleaseAge` (read from the
//     base pnpm-workspace.yaml) before now, by the registry's `time` map.
//   - OSV lists no advisory for any version the lockfile adds or removes, or that an importer or
//     catalog entry now resolves to or stopped resolving to (advisoryTargets). An advisory on the
//     old version is a security fix, and those go to a person.
//
// The preview smoke is its own artifact (`preview-smoke`, from the `preview-smoke` job in
// automerge-evidence.yml, which builds and runs the workers locally); the gate needs both.
//
//   node scripts/automerge/proofs/deps.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, AUTOMERGE_PR_AUTHOR, AUTOMERGE_HEAD_REF

import { pathToFileURL } from "node:url";
import { decide, notApplicable, runProducer, type Outcome } from "./artifact.ts";
import type { FileDiff, Hunk } from "./diff.ts";
import { fileAt, mergeBase, pullRequestDiff } from "./git.ts";
import { asArray, asObject, isObject, jsonEqual, parseJson, type Json, type JsonObject } from "./json.ts";
import { isMinorOrPatch, rangeVersion } from "./semver.ts";

export const DEPENDABOT_LOGIN = "dependabot[bot]";
const NPM_BRANCH_PREFIX = "dependabot/npm_and_yarn/";
const KERNEL = "packages/workshop-backend/";
const DEPENDENCY_MAPS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

/** A `name@version` the lockfile adds or removes. */
export interface PackageVersion {
  name: string;
  version: string;
}

/** Everything the rules read. The CLI gathers it from git, the registry and OSV. */
export interface DepsInput {
  author: string;
  headRef: string;
  files: FileDiff[];
  /** Each changed package.json at the merge base and at head. */
  manifests: { path: string; base: string | undefined; head: string | undefined }[];
  /** Whether a package name appears anywhere in the base lockfile. */
  baseLockHasName: (name: string) => boolean;
  minimumReleaseAgeMinutes: number;
  /** Publish time of each added version, from the registry. Missing means unknown. */
  published: Record<string, string>;
  /** OSV advisory ids for each of advisoryTargets. Missing means not checked. */
  advisories: Record<string, string[]>;
  /** The whole pnpm-lock.yaml at the merge base and at head. */
  lockfiles: { base: string; head: string };
  now: Date;
}

const LOCK_KEY = /^ {2}'?((?:@[^/@\s']+\/)?[^@\s'(/]+)@([^(':\s]+)(?:\(.*\))?'?:(?: \{\})?$/;
const LOCK_VERSION_LINE = /^ +(?:specifier|version): \S/;
const LOCK_INTEGRITY = /^ {4}resolution: /;
const CATALOG_ENTRY = /^ {2,4}('?)([^'\s#][^':]*)\1: (\S+)$/;

/** `name@version`, the key the registry and OSV results are filed under. */
export function versionKey({ name, version }: PackageVersion): string {
  return `${name}@${version}`;
}

/** The versions a lockfile diff adds and removes, and the lockfile rules it breaks. */
export interface LockfileChanges {
  added: PackageVersion[];
  removed: PackageVersion[];
  reasons: string[];
}

/** Reads a lockfile diff. A version both removed and added (a moved line) counts as neither. */
export function lockfileChanges(hunks: Hunk[]): LockfileChanges {
  const added = new Map<string, PackageVersion>();
  const removed = new Map<string, PackageVersion>();
  const reasons: string[] = [];
  for (const hunk of hunks) {
    const section = hunk.section.replace(/:$/, "");
    const lines = [...hunk.removed, ...hunk.added];
    if (section === "importers" || section === "catalogs") {
      const other = lines.find((line) => !LOCK_VERSION_LINE.test(line));
      if (other !== undefined) reasons.push(`pnpm-lock.yaml ${section}: unexpected change "${other.trim()}"`);
      continue;
    }
    if (section !== "packages" && section !== "snapshots") {
      reasons.push(`pnpm-lock.yaml: changes the "${section || "top"}" section`);
      continue;
    }
    // Every version has one `packages:` entry; `snapshots:` only repeats it per peer set, so a
    // snapshot key that comes or goes names no version of its own.
    const collect = (source: string[], into: Map<string, PackageVersion>) => {
      for (const line of source) {
        const key = LOCK_KEY.exec(line);
        if (!key) {
          if (/^ {2}\S/.test(line)) reasons.push(`pnpm-lock.yaml: unrecognized package key "${line.trim()}"`);
        } else if (section === "packages") {
          into.set(`${key[1]}@${key[2]}`, { name: key[1], version: key[2] });
        }
      }
    };
    collect(hunk.removed, removed);
    collect(hunk.added, added);
  }
  for (const key of added.keys()) {
    if (removed.delete(key)) added.delete(key);
  }
  return { added: [...added.values()], removed: [...removed.values()], reasons };
}

/** One importer or catalog dependency: its name, specifier and locked version. */
interface Pin {
  name: string;
  specifier: string;
  version: string;
}

/** A lockfile, as far as the whole-file rules read it. */
export interface LockfileView {
  /** Each `packages:` entry's resolution, keyed by `name@version`. */
  resolutions: Map<string, string>;
  /** Each importer and catalog dependency, keyed by where it is declared. */
  pins: Map<string, Pin>;
  /** Package keys listed twice, which no rule could then read as one entry. */
  duplicates: string[];
}

const NESTED_KEY = /^( *)('?)([^']+?)\2:(?: (.*))?$/;

function unquote(value: string): string {
  return /^'.*'$/.test(value) ? value.slice(1, -1).replaceAll("''", "'") : value;
}

/** Reads the importers, catalogs and packages sections of a whole pnpm-lock.yaml. */
export function readLockfile(text: string): LockfileView {
  const view: LockfileView = { resolutions: new Map(), pins: new Map(), duplicates: [] };
  let section = "";
  const path: string[] = [];
  let pkg = "";
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, "");
      continue;
    }
    if (section === "packages") {
      const key = /^ {2}\S/.test(line) ? LOCK_KEY.exec(line) : null;
      if (key) {
        pkg = `${key[1]}@${key[2]}`;
        if (view.resolutions.has(pkg)) view.duplicates.push(pkg);
        view.resolutions.set(pkg, "");
      } else if (LOCK_INTEGRITY.test(line) && pkg !== "") {
        view.resolutions.set(pkg, line.replace(LOCK_INTEGRITY, "").trim());
      }
      continue;
    }
    if (section !== "importers" && section !== "catalogs") continue;
    const match = NESTED_KEY.exec(line);
    if (!match) continue;
    // importers: <importer>/<group>/<name> at indents 2, 4, 6; catalogs: <catalog>/<name> at 2, 4.
    const depth = match[1].length / 2 - 1;
    const fieldDepth = section === "importers" ? 3 : 2;
    if (depth < fieldDepth) {
      path.length = depth;
      path[depth] = match[3];
      continue;
    }
    if (depth !== fieldDepth || path.length !== fieldDepth) continue;
    const where = `${section}/${path.join("/")}`;
    const pin = view.pins.get(where) ?? { name: path[fieldDepth - 1], specifier: "", version: "" };
    if (match[3] === "specifier") pin.specifier = unquote(match[4] ?? "");
    if (match[3] === "version") pin.version = unquote(match[4] ?? "");
    view.pins.set(where, pin);
  }
  return view;
}

/** The registry version a pin locks, or undefined for a workspace link or a local file. */
function pinnedVersion(pin: Pin): PackageVersion | undefined {
  const version = pin.version.replace(/\(.*$/, "");
  if (/^(link|file|workspace):/.test(version)) return undefined;
  const alias = /^((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(version);
  if (alias) return { name: alias[1], version: alias[2] };
  const npm = /^npm:((?:@[^/@]+\/)?[^@]+)@/.exec(pin.specifier);
  return { name: npm ? npm[1] : pin.name, version };
}

/**
 * A resolution with pnpm's default-registry `tarball:` field dropped, which pnpm writes or leaves
 * out without the package changing (#216).
 */
function normalResolution(key: string, resolution: string): string {
  const at = key.lastIndexOf("@");
  const name = key.slice(0, at);
  const tarball = `https://registry.npmjs.org/${name}/-/${name.replace(/^@[^/]+\//, "")}-${key.slice(at + 1)}.tgz`;
  return resolution.replace(`, tarball: ${tarball}}`, "}");
}

/** Every package version at both base and head whose resolution or integrity is not the same. */
export function retainedPackageReasons(base: LockfileView, head: LockfileView): string[] {
  const reasons = [...base.duplicates, ...head.duplicates].map((key) => `pnpm-lock.yaml: ${key} is listed twice`);
  for (const [key, after] of head.resolutions) {
    const before = base.resolutions.get(key);
    if (before !== undefined && normalResolution(key, before) !== normalResolution(key, after)) {
      reasons.push(`pnpm-lock.yaml: ${key} keeps its version but its resolution changed`);
    }
  }
  return reasons;
}

/** The registry versions importer and catalog entries stopped and started resolving to. */
export interface PinMoves {
  from: PackageVersion[];
  to: PackageVersion[];
  reasons: string[];
}

/**
 * What a pin locks, compared by `name@version`: a version string's peer suffix can change while the
 * package version stays the same. A non-registry version compares as written.
 */
function locked(pin: Pin | undefined): string | undefined {
  const version = pin === undefined ? undefined : pinnedVersion(pin);
  return version === undefined ? pin?.version : versionKey(version);
}

/** Where an importer or catalog entry locks a different version at head, the version each side locks. */
export function pinMoves(base: LockfileView, head: LockfileView): PinMoves {
  const from = new Map<string, PackageVersion>();
  const to = new Map<string, PackageVersion>();
  const reasons: string[] = [];
  const record = (where: string, pin: Pin | undefined, into: Map<string, PackageVersion>) => {
    if (pin === undefined) return;
    const version = pinnedVersion(pin);
    if (version === undefined) reasons.push(`pnpm-lock.yaml ${where}: moves to or from ${pin.version}, not a registry version`);
    else into.set(versionKey(version), version);
  };
  for (const where of new Set([...base.pins.keys(), ...head.pins.keys()])) {
    const before = base.pins.get(where);
    const after = head.pins.get(where);
    if (locked(before) === locked(after)) continue;
    record(where, before, from);
    record(where, after, to);
  }
  return { from: [...from.values()], to: [...to.values()], reasons };
}

/** The versions OSV must be asked about: every version added, removed, or moved to or from. */
export function advisoryTargets(lock: LockfileChanges, moves: PinMoves): PackageVersion[] {
  const targets = new Map<string, PackageVersion>();
  for (const entry of [...lock.added, ...lock.removed, ...moves.from, ...moves.to]) targets.set(versionKey(entry), entry);
  return [...targets.values()];
}

/** Every rule a pnpm-workspace.yaml diff breaks: anything but a catalog entry's version. */
export function workspaceReasons(hunks: Hunk[]): string[] {
  const reasons: string[] = [];
  for (const hunk of hunks) {
    if (hunk.section !== "catalog:" && hunk.section !== "catalogs:") {
      reasons.push(`pnpm-workspace.yaml: changes outside the catalog (under "${hunk.section || "top"}")`);
      continue;
    }
    if (hunk.removed.length !== hunk.added.length) {
      reasons.push("pnpm-workspace.yaml: adds or removes catalog lines");
      continue;
    }
    hunk.removed.forEach((line, i) => {
      const before = CATALOG_ENTRY.exec(line);
      const after = CATALOG_ENTRY.exec(hunk.added[i]);
      if (!before || !after || before[2] !== after[2]) {
        reasons.push(`pnpm-workspace.yaml: "${hunk.added[i].trim()}" is not a version change of "${line.trim()}"`);
        return;
      }
      reasons.push(...versionMoveReasons(`catalog ${after[2]}`, before[3], after[3]));
    });
  }
  return reasons;
}

function versionMoveReasons(what: string, from: string, to: string): string[] {
  const a = rangeVersion(from);
  const b = rangeVersion(to);
  if (!a || !b) return [`${what}: ${from} -> ${to} is not an exact, caret or tilde version`];
  if (from.replace(/[\d.]+.*$/, "") !== to.replace(/[\d.]+.*$/, "")) {
    return [`${what}: ${from} -> ${to} changes the range operator`];
  }
  return isMinorOrPatch(a, b) ? [] : [`${what}: ${from} -> ${to} is not a minor or patch update`];
}

/** Every rule a package.json change breaks. */
export function manifestReasons(path: string, base: string | undefined, head: string | undefined): string[] {
  if (base === undefined || head === undefined) return [`${path}: added or deleted`];
  const before = asObject(parseJson(base), `${path} at base`);
  const after = asObject(parseJson(head), `${path} at head`);
  const reasons: string[] = [];
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) {
    if (!DEPENDENCY_MAPS.includes(key)) {
      if (!jsonEqual(before[key], after[key])) reasons.push(`${path}: changes "${key}"`);
      continue;
    }
    const from = before[key] ?? {};
    const to = after[key] ?? {};
    if (!isObject(from) || !isObject(to)) {
      reasons.push(`${path}: "${key}" is not an object`);
      continue;
    }
    const names = new Set([...Object.keys(from), ...Object.keys(to)]);
    for (const name of names) {
      const a: Json | undefined = from[name];
      const b: Json | undefined = to[name];
      if (a === b) continue;
      if (typeof a !== "string" || typeof b !== "string") {
        reasons.push(`${path}: ${key} adds or removes ${name}`);
        continue;
      }
      reasons.push(...versionMoveReasons(`${path} ${name}`, a, b));
    }
  }
  return reasons;
}

/** The base workspace's `minimumReleaseAge`, in minutes. */
export function minimumReleaseAge(workspaceYaml: string): number {
  const match = /^minimumReleaseAge: (\d+)\s*$/m.exec(workspaceYaml);
  if (!match) throw new Error("pnpm-workspace.yaml at base sets no minimumReleaseAge");
  return Number(match[1]);
}

/** Applies every rule. */
export function evaluateDeps(input: DepsInput): Outcome {
  if (input.author !== DEPENDABOT_LOGIN || !input.headRef.startsWith(NPM_BRANCH_PREFIX)) {
    return notApplicable("not a Dependabot npm pull request", { author: input.author, head_ref: input.headRef });
  }
  const reasons: string[] = [];

  let lock: LockfileChanges = { added: [], removed: [], reasons: [] };
  for (const file of input.files) {
    if (file.path.startsWith(KERNEL)) reasons.push(`${file.path}: under the kernel`);
    if (file.binary || file.modeChanged) reasons.push(`${file.path}: binary or mode change`);
    if (file.path === "pnpm-lock.yaml") {
      lock = lockfileChanges(file.hunks);
      reasons.push(...lock.reasons);
    } else if (file.path === "pnpm-workspace.yaml") {
      reasons.push(...workspaceReasons(file.hunks));
    } else if (file.path !== "package.json" && !file.path.endsWith("/package.json")) {
      reasons.push(`${file.path}: not a manifest or the lockfile`);
    }
  }
  for (const { path, base, head } of input.manifests) reasons.push(...manifestReasons(path, base, head));
  const baseLock = readLockfile(input.lockfiles.base);
  const headLock = readLockfile(input.lockfiles.head);
  reasons.push(...retainedPackageReasons(baseLock, headLock));
  const moves = pinMoves(baseLock, headLock);
  reasons.push(...moves.reasons);

  const removedNames = new Set(lock.removed.map((entry) => entry.name));
  const ageMs = input.minimumReleaseAgeMinutes * 60_000;
  const ages: JsonObject = {};
  for (const entry of lock.added) {
    const key = versionKey(entry);
    if (!removedNames.has(entry.name) && !input.baseLockHasName(entry.name)) {
      reasons.push(`${key}: a package the base lockfile does not name`);
    }
    const published = input.published[key];
    const at = published === undefined ? Number.NaN : Date.parse(published);
    if (Number.isNaN(at)) {
      reasons.push(`${key}: publish time unknown`);
      continue;
    }
    const hours = Math.floor((input.now.getTime() - at) / 3_600_000);
    ages[key] = hours;
    if (input.now.getTime() - at < ageMs) {
      reasons.push(`${key}: published ${hours}h ago, under minimumReleaseAge (${input.minimumReleaseAgeMinutes} minutes)`);
    }
  }
  const osv: JsonObject = {};
  for (const entry of advisoryTargets(lock, moves)) {
    const key = versionKey(entry);
    const ids = input.advisories[key];
    if (ids === undefined) {
      reasons.push(`${key}: not checked against OSV`);
    } else if (ids.length > 0) {
      osv[key] = ids;
      reasons.push(`${key}: OSV lists ${ids.join(", ")}`);
    }
  }
  return decide(reasons, {
    added: lock.added.map(versionKey),
    removed: lock.removed.map(versionKey),
    moved_from: moves.from.map(versionKey),
    moved_to: moves.to.map(versionKey),
    age_hours: ages,
    advisories: osv,
    minimum_release_age_minutes: input.minimumReleaseAgeMinutes,
    smoke: "separate artifact: preview-smoke",
  });
}

/** The package names a lockfile's `packages:` section lists. */
export function lockfileNames(lockfile: string): Set<string> {
  const names = new Set<string>();
  let inPackages = false;
  for (const line of lockfile.split("\n")) {
    if (/^\S/.test(line)) inPackages = line === "packages:";
    else if (inPackages) {
      const key = LOCK_KEY.exec(line);
      if (key) names.add(key[1]);
    }
  }
  return names;
}

/** Publish times for `entries`, from each package's full registry document. */
export async function fetchPublishTimes(entries: PackageVersion[]): Promise<Record<string, string>> {
  const times: Record<string, string> = {};
  for (const name of new Set(entries.map((entry) => entry.name))) {
    const response = await fetch(`https://registry.npmjs.org/${name.replaceAll("/", "%2f")}`);
    if (!response.ok) throw new Error(`registry.npmjs.org answered ${response.status} for ${name}`);
    const time = asObject(asObject(parseJson(await response.text()), name).time, `${name} time`);
    for (const entry of entries) {
      const at = entry.name === name ? time[entry.version] : undefined;
      if (typeof at === "string") times[versionKey(entry)] = at;
    }
  }
  return times;
}

/** OSV advisory ids for `entries`, from one `querybatch` call. */
export async function fetchAdvisories(entries: PackageVersion[]): Promise<Record<string, string[]>> {
  if (entries.length === 0) return {};
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: entries.map(({ name, version }) => ({ package: { ecosystem: "npm", name }, version })),
    }),
  });
  if (!response.ok) throw new Error(`api.osv.dev answered ${response.status}`);
  return advisoriesFromOsv(entries, parseJson(await response.text()));
}

/** Maps an OSV `querybatch` response back onto the entries it was asked about, in order. */
export function advisoriesFromOsv(entries: PackageVersion[], body: Json): Record<string, string[]> {
  const results = asArray(asObject(body, "OSV response").results, "OSV results");
  if (results.length !== entries.length) throw new Error("OSV returned a different number of results");
  const advisories: Record<string, string[]> = {};
  entries.forEach((entry, i) => {
    const result = asObject(results[i], "OSV result");
    if (result.next_page_token !== undefined) throw new Error(`OSV paged the result for ${versionKey(entry)}`);
    const vulns = result.vulns === undefined ? [] : asArray(result.vulns, "OSV vulns");
    advisories[versionKey(entry)] = vulns.map((vuln) => {
      const id = asObject(vuln, "OSV vuln").id;
      if (typeof id !== "string") throw new Error("OSV vuln without an id");
      return id;
    });
  });
  return advisories;
}

async function main(): Promise<void> {
  await runProducer("proof", "proof-deps", async ({ head, base }) => {
    const from = mergeBase(base, head);
    const files = pullRequestDiff(base, head);
    const lockFile = files.find((file) => file.path === "pnpm-lock.yaml");
    const lock = lockfileChanges(lockFile?.hunks ?? []);
    const workspace = fileAt(from, "pnpm-workspace.yaml");
    const baseLock = fileAt(from, "pnpm-lock.yaml");
    const headLock = fileAt(head, "pnpm-lock.yaml");
    if (workspace === undefined || baseLock === undefined) throw new Error("base has no pnpm workspace");
    if (headLock === undefined) throw new Error("head has no pnpm-lock.yaml");
    const baseNames = lockfileNames(baseLock);
    const lockfiles = { base: baseLock, head: headLock };
    return evaluateDeps({
      author: process.env.AUTOMERGE_PR_AUTHOR ?? "",
      headRef: process.env.AUTOMERGE_HEAD_REF ?? "",
      files,
      manifests: files
        .filter((file) => file.path === "package.json" || file.path.endsWith("/package.json"))
        .map(({ path }) => ({ path, base: fileAt(from, path), head: fileAt(head, path) })),
      baseLockHasName: (name) => baseNames.has(name),
      minimumReleaseAgeMinutes: minimumReleaseAge(workspace),
      published: await fetchPublishTimes(lock.added),
      advisories: await fetchAdvisories(advisoryTargets(lock, pinMoves(readLockfile(baseLock), readLockfile(headLock)))),
      lockfiles,
      now: new Date(),
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
