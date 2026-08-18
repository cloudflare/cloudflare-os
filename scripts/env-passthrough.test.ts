import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

/**
 * A cached `vp` run executes each task in a clean environment: only a built-in set (`PATH`, `HOME`,
 * `CI`, ...) is forwarded, and anything else is invisible to the command *and* absent from the cache
 * fingerprint unless the task declares it in `env`. Measured, on a task declaring one variable:
 *
 *     vp run --cache <task>      declared: yes   undeclared: undefined
 *     vp run <task>              declared: yes   undeclared: undefined   (tasks cache by default)
 *     vp run --no-cache <task>   declared: yes   undeclared: yes
 *
 * So an undeclared build-time variable is silently dropped everywhere except an explicitly uncached
 * run, and the build still succeeds. This snapshot is the guard: it discovers every build-time env
 * read in the workspace and requires each one to be accounted for below, so adding a read without
 * deciding how it reaches the build fails here rather than shipping a wrongly-built artifact.
 *
 * Categories:
 *   forwarded — matched by an `env` pattern on this package's task, so it is passed *and*
 *               fingerprinted; changing it is a reported cache miss rather than a stale replay.
 *   uncached  — the task that reads it is `cache: false`, so it runs with the full ambient
 *               environment. Used where `env` would be unsound: `FORMAT_BLUEPRINTS_DIR` names a
 *               directory outside the workspace, and `env` fingerprints the value, not the contents.
 *   injected  — set explicitly by the process that spawns the build, never inherited. Stripping is
 *               correct here: `build-app.mjs` always passes `GATEKEEPER_APP_UNMINIFIED` itself
 *               precisely so an inherited value cannot turn a production build unminified.
 *   external  — read outside any vp task (release/dev tooling invoked directly), so vp never
 *               filters it.
 */
interface ExpectedArea {
  /** Matched by an `env` pattern on the task that reads it. */
  forwarded?: string[];
  /** Read by a `cache: false` task, which runs with the full ambient environment. */
  uncached?: string[];
  /** Set explicitly by the spawning process, never inherited. */
  injected?: string[];
  /** Read outside any vp task. */
  external?: string[];
}

const EXPECTED: Record<string, ExpectedArea> = {
  "packages/gatekeeper-context": {
    forwarded: ["VITE_FRONTEND_ERROR_REPORTING"],
    injected: ["GATEKEEPER_APP_UNMINIFIED"],
  },
  "packages/gatekeeper-scheduler": {
    forwarded: ["VITE_FRONTEND_ERROR_REPORTING"],
    injected: ["GATEKEEPER_APP_UNMINIFIED"],
  },
  // `env: ['VITE_*']` — vite's `define` inlines any VITE_-prefixed variable, so the set this
  // package can depend on is open-ended and the wildcard is the only honest declaration.
  "packages/workshop-frontend": {
    forwarded: [
      "VITE_BACKEND_HOST",
      "VITE_CF_ACCESS_MODE",
      "VITE_DEV_AUTO_LOGIN",
      "VITE_DEV_PASSWORD",
      "VITE_DEV_USERNAME",
      "VITE_FRONTEND_ERROR_REPORTING",
    ],
  },
  "packages/workshop-backend": {
    uncached: ["FORMAT_BLUEPRINTS_DIR"],
  },
  // `build-gatekeeper-configurator.ts` is covered in detail by
  // build-gatekeeper-configurator.test.ts, which pins its reads against the shared task's `env`.
  // `build-release.ts`, `run-local.ts` and `preview/` are invoked directly, never as vp tasks.
  scripts: {
    forwarded: ["VITE_FRONTEND_ERROR_REPORTING"],
    external: [
      "CF_ACCESS_AUD", "CF_ACCESS_ISS", "CF_AI_GATEWAY", "CF_AI_GATEWAY_ACCOUNT_ID",
      "CF_AI_GATEWAY_API_TOKEN", "CF_AI_GATEWAY_PROVIDERS", "CF_AI_GATEWAY_USE_BINDING",
      "CI_COMMIT_SHA", "CI_PIPELINE_IID", "CLOUDFLARE_ACCOUNT_ID", "CLOUDFLARE_API_TOKEN",
      "GITHUB_REPOSITORY", "GITHUB_TOKEN", "PREVIEW_ADMINS", "PREVIEW_NAME",
      "PREVIEW_PR_NUMBER", "PREVIEW_WORKERS_DEV_HOST", "PREVIEW_WRANGLER", "VITE_BACKEND_HOST",
    ],
  },
};

/**
 * The categories above, listed so a typo in one is an error rather than a silent hole. `EXPECTED` is
 * hand-maintained rather than a tool-updatable snapshot on purpose -- the point of this file is to
 * force a decision about how a new variable reaches the build, and an `--update` flag would let that
 * decision be skipped with one command. But hand-maintained means typo-prone: only the accounting
 * assertion reads every category, so `forwared:` would still balance the totals while quietly
 * exempting those variables from the check that their task declares them. Verified: before this
 * guard existed, that typo left all three assertions green.
 */
const CATEGORIES = new Set(["forwarded", "uncached", "injected", "external"]);

const SKIP = /node_modules|__tests__|\.test\.|\.wrangler|[/\\](dist|dist-app|generated)[/\\]/;
// Vite's own compile-time constants, not process environment.
const VITE_BUILTINS = new Set(["DEV", "PROD", "MODE", "SSR", "BASE_URL", "LEGACY"]);
const ENV_OBJECTS = String.raw`process\.env|import\.meta\.env|loadEnv\([^)]*\)`;
const READ_PATTERNS = [
  /process\.env\.([A-Z][A-Z0-9_]*)/g,
  // Property access on a `loadEnv()` result or on `import.meta.env`.
  /\.(VITE_[A-Z0-9_]+)/g,
  new RegExp(String.raw`(?:${ENV_OBJECTS})\[\s*["']([A-Z][A-Z0-9_]*)["']\s*\]`, "g"),
];
const DESTRUCTURE_PATTERN =
  new RegExp(String.raw`\{([^{}]*)\}\s*=\s*(?:${ENV_OBJECTS})`, "g");

