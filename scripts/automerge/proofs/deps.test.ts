import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  advisoriesFromOsv, DEPENDABOT_LOGIN, evaluateDeps, lockfileNames, readLockfile, workspaceReasons,
  type DepsInput, type PackageVersion,
} from "./deps.ts";
import { parseDiff, type FileDiff, type Hunk } from "./diff.ts";
import { asArray, asNumber, asObject, asString, parseJson } from "./json.ts";

// Each fixture is a real Dependabot pull request merged into main: the `git diff -U0` of its
// squash commit against its parent, the package.json files it touched at both commits, which of
// the names it adds the base lockfile already had, the registry publish times of the versions it
// adds, and the OSV querybatch response for every version it adds, removes, or moves an importer,
// catalog or snapshot entry to or from. Recorded 2026-11-02, with the versions moved to or from
// added 2026-11-06; OSV answers with what it knows on the recording day, not on the merge day.
// `<pr>.base.lock.yaml` and `<pr>.head.lock.yaml` are the pnpm-lock.yaml at both commits, cut to
// the importer, catalog, package and snapshot entries that differ (every peer variant of a changed
// snapshot kept); the entries they leave out are the same on both sides.
function fixture(name: string): DepsInput {
  const dir = new URL("./testdata/deps/", import.meta.url);
  const data = asObject(parseJson(readFileSync(new URL(`${name}.json`, dir), "utf8")), name);
  const entries: PackageVersion[] = asArray(data.osv_queries, "osv_queries").map((key) => {
    const text = asString(key, "osv query");
    const at = text.lastIndexOf("@");
    return { name: text.slice(0, at), version: text.slice(at + 1) };
  });
  const names = new Set(asArray(data.base_lock_names, "base_lock_names").map((n) => asString(n, "name")));
  const published = asObject(data.published, "published");
  return {
    author: DEPENDABOT_LOGIN,
    headRef: "dependabot/npm_and_yarn/recorded",
    files: parseDiff(readFileSync(new URL(`${name}.diff`, dir), "utf8")),
    manifests: asArray(data.manifests, "manifests").map((entry) => {
      const manifest = asObject(entry, "manifest");
      return {
        path: asString(manifest.path, "path"),
        base: manifest.base === null ? undefined : asString(manifest.base, "base"),
        head: manifest.head === null ? undefined : asString(manifest.head, "head"),
      };
    }),
    baseLockHasName: (packageName) => names.has(packageName),
    minimumReleaseAgeMinutes: asNumber(data.minimum_release_age_minutes, "minimum age"),
    published: Object.fromEntries(Object.entries(published).map(([k, v]) => [k, asString(v, k)])),
    advisories: advisoriesFromOsv(entries, data.osv_response),
    lockfiles: {
      base: readLockfile(readFileSync(new URL(`${name}.base.lock.yaml`, dir), "utf8")),
      head: readLockfile(readFileSync(new URL(`${name}.head.lock.yaml`, dir), "utf8")),
    },
    now: new Date(asString(data.now, "now")),
  };
}

function reasons(input: DepsInput): string[] {
  const outcome = evaluateDeps(input);
  return outcome.holds ? [] : asArray(outcome.details.reasons, "reasons").map((r) => asString(r, "reason"));
}

