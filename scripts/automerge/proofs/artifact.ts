// The producer artifact the gate reads: one `automerge-<name>.json` per proof or evidence job. A
// producer writes one even when it fails, so the gate sees `error` rather than guessing from a
// missing file; both send the pull request to a person.

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JsonObject } from "./json.ts";

export type Kind = "proof" | "evidence";
export type Status = "ok" | "error" | "not_applicable";

/** What a producer decided. `holds` is true only with status `ok`. */
export interface Outcome {
  status: Status;
  holds: boolean;
  details: JsonObject;
}

/** The artifact file, field for field. Verdict-only fields stay empty for proofs and evidence. */
export interface Artifact {
  schema: 1;
  kind: Kind;
  name: string;
  head_sha: string;
  base_sha: string;
  status: Status;
  holds: boolean;
  details: JsonObject;
  findings: [];
  needs_person: [];
  merge_confidence: null;
  round: null;
  review_from_sha: null;
  fingerprint: null;
}

/** The proof holds. */
export function holds(details: JsonObject): Outcome {
  return { status: "ok", holds: true, details };
}

/** The proof ran and does not hold, for the listed reasons. */
export function fails(reasons: string[], details: JsonObject): Outcome {
  if (reasons.length === 0) throw new Error("a failing outcome needs at least one reason");
  return { status: "ok", holds: false, details: { ...details, reasons } };
}

/** The proof decides from `reasons`: it holds when there are none. */
export function decide(reasons: string[], details: JsonObject): Outcome {
  return reasons.length === 0 ? holds(details) : fails(reasons, details);
}

/** The proof does not apply to this pull request. */
export function notApplicable(reason: string, details: JsonObject = {}): Outcome {
  return { status: "not_applicable", holds: false, details: { ...details, reason } };
}

/** The proof could not reach a decision. */
export function errored(error: string, details: JsonObject = {}): Outcome {
  return { status: "error", holds: false, details: { ...details, error } };
}

const SHA = /^[0-9a-f]{40}$/;

/** A full commit SHA from the environment, or an error naming the variable. */
export function shaFromEnv(name: string): string {
  const value = process.env[name] ?? "";
  if (!SHA.test(value)) throw new Error(`${name} must be a full 40-character commit SHA, got "${value}"`);
  return value;
}

/** The artifact for an outcome. */
export function buildArtifact(
  kind: Kind, name: string, shas: { head: string; base: string }, outcome: Outcome,
): Artifact {
  return {
    schema: 1, kind, name, head_sha: shas.head, base_sha: shas.base,
    status: outcome.status, holds: outcome.status === "ok" && outcome.holds, details: outcome.details,
    findings: [], needs_person: [], merge_confidence: null, round: null, review_from_sha: null,
    fingerprint: null,
  };
}

/**
 * Runs one producer and writes `automerge-<name>.json` into `AUTOMERGE_OUT_DIR` (default
 * `automerge-out`), bound to `AUTOMERGE_HEAD_SHA` and `AUTOMERGE_BASE_SHA`. A thrown error becomes
 * status `error`; the process fails only when the artifact itself cannot be written.
 */
export async function runProducer(
  kind: Kind, name: string, produce: (shas: { head: string; base: string }) => Promise<Outcome>,
): Promise<void> {
  const shas = { head: shaFromEnv("AUTOMERGE_HEAD_SHA"), base: shaFromEnv("AUTOMERGE_BASE_SHA") };
  let outcome: Outcome;
  try {
    outcome = await produce(shas);
  } catch (error) {
    console.error(error);
    outcome = errored(error instanceof Error ? error.message : String(error));
  }
  const artifact = buildArtifact(kind, name, shas, outcome);
  const dir = process.env.AUTOMERGE_OUT_DIR ?? "automerge-out";
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `automerge-${name}.json`);
  writeFileSync(file, JSON.stringify(artifact, null, 2) + "\n");
  console.log(`${file}: status=${artifact.status} holds=${artifact.holds}`);
  console.log(JSON.stringify(artifact.details, null, 2));
}