function sourceFiles(directory: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (SKIP.test(path)) continue;
    if (entry.isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(mjs|ts|tsx|js)$/.test(entry.name)) out.push(path);
  }
  return out;
}

/**
 * Build-time env names read under `directory`.
 *
 * Deliberately scans raw source, comments included, where `declarationsIn` strips them: the two
 * directions of error are not symmetric. Over-discovering a read costs one line in EXPECTED, while
 * missing one is the silent bug this file exists to prevent — and stripping `//` would truncate any
 * line whose string happens to contain it. Reading a *declaration* out of a comment is the dangerous
 * direction, so only that side strips.
 */
function readsUnder(directory: string): Set<string> {
  const names = new Set<string>();
  const add = (name: string) => {
    if (/^[A-Z][A-Z0-9_]*$/.test(name) && !VITE_BUILTINS.has(name)) names.add(name);
  };
  for (const file of sourceFiles(directory)) {
    const source = readFileSync(file, "utf8");
    for (const pattern of READ_PATTERNS) {
      for (const match of source.matchAll(pattern)) add(match[1]);
    }
    for (const match of source.matchAll(DESTRUCTURE_PATTERN)) {
      for (const binding of match[1].split(",")) {
        add(binding.trim().match(/^[A-Za-z_$][A-Za-z0-9_$]*/)?.[0] ?? "");
      }
    }
  }
  return names;
}

// Comments in these files quote the very syntax being searched for — workshop-backend's explains why
// it is `cache: false` "rather than `env: ['FORMAT_BLUEPRINTS_DIR']`" — so scanning raw source both
// reads declarations out of prose and lets a deleted one keep passing. Strip comments first.
const stripComments = (source: string) =>
  source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");

/** The `env` patterns declared by any task in `directory`'s Vite+ config, and its `cache: false`. */
function declarationsIn(directory: string): { patterns: Set<string>; hasUncachedTask: boolean } {
  const patterns = new Set<string>();
  let hasUncachedTask = false;
  for (const file of readdirSync(directory).filter(name => /^vite.*\.config\.ts$/.test(name))) {
    const source = stripComments(readFileSync(join(directory, file), "utf8"));
    if (/cache:\s*false/.test(source)) hasUncachedTask = true;
    for (const block of source.matchAll(/env:\s*\[([^\]]*)\]/g)) {
      for (const entry of block[1].matchAll(/["']([A-Z0-9_*]+)["']/g)) patterns.add(entry[1]);
    }
  }
  return { patterns, hasUncachedTask };
}

const matches = (name: string, pattern: string) =>
  new RegExp(`^${pattern.split("*").map(part => part.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`)
    .test(name);

describe("build-time env passthrough", () => {
  // These double as the keys compared against EXPECTED, so they are built with `/` rather than
  // `join`, whose separator is platform-dependent. Forward slashes still resolve as paths on Windows.
  const areas = ["scripts", ...readdirSync("packages", { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => `packages/${entry.name}`)];

  it("uses only known categories", () => {
    for (const [area, groups] of Object.entries(EXPECTED)) {
      for (const category of Object.keys(groups)) {
        assert.ok(
          CATEGORIES.has(category),
          `${area} uses unknown category "${category}" in EXPECTED. Known: ` +
            `${[...CATEGORIES].join(", ")}. A misspelled category still balances the accounting ` +
            "assertion, so its variables would go unchecked.");
      }
    }
  });

  it("accounts for every build-time env read in the workspace", () => {
    const discovered = Object.fromEntries(
      areas
        .filter(area => statSync(area).isDirectory())
        .map(area => [area, [...readsUnder(area)].toSorted()])
        .filter(([, names]) => names.length > 0));

    const expected = Object.fromEntries(
      Object.entries(EXPECTED).map(([area, groups]) => [
        area,
        Object.values(groups).flat().toSorted(),
      ]));

    assert.deepEqual(
      discovered, expected,
      "the build-time env surface changed. Add each new variable to EXPECTED in this file under " +
        "the category describing how it reaches the build — and if that category is `forwarded`, " +
        "add it to the task's `env` too, or a cached run will silently drop it.");
  });

  it("declares every forwarded variable on the task that reads it", () => {
    for (const [area, groups] of Object.entries(EXPECTED)) {
      // `scripts/` holds no package config; its one forwarded read is pinned by
      // build-gatekeeper-configurator.test.ts against the shared task's `env`.
      if (area === "scripts") continue;
      const { patterns } = declarationsIn(area);
      for (const name of groups.forwarded ?? []) {
        assert.ok(
          [...patterns].some(pattern => matches(name, pattern)),
          `${area} reads ${name} at build time but no task there declares it in \`env\` ` +
            `(declared: ${[...patterns].toSorted().join(", ") || "none"}). A cached run drops it.`);
      }
    }
  });

  it("keeps the tasks behind `uncached` variables actually uncached", () => {
    for (const [area, groups] of Object.entries(EXPECTED)) {
      if (!groups.uncached?.length) continue;
      assert.ok(
        declarationsIn(area).hasUncachedTask,
        `${area} relies on an uncached task to receive ${groups.uncached.join(", ")}, but no task ` +
          "there sets `cache: false`. Either declare the variables in `env` or restore `cache: false`.");
    }
  });
});