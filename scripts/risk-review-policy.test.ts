import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  addedDependencies,
  classifyChangeset,
  isCatalogVersionBump,
  parseEscapeSnapshot,
  parseMaintainers,
  pathFloor,
  type ChangedFile,
  type ContentFacts,
  type EscapeSnapshot,
} from "./risk-review-policy.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const NO_FACTS: ContentFacts = { workspaceCatalogOnly: true, newDependencies: [] };
const NO_ESCAPES: EscapeSnapshot = { windowDays: 90, files: [] };

function file(filename: string, overrides: Partial<ChangedFile> = {}): ChangedFile {
  return { filename, status: "modified", additions: 1, deletions: 1, changes: 2, patch: "@@ -1 +1 @@\n-a\n+b", ...overrides };
}

function classify(files: ChangedFile[], overrides: Partial<Parameters<typeof classifyChangeset>[0]> = {}) {
  return classifyChangeset({ files, listed: true, facts: NO_FACTS, escapes: NO_ESCAPES, now: NOW, ...overrides });
}

describe("pathFloor", () => {
  it("keeps #845's high floors: the kernel, the gate, CI and release, and the chokepoints", () => {
    for (const path of [
      "packages/workshop-backend/src/overseer.ts",
      "packages/workshop-backend/README.md",
      ".github/workflows/risk-review.yml",
      "scripts/risk-review.ts",
      "scripts/release/manifest-lib.ts",
      "packages/workshop-shared/src/api.ts",
      "packages/mcp-shared/src/tools.ts",
      "packages/workshop-frontend/src/routes/connect.handoff.tsx",
    ]) {
      assert.equal(pathFloor(path), "high", path);
    }
  });

  it("puts typed-storage and every gate module at high", () => {
    for (const path of [
      "packages/typed-storage/src/index.ts",
      "scripts/risk-review-policy.ts",
      "scripts/risk-review-fixtures/merge_group.json",
      "scripts/automerge/verdict/run.ts",
    ]) {
      assert.equal(pathFloor(path), "high", path);
    }
  });

  it("puts shared UI, observability, error reporting, the approval UI, test and TS config and opencode config at medium", () => {
    for (const path of [
      "packages/ui/src/Button.tsx",
      "packages/observability/src/index.ts",
      "packages/error-reporting/src/index.ts",
      "packages/workshop-frontend/src/useResolveAction.tsx",
      "packages/workshop-frontend/src/useAutoApproval.ts",
      "packages/workshop-frontend/vitest.config.ts",
      "packages/configurator-ui/vitest.browser.config.ts",
      "packages/router/tsconfig.json",
      "tsconfig.json",
      "opencode.json",
      "packages/x/.opencode/agent.md",
      "packages/x/CLAUDE.md",
      "packages/x/.agents/skills/a.md",
    ]) {
      assert.equal(pathFloor(path), "medium", path);
    }
  });

  it("keeps #845's medium floors and leaves docs, other tests and the frontend low", () => {
    assert.equal(pathFloor("packages/gatekeeper-github/src/index.ts"), "medium");
    assert.equal(pathFloor("pnpm-lock.yaml"), "medium");
    assert.equal(pathFloor("packages/gatekeeper-x/src/.hidden.ts"), "medium");
    assert.equal(pathFloor("docs/testing.md"), "low");
    assert.equal(pathFloor("packages/workshop-frontend/src/App.tsx"), "low");
    assert.equal(pathFloor("packages/workshop-backend"), "low");
    assert.equal(pathFloor("packages/workshop-backend-old/src/x.ts"), "low");
  });
});

