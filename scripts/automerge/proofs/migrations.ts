#!/usr/bin/env node

// proof-migrations: Durable Object migrations only grow by appending new SQLite classes.
//
// Reads each changed `packages/*/wrangler.jsonc` at the merge base and at head. That file is
// generated from `cloudflare.config.ts` and CI checks it matches (`pnpm configs:check`), and the
// release manifest ships its `migrations` verbatim, so it is what the deploy service replays. The
// base list must be an exact prefix of the head list, and each appended step may carry only `tag`
// and `new_sqlite_classes`. Deleted classes are reported in `details.deletes` too, because a
// delete is on the never-AI policy list.
//
//   node scripts/automerge/proofs/migrations.ts   (env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA)

import { pathToFileURL } from "node:url";
import { runProducer, decide, type Outcome } from "./artifact.ts";
import type { FileDiff } from "./diff.ts";
import { fileAt, mergeBase, pullRequestDiff } from "./git.ts";
import { asArray, isObject, jsonEqual, parseJsonc, type Json } from "./json.ts";

/** One worker config at the merge base and at head; undefined where the file does not exist. */
export interface ConfigPair {
  path: string;
  base: string | undefined;
  head: string | undefined;
}

const WRANGLER_CONFIG = /^packages\/[^/]+\/wrangler\.jsonc$/;
const APPEND_KEYS = new Set(["tag", "new_sqlite_classes"]);

/** The worker configs a diff touches. */
export function changedConfigs(files: FileDiff[]): string[] {
  return files.map((file) => file.path).filter((path) => WRANGLER_CONFIG.test(path));
}

function migrationsOf(text: string | undefined, where: string): Json[] {
  if (text === undefined) return [];
  const config = parseJsonc(text);
  if (!isObject(config)) throw new Error(`${where} is not a JSON object`);
  return config.migrations === undefined ? [] : asArray(config.migrations, `${where} migrations`);
}

function stringList(value: Json | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item) => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

/** Applies the append rule to every changed config. */
export function evaluateMigrations(configs: ConfigPair[]): Outcome {
  const reasons: string[] = [];
  const deletes: string[] = [];
  const packages: Json[] = [];

  for (const { path, base, head } of configs) {
    const before = migrationsOf(base, `${path} at base`);
    const after = migrationsOf(head, `${path} at head`);
    const prefixKept = before.length <= after.length &&
      before.every((step, i) => jsonEqual(step, after[i]));
    // With the prefix broken, any head step may be new, so all of them are searched for deletes.
    const fresh = prefixKept ? after.slice(before.length) : after;
    for (const step of fresh) {
      const deleted = isObject(step) ? stringList(step.deleted_classes) : undefined;
      if (deleted) deletes.push(...deleted.map((name) => `${path}: ${name}`));
    }
    if (!prefixKept) {
      reasons.push(`${path}: the base migrations are not an exact prefix of the head migrations`);
      packages.push({ path, appended: [] });
      continue;
    }

    const knownTags = new Set(before.map((step) => isObject(step) ? step.tag : undefined));
    const tags: string[] = [];
    for (const step of fresh) {
      if (!isObject(step)) {
        reasons.push(`${path}: a migration step is not an object`);
        continue;
      }
      const extra = Object.keys(step).filter((key) => !APPEND_KEYS.has(key));
      const tag = step.tag;
      if (typeof tag !== "string" || tag === "" || knownTags.has(tag)) {
        reasons.push(`${path}: an appended step needs a new, non-empty tag`);
      } else {
        knownTags.add(tag);
        tags.push(tag);
      }
      if (extra.length > 0) {
        reasons.push(`${path}: appended step ${String(tag)} carries ${extra.join(", ")}; only ` +
          "tag and new_sqlite_classes may be appended");
      }
      const added = stringList(step.new_sqlite_classes);
      if (!added || added.length === 0) {
        reasons.push(`${path}: appended step ${String(tag)} needs a non-empty new_sqlite_classes list`);
      }
    }
    packages.push({ path, appended: tags });
  }
  return decide(reasons, { packages, deletes });
}

async function main(): Promise<void> {
  await runProducer("proof", "proof-migrations", async ({ head, base }) => {
    const from = mergeBase(base, head);
    const configs = changedConfigs(pullRequestDiff(base, head))
      .map((path) => ({ path, base: fileAt(from, path), head: fileAt(head, path) }));
    return evaluateMigrations(configs);
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
