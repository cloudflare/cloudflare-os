import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

import {
  addedClassDeletions,
  addedDependencies,
  changedInstallSettings,
  classifyChangeset,
  isCatalogVersionBump,
  parseEscapeSnapshot,
  parseMaintainers,
  pathFloor,
  type ChangedFile,
  type ContentFacts,
  type EscapeEntry,
  type EscapeSnapshot,
  type Json,
} from "./risk-review-policy.ts";

const NOW = new Date("2026-11-02T12:00:00Z");
const NO_FACTS: ContentFacts = { workspaceCatalogOnly: true, newDependencies: [], deletedClasses: [], skillSymlinks: [] };
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

/** An escape snapshot entry for `path`, inside the window. */
function entry(path: string): EscapeEntry {
  return { path, fixed: "2026-11-04", culprit: "#894", fix: "#1001" };
}

describe("classifyChangeset bands", () => {
  it("rates a small docs change low", () => {
    assert.deepEqual(classify([file("docs/a.md")]), { band: "low", bandReasons: [], neverAuto: [], area: "scored", workflowBump: false, readText: ["docs/a.md"] });
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

  it("ignores escape entries for lockfiles and for Markdown, docs and plans outside .agents/", () => {
    const ignored = ["pnpm-lock.yaml", "packages/gatekeeper-x/pnpm-lock.yaml", "packages/gatekeeper-kit/USAGE.md", "docs/observers.md", "plans/kernel-observer-tracking.md"];
    const escapes: EscapeSnapshot = { windowDays: 90, files: ignored.map(entry) };
    for (const path of ignored) {
      const result = classify([file(path)], { escapes });
      assert.doesNotMatch(result.bandReasons.join("\n"), /escaped defect/, path);
    }
    const skill = ".agents/skills/write-gatekeeper/SKILL.md";
    const raised = classify([file(skill)], { escapes: { windowDays: 90, files: [entry(skill)] } });
    assert.equal(raised.band, "high");
    assert.match(raised.bandReasons.join("\n"), /escaped defect/);
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
  it("scores edits under .agents/skills/ at the medium floor instead of always sending them to a person", () => {
    for (const path of [".agents/skills/write-gatekeeper/SKILL.md", ".agents/skills/frontend-conventions/references/forms.md"]) {
      const result = classify([file(path)]);
      assert.deepEqual(result.neverAuto, [], path);
      assert.equal(result.band, "medium", path);
    }
    const renamed = file(".agents/skills/x/SKILL.md", { status: "renamed", previous_filename: "AGENTS.md" });
    assert.notDeepEqual(classify([renamed]).neverAuto, []);
    for (const path of [".agents/skills/x/AGENTS.md", ".agents/skills/x/CLAUDE.md", ".agents/skills/x/.opencode/agent.md", ".agents/config.json"]) {
      assert.notDeepEqual(classify([file(path)]).neverAuto, [], path);
    }
  });

  it("sends a symlink under .agents/skills/ to a person", () => {
    const result = classify([file(".agents/skills/x/SKILL.md")], { facts: { ...NO_FACTS, skillSymlinks: [".agents/skills/x/SKILL.md"] } });
    assert.match(result.neverAuto.join("\n"), /symlink/);
  });

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
      ".agents/README.md",
      "packages/gatekeeper-x/.agents/skills/a.md",
      "packages/x/.npmrc",
      "opencode.jsonc",
      ".opencode/plugins/x.ts",
      "packages/workshop-backend/src/auth/config.ts",
      ".npmrc",
      ".pnpmfile.cjs",
      "packages/x/.pnpmfile.mjs",
      "scripts/release/build-release.ts",
    ]) {
      assert.notDeepEqual(classify([file(path)]).neverAuto, [], path);
    }
  });

  it("allows pnpm-workspace.yaml only for catalog version bumps", () => {
    assert.deepEqual(classify([file("pnpm-workspace.yaml")]).neverAuto, []);
    assert.notDeepEqual(classify([file("pnpm-workspace.yaml")], { facts: { ...NO_FACTS, workspaceCatalogOnly: false } }).neverAuto, []);
  });

  it("sends a Durable Object class deletion to a person", () => {
    const result = classify([file("packages/gatekeeper-x/cloudflare.config.ts")], {
      facts: { ...NO_FACTS, deletedClasses: ["packages/gatekeeper-x/cloudflare.config.ts: Notes"] },
    });
    assert.match(result.neverAuto.join("\n"), /Durable Object/);
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
  const base = readFileSync(new URL("./risk-review-fixtures/pnpm-workspace.yaml", import.meta.url), "utf8");

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

describe("addedClassDeletions", () => {
  const base = "migrations: [\n  { tag: 'v1', new_sqlite_classes: ['Notes', 'Drafts'] },\n  { tag: 'v2', deleted_classes: [\n    'Old',\n  ] },\n],";

  it("finds a class added to a deletion list, on its own line or in a new migration", () => {
    assert.deepEqual(addedClassDeletions(base, base.replace("    'Old',\n", "    'Old',\n    'Drafts',\n")), ["Drafts"]);
    assert.deepEqual(addedClassDeletions(base, base.replace("],", "  { tag: 'v3', deleted_classes: ['Notes'] },\n],")), ["Notes"]);
    assert.deepEqual(addedClassDeletions(undefined, "{ \"deleted_classes\": [\"Notes\"] }"), ["Notes"]);
  });

  it("finds none when only other migrations or comments change", () => {
    assert.deepEqual(addedClassDeletions(base, base.replace("],", "  { tag: 'v3', new_sqlite_classes: ['Inbox'] },\n],")), []);
    assert.deepEqual(addedClassDeletions(base, `// Old was dropped in v2.\n${base}`), []);
  });

  it("cannot read a deletion list that is not a list of string literals", () => {
    for (const list of ["DROPPED", "[...dropped]", "[CLASS_NAME]", "['Old', ...dropped]", "[`${prefix}Notes`]"]) {
      assert.equal(addedClassDeletions(base, base.replace("[\n    'Old',\n  ]", list)), undefined, list);
    }
  });
});

/** A package.json declaring zod at `spec`. */
function manifest(spec: string): string {
  return JSON.stringify({ dependencies: { zod: spec } });
}

describe("changedInstallSettings", () => {
  const base = JSON.stringify({ dependencies: { zod: "catalog:" }, scripts: { build: "vp run build", test: "vitest" } });

  it("names each install setting a manifest adds or changes", () => {
    const cases: [Record<string, Json>, string][] = [
      [{ pnpm: { overrides: { zod: "npm:evil@1.0.0" } } }, "pnpm"],
      [{ pnpm: { patchedDependencies: { zod: "patches/zod.patch" } } }, "pnpm"],
      [{ overrides: { zod: "npm:evil@1.0.0" } }, "overrides"],
      [{ resolutions: { zod: "npm:evil@1.0.0" } }, "resolutions"],
      [{ scripts: { build: "vp run build", test: "vitest", preinstall: "node x.js" } }, "scripts.preinstall"],
      [{ scripts: { build: "vp run build", test: "vitest", install: "node x.js" } }, "scripts.install"],
      [{ scripts: { build: "vp run build", test: "vitest", postinstall: "node x.js" } }, "scripts.postinstall"],
      [{ scripts: { build: "vp run build", test: "vitest", prepare: "node x.js" } }, "scripts.prepare"],
      [{ scripts: { build: "vp run build", test: "vitest", "pnpm:devPreinstall": "node x.js" } }, "scripts.pnpm:devPreinstall"],
      [{ packageManager: "pnpm@9.0.0" }, "packageManager"],
      [{ devEngines: { packageManager: { name: "pnpm", version: "9.0.0" } } }, "devEngines"],
      [{ engines: { runtime: { name: "node", version: "20.0.0" } } }, "engines"],
    ];
    for (const [change, name] of cases) {
      const head = JSON.stringify({ ...JSON.parse(base), ...change });
      assert.deepEqual(changedInstallSettings(base, head), [name], name);
    }
  });

  it("ignores other scripts and unchanged settings, and fails closed on an unreadable manifest", () => {
    const head = JSON.stringify({ dependencies: { zod: "catalog:" }, scripts: { build: "vp run build --watch", test: "vitest" } });
    assert.deepEqual(changedInstallSettings(base, head), []);
    assert.deepEqual(changedInstallSettings(base, base), []);
    assert.equal(changedInstallSettings(base, "{"), undefined);
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

  it("counts a spec changed to anything that can name another package as added", () => {
    for (const spec of ["npm:evil-zod@4.7.0", "github:evil/zod", "https://evil.example/zod.tgz", "file:../zod", "link:../zod",
      "latest", "x-evil", "4beta", "*evil", "4.7.0.tgz", "git+ssh://git@github.com/evil/zod.git"]) {
      assert.deepEqual(addedDependencies(manifest("^4.6.7"), manifest(spec)), ["zod"], spec);
    }
    for (const spec of ["^4.7.0", "4.7.0", "~4.7", ">=4.6.7 <5", "4.x", "5.0.0-beta.1", "^4 || ^5", "4.6.7 - 4.9.0", "catalog:", "catalog:next", "workspace:*"]) {
      assert.deepEqual(addedDependencies(manifest("^4.6.7"), manifest(spec)), [], spec);
    }
  });

  it("compares each dependency field on its own, so a duplicate in another field hides nothing", () => {
    const base = JSON.stringify({ dependencies: { zod: "^4.6.7" } });
    const swapped = JSON.stringify({ dependencies: { zod: "npm:evil@1.0.0" }, devDependencies: { zod: "^4.7.0" } });
    assert.deepEqual(addedDependencies(base, swapped), ["zod"]);
    const hidden = JSON.stringify({ dependencies: { zod: "^4.6.7", evil: "^1.0.0" }, devDependencies: { evil: "workspace:*" } });
    assert.deepEqual(addedDependencies(base, hidden), ["evil"]);
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