describe("classifyChangeset bands", () => {
  it("rates a small docs change low", () => {
    assert.deepEqual(classify([file("docs/a.md")]), { band: "low", bandReasons: [], neverAuto: [], area: "scored" });
  });

  it("rates more than 400 changed lines high", () => {
    assert.equal(classify([file("docs/a.md", { additions: 300, deletions: 101 })]).band, "high");
    assert.equal(classify([file("docs/a.md", { additions: 300, deletions: 100 })]).band, "low");
  });

  it("rates more than 20 files high", () => {
    const docs = Array.from({ length: 21 }, (_, index) => file(`docs/${index}.md`));
    assert.equal(classify(docs).band, "high");
    assert.equal(classify(docs.slice(0, 20)).band, "low");
  });

  it("rates storage, RPC and capability seams high wherever they sit", () => {
    for (const path of [
      "packages/gatekeeper-x/src/storage-schema/state.ts",
      "packages/gatekeeper-github/src/worktree-binding.d.ts",
      "packages/gatekeeper-kit/src/credential-stage.ts",
    ]) {
      assert.equal(classify([file(path)]).band, "high", path);
    }
  });

  it("rates a new dependency high", () => {
    const { band, bandReasons } = classify([file("packages/ui/package.json")], {
      facts: { ...NO_FACTS, newDependencies: ["packages/ui/package.json: left-pad"] },
    });
    assert.equal(band, "high");
    assert.match(bandReasons.join("\n"), /left-pad/);
  });

  it("raises one band for a file with an escaped defect fixed inside the window, and not after it", () => {
    const escape = { path: "packages/workshop-frontend/src/App.tsx", fixed: "2026-10-12", culprit: "#717", fix: "#742" };
    const escapes: EscapeSnapshot = { windowDays: 90, files: [escape] };
    assert.equal(classify([file("packages/workshop-frontend/src/App.tsx")], { escapes }).band, "medium");
    const medium = { windowDays: 90, files: [{ ...escape, path: "packages/ui/src/x.tsx" }] };
    assert.equal(classify([file("packages/ui/src/x.tsx")], { escapes: medium }).band, "high");
    assert.equal(classify([file("packages/workshop-frontend/src/App.tsx")], { escapes, now: new Date("2027-02-01") }).band, "low");
  });

  it("raises one band when the escape list is unreadable", () => {
    assert.equal(classify([file("docs/a.md")], { escapes: undefined }).band, "medium");
  });

  it("checks a renamed file's old path", () => {
    const rename = file("docs/preview.yml", { status: "renamed", previous_filename: ".github/workflows/preview.yml" });
    const result = classify([rename]);
    assert.equal(result.band, "high");
    assert.match(result.neverAuto.join("\n"), /\.github\/workflows\/preview\.yml → docs\/preview\.yml/);
  });

  it("rates unlisted files high and keeps them from any AI decision", () => {
    const result = classify([file("docs/a.md")], { listed: false });
    assert.equal(result.band, "high");
    assert.ok(result.neverAuto.length > 0);
  });
});

describe("classifyChangeset NEVER_AUTO", () => {
  it("covers all of .github, gate and judge code, reviewer instructions, auth, .npmrc and release", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      ".github/CODEOWNERS",
      ".github/maintainers",
      ".github/automerge-bands.json",
      ".github/dependabot.yml",
      "scripts/risk-review.ts",
      "scripts/risk-review-report.ts",
      "scripts/automerge/proofs/deps.ts",
      "scripts/contribution-policy.ts",
      "REVIEW.md",
      "AGENTS.md",
      "packages/gatekeeper-x/AGENTS.md",
      "CLAUDE.md",
      ".agents/skills/write-gatekeeper/SKILL.md",
      "packages/gatekeeper-x/.agents/skills/a.md",
      "packages/x/.npmrc",
      "opencode.jsonc",
      ".opencode/plugins/x.ts",
      "packages/workshop-backend/src/auth/config.ts",
      ".npmrc",
      "scripts/release/build-release.ts",
    ]) {
      assert.notDeepEqual(classify([file(path)]).neverAuto, [], path);
    }
  });

  it("allows pnpm-workspace.yaml only for catalog version bumps", () => {
    assert.deepEqual(classify([file("pnpm-workspace.yaml")]).neverAuto, []);
    assert.notDeepEqual(classify([file("pnpm-workspace.yaml")], { facts: { ...NO_FACTS, workspaceCatalogOnly: false } }).neverAuto, []);
  });

  it("sends a Worker config diff that adds a Durable Object class deletion to a person", () => {
    const adds = "@@ -40,2 +40,3 @@\n   { tag: 'v4', new_sqlite_classes: ['Notes'] },\n+  { tag: 'v5', deleted_classes: ['Notes'] },";
    assert.match(classify([file("packages/gatekeeper-x/cloudflare.config.ts", { patch: adds })]).neverAuto.join("\n"), /Durable Object/);
    assert.match(classify([file("packages/gatekeeper-x/wrangler.jsonc", { patch: adds.replace("deleted_classes", "deletedClasses") })]).neverAuto.join("\n"), /Durable Object/);
    // A diff the API did not inline may hold one.
    assert.notDeepEqual(classify([file("packages/gatekeeper-x/cloudflare.config.ts", { patch: undefined, changes: 9000 })]).neverAuto, []);
  });

  it("leaves a Worker config diff that only appends classes, or a deletion elsewhere, to the band", () => {
    const appends = "@@ -40,2 +40,3 @@\n   { tag: 'v4', deleted_classes: ['Old'] },\n+  { tag: 'v5', new_sqlite_classes: ['Notes'] },";
    assert.deepEqual(classify([file("packages/gatekeeper-x/cloudflare.config.ts", { patch: appends })]).neverAuto, []);
    assert.deepEqual(classify([file("docs/migrations.md", { patch: "@@ -1 +1 @@\n+deleted_classes" })]).neverAuto, []);
  });
});