describe("proof-deps on recorded Dependabot pull requests", () => {
  it("holds for a catalog-only bump (#622 @cloudflare/workers-types)", () => {
    const outcome = evaluateDeps(fixture("pr622"));
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
    assert.deepEqual(outcome.details.added, ["@cloudflare/workers-types@5.20260924.1"]);
  });

  it("holds for a package.json bump outside the kernel (#189 terser)", () => {
    assert.deepEqual(reasons(fixture("pr189")), []);
  });

  it("holds when pnpm drops the default-registry tarball field but keeps every hash (#216)", () => {
    assert.deepEqual(reasons(fixture("pr216")), []);
  });

  it("fails #686 (@modelcontextprotocol/client 2.0.0 -> 2.2.0) on OSV advisories for both versions and zod", () => {
    const found = reasons(fixture("pr686"));
    assert.deepEqual(found.filter((r) => r.includes("OSV lists")).map((r) => r.replace(/: OSV lists .*/, "")), [
      "@modelcontextprotocol/client@2.2.0", "@modelcontextprotocol/client@2.0.0", "zod@4.6.5",
    ]);
    assert.ok(found.includes("@modelcontextprotocol/client@2.2.0: OSV lists GHSA-6prh-2h8m-c8cw"), found.join("\n"));
    assert.equal(found.length, 3, found.join("\n"));
  });

  it("fails a major bump (#629 node-html-parser 7 -> 9)", () => {
    assert.deepEqual(reasons(fixture("pr629")),
      ["packages/gatekeeper-confluence/package.json node-html-parser: ^7.1.0 -> ^9.0.4 is not a minor or patch update"]);
  });

  it("fails when the pull request also edits source (#409 styles.css)", () => {
    const found = reasons(fixture("pr409"));
    assert.ok(found.includes("packages/workshop-frontend/src/styles.css: not a manifest or the lockfile"));
  });

  it("fails when the lockfile gains a package name the base did not have (#788)", () => {
    assert.ok(reasons(fixture("pr788")).includes(
      "@codemirror/streamparser@6.0.0: a package the base lockfile does not name"));
  });

  it("fails a version younger than minimumReleaseAge", () => {
    const input = { ...fixture("pr622"), now: new Date("2026-09-24T12:00:00Z") };
    assert.deepEqual(reasons(input), [
      "@cloudflare/workers-types@5.20260924.1: published 10h ago, under minimumReleaseAge (1440 minutes)",
    ]);
  });

  it("fails closed when a version was not checked against OSV or the registry", () => {
    const input = { ...fixture("pr622"), advisories: {}, published: {} };
    assert.deepEqual(reasons(input), [
      "@cloudflare/workers-types@5.20260924.1: publish time unknown",
      "@cloudflare/workers-types@5.20260924.1: not checked against OSV",
      "@cloudflare/workers-types@5.20260903.1: not checked against OSV",
    ]);
  });

  it("does not apply to a person's pull request or a github-actions bump", () => {
    assert.equal(evaluateDeps({ ...fixture("pr622"), author: "kentonv" }).status, "not_applicable");
    assert.equal(evaluateDeps({ ...fixture("pr622"), headRef: "dependabot/github_actions/x" }).status,
      "not_applicable");
  });
});

const recorded = (name: string) => readFileSync(new URL(`./testdata/deps/${name}`, import.meta.url), "utf8");

/** One `packages:` entry, key line through its last field, from a recorded lockfile excerpt. */
function packageEntry(lockfile: string, key: string): string {
  const start = lockfile.indexOf(`\n  ${key}:\n`);
  assert.ok(start !== -1, `no ${key} in the excerpt`);
  const end = lockfile.indexOf("\n\n", start + 1);
  return lockfile.slice(start + 1, end === -1 ? undefined : end) + "\n";
}

/** `lockfile` with `entry` added at the top of its `packages:` section. */
function withPackage(lockfile: string, entry: string): string {
  assert.ok(lockfile.includes("\npackages:\n"));
  return lockfile.replace("\npackages:\n", `\npackages:\n\n${entry}`);
}

function withLockHunk(input: DepsInput, hunk: Hunk): FileDiff[] {
  return input.files.map((file) => file.path === "pnpm-lock.yaml" ? { ...file, hunks: [...file.hunks, hunk] } : file);
}

/** The key and resolution lines of a `packages:` entry, as a diff hunk shows them. */
const keyAndResolution = (text: string) => text.split("\n").slice(0, 2);

