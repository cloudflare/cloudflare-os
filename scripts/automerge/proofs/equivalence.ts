#!/usr/bin/env node

// proof-equivalence: nothing that ships changed.
//
// Compares the release manifest `scripts/release/build-release.ts` writes for the merge base with
// the one it writes for head. The manifest names every worker module and static asset by content
// hash, and carries each worker's migrations, bindings, vars, compatibility settings and the
// Wrangler version, so equal manifests mean equal releases. Only the fields that name the build
// itself differ between two builds of one tree, and those are ignored (`BUILD_IDENTITY`).
//
// Two builds of one tree were measured byte-identical on 2026-11-02 (91f4e7073, three builds in
// two directories; evidence/build-research/probe-results.md).
//
//   node scripts/automerge/proofs/equivalence.ts --base <manifest.json> --head <manifest.json>
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decide, runProducer, type Outcome } from "./artifact.ts";
import { asObject, isObject, jsonEqual, parseJson, type Json, type JsonObject } from "./json.ts";

/** Manifest fields that name the build rather than what it contains. */
export const BUILD_IDENTITY = ["commit", "createdAt", "releaseId"];

/** The manifest paths that differ: `workers.<name>.<field>`, `assets`, or a top-level field. */
export function manifestDifferences(base: JsonObject, head: JsonObject): string[] {
  const differences: string[] = [];
  const keys = new Set([...Object.keys(base), ...Object.keys(head)]);
  for (const key of [...keys].toSorted()) {
    if (BUILD_IDENTITY.includes(key)) continue;
    const a: Json | undefined = base[key];
    const b: Json | undefined = head[key];
    if (key === "workers" && isObject(a) && isObject(b)) {
      const names = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const name of [...names].toSorted()) {
        const before = a[name];
        const after = b[name];
        if (!isObject(before) || !isObject(after)) {
          if (!jsonEqual(before, after)) differences.push(`workers.${name}`);
          continue;
        }
        const fields = new Set([...Object.keys(before), ...Object.keys(after)]);
        for (const field of [...fields].toSorted()) {
          if (!jsonEqual(before[field], after[field])) differences.push(`workers.${name}.${field}`);
        }
      }
    } else if (!jsonEqual(a, b)) {
      differences.push(key);
    }
  }
  return differences;
}

/** Holds when the two manifests are equal apart from `BUILD_IDENTITY`. */
export function evaluateEquivalence(base: JsonObject, head: JsonObject): Outcome {
  const differences = manifestDifferences(base, head);
  return decide(differences.map((path) => `release differs at ${path}`), { differences });
}

async function main(): Promise<void> {
  const { values } = parseArgs({ options: { base: { type: "string" }, head: { type: "string" } } });
  await runProducer("proof", "proof-equivalence", async () => {
    const { base, head } = values;
    if (!base || !head) throw new Error("--base and --head manifests are required");
    return evaluateEquivalence(
      asObject(parseJson(readFileSync(base, "utf8")), base),
      asObject(parseJson(readFileSync(head, "utf8")), head));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
