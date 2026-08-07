// Golden test for the release manifest generator, run against the repo's REAL wrangler.jsonc
// configs (with fixture bundles/assets substituted for actual builds, so no compilation is
// needed). A deliberate consequence: changing any deployable package's wrangler.jsonc fails this
// test until scripts/testdata/golden-manifest.json is regenerated — forcing a conscious decision
// about how the change reaches customer instances.
//
// Regenerate with: UPDATE_GOLDEN=1 node --test scripts/release-manifest.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { collectAssets, collectModules, stableStringify } from "./release/hash-lib.mjs";
import {
  findDeployablePackages, generateManifest, readDeployInputs, readWranglerConfig,
} from "./release/manifest-lib.mjs";

const SCRIPTS = dirname(fileURLToPath(import.meta.url));
const ROOT = join(SCRIPTS, "..");
const TESTDATA = join(SCRIPTS, "testdata");
const GOLDEN_PATH = join(TESTDATA, "golden-manifest.json");

// Placeholder syntax the deploy-side renderer understands. Closed list — see manifest-lib.mjs.
const PLACEHOLDER_RE =
    /^\$(ACCOUNT_ID|PUBLIC_BASE_URL|KV_[A-Z0-9_]+_ID|R2_[A-Z0-9_]+_NAME|WORKER_NAME\([a-z0-9-]+\)|SECRET\([A-Z0-9_]+\))/;

function buildTestManifest() {
  const workers = findDeployablePackages(join(ROOT, "packages")).map((pkg) => {
    const bundleDir = join(TESTDATA, "fixture-bundles", pkg.name);
    assert.ok(existsSync(bundleDir),
        `missing fixture bundle for new deployable package: add scripts/testdata/` +
        `fixture-bundles/${pkg.name}/ with a single .js module`);
    const { mainModule, modules } = collectModules(bundleDir);
    return {
      pkgName: pkg.name,
      config: readWranglerConfig(pkg.dir),
      mainModule,
      modules,
      deployInputs: readDeployInputs(pkg.dir),
    };
  });

  return generateManifest({
    releaseId: "r000000-fixture",
    commit: "0000000000000000000000000000000000000000",
    createdAt: "2026-01-01T00:00:00.000Z",
    wranglerVersion: "0.0.0-fixture",
    workers,
    assetVariants: {
      access: collectAssets(join(TESTDATA, "fixture-assets", "access")),
    },
  });
}

test("manifest generated from real configs matches the golden file", () => {
  const manifest = buildTestManifest();
  const rendered = stableStringify(manifest) + "\n";
  if (process.env.UPDATE_GOLDEN) {
    writeFileSync(GOLDEN_PATH, rendered);
    return;
  }
  assert.ok(existsSync(GOLDEN_PATH), "golden manifest missing; run with UPDATE_GOLDEN=1");
  assert.deepEqual(JSON.parse(rendered), JSON.parse(readFileSync(GOLDEN_PATH, "utf8")),
      "manifest changed. If the wrangler.jsonc change is intentional, verify the deploy " +
      "service handles it, then regenerate: UPDATE_GOLDEN=1 node --test " +
      "scripts/release-manifest.test.js");
});

test("every $-token in binding templates and vars uses known placeholder syntax", () => {
  const manifest = buildTestManifest();
  const check = (value, where) => {
    if (typeof value === "string") {
      for (const match of value.matchAll(/\$[A-Z_]+[A-Za-z0-9_()-]*/g)) {
        assert.match(match[0], PLACEHOLDER_RE, `unknown placeholder ${match[0]} in ${where}`);
      }
    } else if (Array.isArray(value)) {
      value.forEach((v, i) => check(v, `${where}[${i}]`));
    } else if (value && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) check(v, `${where}.${k}`);
    }
  };
  for (const [name, entry] of Object.entries(manifest.workers)) {
    check(entry.bindings, `${name}.bindings`);
    check(entry.vars, `${name}.vars`);
    check(entry.gatekeeperBindingExpansion ?? {}, `${name}.gatekeeperBindingExpansion`);
  }
});

