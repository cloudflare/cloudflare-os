import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  advisoriesFromOsv, DEPENDABOT_LOGIN, evaluateDeps, lockfileNames, workspaceReasons,
  type DepsInput, type PackageVersion,
} from "./deps.ts";
import { parseDiff } from "./diff.ts";
import { asArray, asNumber, asObject, asString, parseJson } from "./json.ts";

// Each fixture is a real Dependabot pull request merged into main: the `git diff -U0` of its
// squash commit against its parent, the package.json files it touched at both commits, which of
// the names it adds the base lockfile already had, the registry publish times of the versions it
// adds, and the OSV querybatch response for every version it adds or removes. Recorded 2026-11-02.
// OSV answers with what it knows on the recording day, not on the merge day.
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
    commitEmails: asArray(data.commit_emails, "commit_emails").map((e) => asString(e, "email")),
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

  it("fails #686 (@modelcontextprotocol/client 2.0.0 -> 2.2.0) on OSV advisories for both versions", () => {
    const found = reasons(fixture("pr686"));
    assert.ok(found.includes("@modelcontextprotocol/client@2.2.0: OSV lists GHSA-6prh-2h8m-c8cw"), found.join("\n"));
    assert.ok(found.some((r) => r.startsWith("@modelcontextprotocol/client@2.0.0: OSV lists")), found.join("\n"));
    assert.equal(found.length, 2, found.join("\n"));
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

  it("fails when a person pushed a commit onto the Dependabot branch", () => {
    const input = { ...fixture("pr622"), commitEmails: [...fixture("pr622").commitEmails, "dev@example.com"] };
    assert.deepEqual(reasons(input), ["commits not written by Dependabot: 1 of 2"]);
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

describe("pnpm-workspace.yaml rule", () => {
  it("rejects edits outside the catalog (38bd5821b added overrides and minimumReleaseAge)", () => {
    const [file] = parseDiff(readFileSync(new URL("./testdata/deps/workspace-38bd5821b.diff", import.meta.url), "utf8"));
    assert.deepEqual(workspaceReasons(file.hunks), ['pnpm-workspace.yaml: changes outside the catalog (under "overrides:")']);
  });
});

describe("lockfileNames", () => {
  it("reads package names, not importer paths, from a recorded lockfile excerpt", () => {
    const names = lockfileNames(readFileSync(new URL("./testdata/deps/lockfile-excerpt.yaml", import.meta.url), "utf8"));
    assert.ok(names.has("@modelcontextprotocol/client"));
    assert.ok(names.has("wrangler"));
    assert.ok(!names.has("packages/mcp-shared"));
  });
});
