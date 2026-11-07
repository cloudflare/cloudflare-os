import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { evaluateEquivalence } from "./equivalence.ts";
import { asArray, asObject, parseJson, type JsonObject } from "./json.ts";

// Release manifests from scripts/release/build-release.ts (2026-11-02), cut down to the router and
// gatekeeper-google: "a" and "b" are two builds of 91f4e7073, "c" is a build of c12807488, the
// commit before #951 changed gatekeeper-google's Chat card handling.
const manifest = (name: string): JsonObject =>
  asObject(parseJson(readFileSync(new URL(`./testdata/equivalence/${name}.manifest.json`, import.meta.url), "utf8")), name);

const worker = (m: JsonObject, name: string): JsonObject => asObject(asObject(m.workers, "workers")[name], name);

describe("proof-equivalence", () => {
  it("holds for two builds of one tree", () => {
    const outcome = evaluateEquivalence(manifest("a"), manifest("b"));
    assert.equal(outcome.holds, true, JSON.stringify(outcome.details));
  });

  it("fails #951, which changed gatekeeper-google's code", () => {
    const outcome = evaluateEquivalence(manifest("c"), manifest("a"));
    assert.equal(outcome.holds, false);
    assert.deepEqual(outcome.details.differences, ["workers.gatekeeper-google.modules"]);
  });

  it("fails a changed binding, var or migration with the code unchanged", () => {
    const base = manifest("a");
    const router = worker(base, "router");
    const edit = (field: string, value: JsonObject[keyof JsonObject]) =>
      ({ ...base, workers: { ...asObject(base.workers, "workers"), router: { ...router, [field]: value } } });
    assert.deepEqual(evaluateEquivalence(base, edit("bindings", [...asArray(router.bindings, "bindings"), { type: "kv_namespace", name: "EXTRA" }])).details.differences,
      ["workers.router.bindings"]);
    assert.deepEqual(evaluateEquivalence(base, edit("vars", { ...asObject(router.vars, "vars"), EXTRA: "1" })).details.differences,
      ["workers.router.vars"]);
    assert.deepEqual(evaluateEquivalence(base, edit("migrations", [{ tag: "v1", new_sqlite_classes: ["X"] }])).details.differences,
      ["workers.router.migrations"]);
  });

  it("fails a new worker and a changed asset set", () => {
    const base = manifest("a");
    const added = { ...base, workers: { ...asObject(base.workers, "workers"), extra: worker(base, "router") } };
    assert.deepEqual(evaluateEquivalence(base, added).details.differences, ["workers.extra"]);
    const assets = { ...base, assets: { ...asObject(base.assets, "assets"), ["0".repeat(32)]: { size: 1, r2Key: "assets/x" } } };
    assert.deepEqual(evaluateEquivalence(base, assets).details.differences, ["assets"]);
  });
});