describe("classifyChangeset areas", () => {
  it("keeps a non-kernel, non-high change in rung 2's scope", () => {
    assert.equal(classify([file("packages/workshop-frontend/src/App.tsx")]).area, "scored");
  });

  it("puts a small kernel change in kernel-small, and a large or seam one in kernel", () => {
    assert.equal(classify([file("packages/workshop-backend/src/agent.ts")]).area, "kernel-small");
    assert.equal(classify([file("packages/workshop-backend/src/agent.ts", { additions: 40, deletions: 11 })]).area, "kernel");
    assert.equal(classify([file("packages/workshop-backend/src/user.ts")]).area, "kernel");
    assert.equal(classify([file("packages/workshop-shared/src/api.ts")]).area, "kernel");
  });

  it("puts gatekeeper scope, OAuth and token changes, and agent declarations, in the agent-facing API area", () => {
    assert.equal(classify([file("packages/gatekeeper-x/src/x-normalize.ts")]).area, "scored");
    const scope = file("packages/gatekeeper-x/src/index.ts", { patch: "@@ -1 +1 @@\n-  scopes: [a]\n+  scopes: [a, b]" });
    assert.equal(classify([scope]).area, "agent-facing-api");
    assert.equal(classify([file("packages/gatekeeper-github/src/oauth.ts")]).area, "agent-facing-api");
    assert.equal(classify([file("packages/gatekeeper-github/src/github-types.d.ts")]).area, "agent-facing-api");
    assert.equal(classify([file("packages/gatekeeper-x/src/index.ts", { patch: undefined, changes: 9000 })]).area, "agent-facing-api");
  });

  it("puts other high-risk code in the kernel area", () => {
    assert.equal(classify([file("packages/gatekeeper-context/src/collection-access.ts")]).area, "kernel");
  });
});

describe("isCatalogVersionBump", () => {
  const base = readFileSync(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8");

  it("accepts a change to an existing catalog entry's version", () => {
    assert.equal(isCatalogVersionBump(base, base.replace("zod: ^4.6.7", "zod: ^4.7.0")), true);
    assert.equal(isCatalogVersionBump(base, base), true);
  });

  it("rejects a catalog value that swaps the package rather than its version", () => {
    for (const swap of ["npm:evil-zod@4.7.0", "github:evil/zod", "file:../zod", "link:../zod"]) {
      assert.equal(isCatalogVersionBump(base, base.replace("zod: ^4.6.7", `zod: ${swap}`)), false, swap);
    }
  });

  it("rejects a new catalog entry, a renamed one, and any change outside the catalog", () => {
    assert.equal(isCatalogVersionBump(base, base.replace("zod: ^4.6.7", "zod: ^4.6.7\n  left-pad: ^1.0.0")), false);
    assert.equal(isCatalogVersionBump(base, base.replace("zod: ^4.6.7", "zed: ^4.6.7")), false);
    assert.equal(isCatalogVersionBump(base, base.replace("'@types/node': 26.1.0", "'@types/node': 26.2.0")), false);
    assert.equal(isCatalogVersionBump("minimumReleaseAge: 1440\n", "minimumReleaseAge: 1\n"), false);
  });
});

describe("addedDependencies", () => {
  it("lists dependencies the head declares and the base does not, ignoring workspace packages", () => {
    const before = JSON.stringify({ dependencies: { zod: "catalog:" } });
    const after = JSON.stringify({
      dependencies: { zod: "catalog:", "left-pad": "^1.0.0" },
      devDependencies: { "@gadgets/ui": "workspace:*" },
    });
    assert.deepEqual(addedDependencies(before, after), ["left-pad"]);
    assert.deepEqual(addedDependencies(after, before), []);
    assert.deepEqual(addedDependencies(undefined, before), ["zod"]);
  });

  it("fails closed on a manifest it cannot read", () => {
    assert.equal(addedDependencies("{}", "{"), undefined);
    assert.equal(addedDependencies("{}", JSON.stringify({ dependencies: ["zod"] })), undefined);
  });
});

describe("parseMaintainers", () => {
  const LIST = "ndisidore\nMaximo-Guk\nAshishKumar4\nmaxwellpeterson\ndcartertwo\nkentonv\nderegtd\nFBalint\n";

  it("reads one login per line, case-insensitively, ignoring blank lines", () => {
    const maintainers = parseMaintainers(`${LIST}\n\n`);
    assert.equal(maintainers.size, 8);
    assert.ok(maintainers.has("maximo-guk"));
    assert.ok(maintainers.has("kentonv"));
  });

  it("means nobody when the file is missing or any line is not a login", () => {
    assert.equal(parseMaintainers(undefined).size, 0);
    assert.equal(parseMaintainers(`${LIST}@kentonv\n`).size, 0);
    assert.equal(parseMaintainers(`${LIST}# owners\n`).size, 0);
  });
});

describe("parseEscapeSnapshot", () => {
  it("parses the committed snapshot", () => {
    const snapshot = parseEscapeSnapshot(readFileSync(new URL("../.github/automerge-escape-files.json", import.meta.url), "utf8"));
    assert.ok(snapshot);
    assert.equal(snapshot.windowDays, 90);
    assert.ok(snapshot.files.some(({ culprit }) => culprit === "#717"));
  });

  it("rejects a malformed snapshot", () => {
    assert.equal(parseEscapeSnapshot(undefined), undefined);
    assert.equal(parseEscapeSnapshot(JSON.stringify({ schema: 1, window_days: 90, files: [{ path: "a" }] })), undefined);
    assert.equal(parseEscapeSnapshot(JSON.stringify({ schema: 2, window_days: 90, files: [] })), undefined);
  });
});
