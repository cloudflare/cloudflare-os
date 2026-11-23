// The producer artifact the gate reads: one `automerge-<name>.json` per job. A producer writes one
// even when it fails, so the gate sees `error` rather than guessing from a missing file; both send
// the pull request to a person.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "../json.ts";
import { PRODUCERS, SHA, artifactName, type ProducerName } from "../producers.ts";

/** Where every producer job writes its artifact, and its workflow uploads it from. */
const OUT_DIR = "automerge-out";

/** What a producer decided. `holds` is true only with status `ok`. */
export interface Outcome {
  status: "ok" | "error" | "not_applicable";
  holds: boolean;
  details: JsonObject;
}

/** The proof decides from `reasons`: it holds when there are none. */
export function decide(reasons: string[], details: JsonObject): Outcome {
  return reasons.length === 0
    ? { status: "ok", holds: true, details }
    : { status: "ok", holds: false, details: { ...details, reasons } };
}

/** The proof does not apply to this pull request. */
export function notApplicable(reason: string, details: JsonObject = {}): Outcome {
  return { status: "not_applicable", holds: false, details: { ...details, reason } };
}

/** The proof could not reach a decision. */
export function errored(error: string, details: JsonObject = {}): Outcome {
  return { status: "error", holds: false, details: { ...details, error } };
}

/** A full commit SHA from the environment, or an error naming the variable. */
function shaFromEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (!SHA.test(value)) throw new Error(`${name} must be a full 40-character commit SHA, got "${value}"`);
  return value;
}

/**
 * Runs one producer and writes its artifact's file into `automerge-out`, bound to
 * `AUTOMERGE_HEAD_SHA` and `AUTOMERGE_BASE_SHA`. A thrown error becomes status `error`; the
 * process fails only when the artifact itself cannot be written.
 */
export async function runProducer(
  name: ProducerName, produce: (shas: { head: string; base: string }) => Promise<Outcome>,
): Promise<void> {
  const shas = { head: shaFromEnv("AUTOMERGE_HEAD_SHA"), base: shaFromEnv("AUTOMERGE_BASE_SHA") };
  let outcome: Outcome;
  try {
    outcome = await produce(shas);
  } catch (error) {
    console.error(error);
    outcome = errored(error instanceof Error ? error.message : String(error));
  }
  const artifact = {
    schema: 1, kind: PRODUCERS[name].kind, name, head_sha: shas.head, base_sha: shas.base,
    status: outcome.status, holds: outcome.status === "ok" && outcome.holds, details: outcome.details,
  };
  mkdirSync(OUT_DIR, { recursive: true });
  const file = join(OUT_DIR, `${artifactName(name)}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`${file}: status=${artifact.status} holds=${artifact.holds}`);
  console.log(JSON.stringify(artifact.details, null, 2));
}