describe("lockfile rule: a version at both sides keeps what it resolves to", () => {
  // Bonk's case on #987, from recorded entries: terser@5.49.2 as #189's head locked it sits in
  // #622's lockfile, and the head re-quotes its key and gives it terser@5.49.0's integrity.
  const kept = packageEntry(recorded("pr189.head.lock.yaml"), "terser@5.49.2");
  const otherIntegrity = /integrity: ([^,}]+)/.exec(packageEntry(recorded("pr189.base.lock.yaml"), "terser@5.49.0"))?.[1] ?? "";
  const swapped = kept.replace("  terser@5.49.2:", "  'terser@5.49.2':").replace(/integrity: [^,}]+/, `integrity: ${otherIntegrity}`);

  it("fails a re-quoted key that carries another integrity", () => {
    const input = fixture("pr622");
    const tampered: DepsInput = {
      ...input,
      files: withLockHunk(input, { section: "packages:", removed: keyAndResolution(kept), added: keyAndResolution(swapped) }),
      lockfiles: {
        base: readLockfile(withPackage(recorded("pr622.base.lock.yaml"), kept)),
        head: readLockfile(withPackage(recorded("pr622.head.lock.yaml"), swapped)),
      },
    };
    assert.deepEqual(reasons(tampered), ["pnpm-lock.yaml: terser@5.49.2 keeps its version but its resolution changed"]);
  });

  // From the review of #987's fix: a column-0 comment ended the `packages:` section for the reader,
  // hiding a swapped integrity below it, though YAML still reads the entries.
  it("fails a comment, which could end a section for the reader but not for YAML", () => {
    const input = fixture("pr622");
    const head = withPackage(recorded("pr622.head.lock.yaml"), `# managed by pnpm\n${swapped.replace("'terser@5.49.2'", "terser@5.49.2")}`);
    const tampered: DepsInput = {
      ...input,
      files: withLockHunk(input, { section: "packages:", removed: [], added: ["# managed by pnpm"] }),
      lockfiles: { base: readLockfile(withPackage(recorded("pr622.base.lock.yaml"), kept)), head: readLockfile(head) },
    };
    const found = reasons(tampered);
    assert.ok(found.some((r) => /^head pnpm-lock\.yaml line \d+: a comment$/.test(r)), found.join("\n"));
    assert.ok(found.includes("pnpm-lock.yaml: terser@5.49.2 keeps its version but its resolution changed"), found.join("\n"));
  });

  it("fails a column-0 line that is not a section, and a resolution not on one line", () => {
    const view = readLockfile(`${recorded("pr622.head.lock.yaml")}- x\n`);
    assert.ok(view.problems.some((p) => p.endsWith("not a section key: - x")), view.problems.join("\n"));
    const block = readLockfile(withPackage(recorded("pr622.head.lock.yaml"), "  terser@5.49.2:\n    resolution:\n      integrity: x\n"));
    assert.ok(block.problems.some((p) => p.endsWith("terser@5.49.2: a resolution not written on one line")), block.problems.join("\n"));
  });

  it("fails a tarball moved off the default registry, keeping the integrity (#216's head)", () => {
    const input = fixture("pr216");
    const head = recorded("pr216.head.lock.yaml");
    const moved = head.replace(
      "resolution: {integrity: sha512-c3RZBmx0TqxTKAPT4PWyTgVwPcDVW+KrFmf4mKCnwWBe6OIc0vWn+wMhnaARarJz/2kvsx87tMGmNRBsCn7pUA==}",
      "resolution: {integrity: sha512-c3RZBmx0TqxTKAPT4PWyTgVwPcDVW+KrFmf4mKCnwWBe6OIc0vWn+wMhnaARarJz/2kvsx87tMGmNRBsCn7pUA==, tarball: https://evil.example/kumo-2.9.2.tgz}");
    assert.notEqual(moved, head);
    assert.deepEqual(reasons({ ...input, lockfiles: { ...input.lockfiles, head: readLockfile(moved) } }),
      ["pnpm-lock.yaml: @cloudflare/kumo@2.9.2 keeps its version but its resolution changed"]);
  });
});