test("worker entries carry the deploy contract", () => {
  const manifest = buildTestManifest();
  const { workers } = manifest;

  // Core workers exist with the right kinds.
  assert.equal(workers["workshop-backend"].kind, "backend");
  assert.equal(workers["router"].kind, "router");

  // Backend: provisioned resources are placeholders; gatekeeper calls use GatekeeperVendor.
  const backend = workers["workshop-backend"];
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "BLUEPRINTS"),
      { type: "kv_namespace", name: "BLUEPRINTS", namespace_id: "$KV_BLUEPRINTS_ID" });
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "BLUEPRINT_CONTENT"),
      { type: "r2_bucket", name: "BLUEPRINT_CONTENT", bucket_name: "$R2_BLUEPRINT_CONTENT_NAME" });
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "LOADER"),
      { type: "worker_loader", name: "LOADER" });
  // The Workers AI binding always ships (webFetch's toMarkdown conversion depends on it).
  assert.deepEqual(
      backend.bindings.find((b) => b.name === "WORKERS_AI"),
      { type: "ai", name: "WORKERS_AI" });
  assert.equal(backend.gatekeeperBindingExpansion.entrypoint, "GatekeeperVendor");
  assert.equal(backend.vars.PUBLIC_BASE_URL, "$PUBLIC_BASE_URL");
  // Full ordered migration history, verbatim from wrangler.jsonc.
  assert.equal(backend.migrations[0].tag, "v0");
  assert.ok(backend.migrations[0].new_sqlite_classes.includes("UserDurableObject"));

  // Router: serves the access asset variant, binds the backend by templated worker name.
  const router = workers["router"];
  assert.deepEqual(
      router.bindings.find((b) => b.name === "WORKSHOP_BACKEND"),
      { type: "service", name: "WORKSHOP_BACKEND", service: "$WORKER_NAME(workshop-backend)" });
  assert.ok(router.bindings.some((b) => b.type === "assets" && b.name === "ASSETS"));
  assert.ok(router.assetsConfig.run_worker_first.includes("/gatekeeper/*"));
  assert.equal(router.assetsConfig.not_found_handling, "single-page-application");
  assert.deepEqual(Object.keys(router.assetsConfig.variants), ["access"]);
  for (const variant of Object.values(router.assetsConfig.variants)) {
    for (const { hash } of Object.values(variant.manifest)) {
      assert.ok(manifest.assets[hash], `asset blob ${hash} missing from release index`);
      assert.equal(manifest.assets[hash].r2Key, `blobs/assets/${hash}`);
    }
  }

  // Gatekeepers: BASE_URL under the shared origin, shortName matches the router's path scan.
  const google = workers["gatekeeper-google"];
  assert.equal(google.kind, "gatekeeper");
  assert.equal(google.shortName, "google");
  assert.equal(google.vars.BASE_URL, "$PUBLIC_BASE_URL/gatekeeper/google");
  assert.ok(google.installable);
  assert.deepEqual(google.inputs.map((i) => i.name), ["CLIENT_ID", "CLIENT_SECRET"]);
  assert.deepEqual(
      google.bindings.find((b) => b.name === "CLIENT_SECRET"),
      { type: "secret_text", name: "CLIENT_SECRET", text: "$SECRET(CLIENT_SECRET)" });

  // gatekeeper-email ships in the release but is not installable (needs Email Routing/a zone).
  assert.equal(workers["gatekeeper-email"].installable, false);
  assert.deepEqual(workers["gatekeeper-email"].inputs, []);

  // gatekeeper-context: closed-beta artifacts binding is cut; its KV is a normal template and
  // no OAuth-app inputs are demanded.
  const context = workers["gatekeeper-context"];
  assert.ok(!context.bindings.some((b) => b.name === "ARTIFACTS"));
  assert.deepEqual(
      context.bindings.find((b) => b.name === "CONTEXT_COLLECTIONS"),
      { type: "kv_namespace", name: "CONTEXT_COLLECTIONS",
        namespace_id: "$KV_CONTEXT_COLLECTIONS_ID" });
  assert.deepEqual(context.inputs, []);

  // Ambient gatekeepers are preinstalled on every core deploy; preinstalls must take no
  // secret inputs (nobody is around to supply them). Both also declare an account-level agent
  // singleton, so both are install-once.
  assert.equal(context.preinstall, true);
  assert.equal(context.singleton, true);
  assert.equal(workers["gatekeeper-scheduler"].preinstall, true);
  assert.equal(workers["gatekeeper-scheduler"].singleton, true);
  assert.deepEqual(workers["gatekeeper-scheduler"].inputs, []);
  assert.equal(google.preinstall, undefined);
  assert.equal(google.singleton, undefined);
  for (const [name, entry] of Object.entries(workers)) {
    if (entry.preinstall) {
      assert.ok(entry.installable, `${name}: preinstall requires installable`);
      assert.deepEqual(entry.inputs, [], `${name}: preinstall requires no inputs`);
    }
  }

  // Module blobs are content-addressed.
  for (const [name, entry] of Object.entries(workers)) {
    assert.ok(entry.modules.some((m) => m.name === entry.mainModule),
        `${name}: mainModule not in modules list`);
    for (const mod of entry.modules) {
      assert.equal(mod.r2Key, `blobs/modules/${mod.sha256}`);
    }
  }
});

test("per-package deploy-inputs.json files are well-formed when present", () => {
  const KINDS = new Set(["secret", "var", "workerName"]);
  for (const pkg of findDeployablePackages(join(ROOT, "packages"))) {
    const inputs = readDeployInputs(pkg.dir);
    if (inputs === undefined) continue;
    assert.ok(Array.isArray(inputs), `${pkg.name}/deploy-inputs.json must be an array`);
    for (const input of inputs) {
      assert.equal(typeof input.name, "string", `${pkg.name}: input.name`);
      assert.match(input.name, /^[A-Z][A-Z0-9_]*$/, `${pkg.name}: input name ${input.name}`);
      assert.ok(KINDS.has(input.kind), `${pkg.name}: input.kind ${input.kind}`);
      assert.equal(typeof input.label, "string", `${pkg.name}: input.label`);
      for (const key of Object.keys(input)) {
        assert.ok(["name", "kind", "label", "help", "consoleUrl", "setupSteps",
          "redirectUriTemplate"].includes(key), `${pkg.name}: unknown input key ${key}`);
      }
      if (input.setupSteps !== undefined) {
        assert.ok(Array.isArray(input.setupSteps) &&
            input.setupSteps.every((s) => typeof s === "string"),
            `${pkg.name}: setupSteps must be string[]`);
      }
    }
  }
});