describe("OSV rule: versions an importer, catalog or snapshot entry moves between", () => {
  // #686's bump as an importer-only change: 2.2.0 was already in the base lockfile and 2.0.0 stays
  // at head, so the lockfile adds and removes no package entry.
  const base = recorded("pr686.base.lock.yaml");
  const head = recorded("pr686.head.lock.yaml");
  const importerOnly = (): DepsInput => {
    const input = fixture("pr686");
    return {
      ...input,
      files: input.files.map((file) => file.path === "pnpm-lock.yaml"
        ? { ...file, hunks: file.hunks.filter((hunk) => hunk.section === "importers:") } : file),
      lockfiles: {
        base: readLockfile(withPackage(base, packageEntry(head, "'@modelcontextprotocol/client@2.2.0'"))),
        head: readLockfile(withPackage(head, packageEntry(base, "'@modelcontextprotocol/client@2.0.0'"))),
      },
    };
  };

  it("fails #686 on the advisories for both versions though no package entry changed", () => {
    const outcome = evaluateDeps(importerOnly());
    assert.deepEqual(outcome.details.added, []);
    assert.deepEqual(outcome.details.removed, []);
    const found = reasons(importerOnly());
    assert.ok(found.includes("@modelcontextprotocol/client@2.2.0: OSV lists GHSA-6prh-2h8m-c8cw"), found.join("\n"));
    assert.ok(found.some((r) => r.startsWith("@modelcontextprotocol/client@2.0.0: OSV lists")), found.join("\n"));
  });

  it("fails closed when a moved-to version was not checked against OSV", () => {
    const input = importerOnly();
    const { "@modelcontextprotocol/client@2.2.0": _checked, ...others } = input.advisories;
    assert.ok(reasons({ ...input, advisories: others }).includes("@modelcontextprotocol/client@2.2.0: not checked against OSV"));
  });

  // From the review of #987's fix: a transitive dependency moved to a version the lockfile already
  // had. #686's base snapshot of @modelcontextprotocol/core depends on zod 4.6.5 (with an advisory
  // today); the base here had it at 4.6.7, the workspace catalog's version.
  it("fails a snapshot dependency moved to a version already in the lockfile", () => {
    const input = fixture("pr686");
    const edge = "  '@modelcontextprotocol/core@2.0.0':\n    dependencies:\n      zod: 4.6.5\n";
    assert.ok(base.includes(edge));
    const moved: DepsInput = {
      ...input,
      manifests: [],
      files: [{ path: "pnpm-lock.yaml", status: "modified", binary: false, modeChanged: false,
        hunks: [{ section: "snapshots:", removed: ["      zod: 4.6.7"], added: ["      zod: 4.6.5"] }] }],
      lockfiles: { base: readLockfile(base.replace(edge, edge.replace("zod: 4.6.5", "zod: 4.6.7"))), head: readLockfile(base) },
    };
    const found = reasons(moved);
    assert.ok(found.includes("zod@4.6.5: OSV lists GHSA-mrhx-c7xc-m3w5"), found.join("\n"));
    assert.ok(found.includes("zod@4.6.7: not checked against OSV"), found.join("\n"));
  });

  it("fails a move to a version that is not a registry version", () => {
    const input = fixture("pr686");
    const git = head.replace("        version: 2.2.0\n", "        version: git+https://example.com/client.git\n");
    assert.notEqual(git, head);
    assert.ok(reasons({ ...input, lockfiles: { ...input.lockfiles, head: readLockfile(git) } }).includes(
      "pnpm-lock.yaml importers/packages/mcp-shared/dependencies/@modelcontextprotocol/client: moves to or from " +
      "git+https://example.com/client.git, not a registry version"));
  });
});

describe("pnpm-workspace.yaml rule", () => {
  it("rejects edits outside the catalog (38bd5821b added overrides and minimumReleaseAge)", () => {
    const [file] = parseDiff(readFileSync(new URL("./testdata/deps/workspace-38bd5821b.diff", import.meta.url), "utf8"));
    assert.deepEqual(workspaceReasons(file.hunks), ['pnpm-workspace.yaml: changes outside the catalog (under "overrides:")']);
  });
});

describe("lockfileNames", () => {
  it("reads package names, not importer paths, from a recorded lockfile excerpt", () => {
    const names = lockfileNames(readLockfile(readFileSync(new URL("./testdata/deps/lockfile-excerpt.yaml", import.meta.url), "utf8")));
    assert.ok(names.has("@modelcontextprotocol/client"));
    assert.ok(names.has("wrangler"));
    assert.ok(!names.has("packages/mcp-shared"));
  });
});
