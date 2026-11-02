// The contract between producer workflows and the risk-review gate. A producer (a reviewer's
// verdict, a rung 1 proof, a piece of band evidence) runs on `pull_request`, writes one JSON
// artifact, and holds no `checks: write`; the gate accepts the artifact only from a run that is
// bound to the pull request's head, and only when its JSON has the shape below. Anything else counts
// as absent, which sends the pull request to a person.

import { inflateRawSync } from "node:zlib";

import { asObject, parseJson, type Json } from "./risk-review-policy.ts";

/** A producer artifact's kind. */
export type ProducerKind = "verdict" | "proof" | "evidence";

/** Where the gate looks for a producer's runs. */
export interface Producer {
  kind: ProducerKind;
  /** The workflow file whose runs may publish it. */
  workflow: string;
  /**
   * Also accept a `workflow_run` run of `workflow` on the default branch, which runs `main`'s
   * definition when this workflow's run on the head finishes. Its artifact name carries the pull
   * request's head SHA, since the run's own head is `main`'s, and it must have been created after
   * that run's latest attempt started: a newer trigger run with no follow-up means the follow-up
   * failed or has not run, so the input is absent.
   */
  triggeredBy?: string;
}

const VERDICTS = ".github/workflows/review-verdict.yml";
/** Proofs that run no pull request code, so nothing in the head can write their artifacts. */
const PROOFS = ".github/workflows/automerge-proofs.yml";
/** Producers that build or run the head; their artifacts rest on a maintainer author. */
const EVIDENCE = ".github/workflows/automerge-evidence.yml";

/** Every producer the gate reads, by name. The artifact is `automerge-<name>`. */
export const PRODUCERS = {
  sol: { kind: "verdict", workflow: VERDICTS },
  opus: { kind: "verdict", workflow: VERDICTS },
  "proof-deps": { kind: "proof", workflow: PROOFS },
  "proof-actions": { kind: "proof", workflow: PROOFS },
  "proof-migrations": { kind: "proof", workflow: PROOFS },
  "proof-equivalence": { kind: "proof", workflow: EVIDENCE },
  "proof-tests": { kind: "proof", workflow: EVIDENCE },
  "evidence-deploy-dry-run": { kind: "evidence", workflow: EVIDENCE },
  "evidence-eval": { kind: "evidence", workflow: ".github/workflows/workshop-evals-pr.yml" },
  "evidence-consumer-build": { kind: "evidence", workflow: EVIDENCE },
  "evidence-preview-e2e": { kind: "evidence", workflow: EVIDENCE },
  "evidence-mutation": { kind: "evidence", workflow: EVIDENCE },
  "evidence-red-green": { kind: "evidence", workflow: EVIDENCE },
  "preview-smoke": { kind: "evidence", workflow: ".github/workflows/preview.yml", triggeredBy: EVIDENCE },
} as const satisfies Record<string, Producer>;

/** A producer's name. */
export type ProducerName = keyof typeof PRODUCERS;

/** Narrows a string to a producer's name. */
export function isProducerName(name: string): name is ProducerName {
  return Object.hasOwn(PRODUCERS, name);
}

/** The two reviewers whose verdicts rung 2 and rung 3 need. */
export const VERDICT_NAMES = ["sol", "opus"] as const satisfies readonly ProducerName[];

/** A reviewer verdict's configuration, which an open band pins. */
export interface Fingerprint {
  model: string;
  opencode: string;
  /** The blob SHA of the `REVIEW.md` the reviewer read. */
  review_md: string;
  /** SHA-256 of the prompt. */
  prompt: string;
}

/** A finding in a verdict. */
export interface Finding {
  severity: "P0" | "P1" | "P2" | "P3";
  title: string;
  path: string | null;
  line: number | null;
}

interface ArtifactBase {
  name: ProducerName;
  head_sha: string;
  base_sha: string;
  status: "ok" | "error" | "not_applicable";
  details: { [key: string]: Json };
}

/** A parsed producer artifact. */
export type ProducerArtifact =
  | (ArtifactBase & {
    kind: "verdict";
    findings: Finding[];
    needs_person: string[];
    /** 0 to 10; `null` only when no model ran. */
    merge_confidence: number | null;
    round: number;
    review_from_sha: string | null;
    fingerprint: Fingerprint;
  })
  | (ArtifactBase & { kind: "proof" | "evidence"; holds: boolean });

/** The result of reading one producer's input: an artifact, or why it counts as absent. */
export type ProducerInput = { artifact: ProducerArtifact } | { absent: string };

const SHA = /^[0-9a-f]{40}$/;
const STATUSES = ["ok", "error", "not_applicable"] as const;
const SEVERITIES = ["P0", "P1", "P2", "P3"] as const;

function oneOf<T extends string>(value: Json | undefined, allowed: readonly T[]): T | undefined {
  return allowed.find((option) => option === value);
}

function stringList(value: Json | undefined): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item) => typeof item === "string");
  return strings.length === value.length ? strings : undefined;
}

function isInteger(value: Json | undefined, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function parseFinding(value: Json): Finding | undefined {
  const finding = asObject(value);
  const severity = oneOf(finding?.severity, SEVERITIES);
  const { title, path, line } = finding ?? {};
  if (!severity || typeof title !== "string") return undefined;
  if (path !== null && typeof path !== "string") return undefined;
  if (line !== null && !isInteger(line, 1, Number.MAX_SAFE_INTEGER)) return undefined;
  return { severity, title, path, line };
}

/** Parses a reviewer fingerprint, or returns `undefined` when any field is missing. */
export function parseFingerprint(value: Json | undefined): Fingerprint | undefined {
  const fingerprint = asObject(value);
  const { model, opencode, review_md, prompt } = fingerprint ?? {};
  if (typeof model !== "string" || typeof opencode !== "string") return undefined;
  if (typeof review_md !== "string" || typeof prompt !== "string") return undefined;
  return { model, opencode, review_md, prompt };
}

/**
 * Parses a producer's JSON and checks it is about this pull request's head and base. Never throws.
 *
 * @param text The artifact file's contents.
 * @param expected The producer the gate asked for, and the pull request's head and base SHAs.
 */
export function parseProducerArtifact(
  text: string,
  expected: { name: ProducerName; headSha: string; baseSha: string },
): ProducerInput {
  const root = asObject(parseJson(text));
  if (!root) return { absent: "not a JSON object" };
  const { kind } = PRODUCERS[expected.name];
  if (root.schema !== 1) return { absent: "unknown schema" };
  if (root.kind !== kind) return { absent: `kind is not ${kind}` };
  if (root.name !== expected.name) return { absent: `name is not ${expected.name}` };
  const { head_sha, base_sha } = root;
  if (typeof head_sha !== "string" || !SHA.test(head_sha)) return { absent: "malformed head_sha" };
  if (typeof base_sha !== "string" || !SHA.test(base_sha)) return { absent: "malformed base_sha" };
  if (head_sha !== expected.headSha) return { absent: "made for another head commit" };
  if (base_sha !== expected.baseSha) return { absent: "made against another base commit" };
  const status = oneOf(root.status, STATUSES);
  if (!status) return { absent: "malformed status" };
  const details = asObject(root.details ?? {});
  if (!details) return { absent: "malformed details" };
  const base = { name: expected.name, head_sha, base_sha, status, details };

  if (kind !== "verdict") {
    if (typeof root.holds !== "boolean") return { absent: "malformed holds" };
    return { artifact: { ...base, kind, holds: root.holds } };
  }
  const findings = Array.isArray(root.findings) ? root.findings.map(parseFinding) : undefined;
  if (!findings) return { absent: "malformed findings" };
  const parsed = findings.filter((finding) => finding !== undefined);
  if (parsed.length !== findings.length) return { absent: "malformed finding" };
  const needsPerson = stringList(root.needs_person);
  if (!needsPerson) return { absent: "malformed needs_person" };
  const confidence = root.merge_confidence;
  if (confidence !== null && !isInteger(confidence, 0, 10)) return { absent: "malformed merge_confidence" };
  if (!isInteger(root.round, 1, Number.MAX_SAFE_INTEGER)) return { absent: "malformed round" };
  const from = root.review_from_sha;
  if (from !== null && (typeof from !== "string" || !SHA.test(from))) return { absent: "malformed review_from_sha" };
  const fingerprint = parseFingerprint(root.fingerprint);
  if (!fingerprint) return { absent: "malformed fingerprint" };
  return {
    artifact: {
      ...base,
      kind,
      findings: parsed,
      needs_person: needsPerson,
      merge_confidence: confidence,
      round: root.round,
      review_from_sha: from,
      fingerprint,
    },
  };
}

/** The fields of a workflow run, as the Actions API returns it, that the binding reads. */
export interface WorkflowRun {
  id: number;
  event: string;
  path: string;
  head_sha: string;
  head_branch: string | null;
  head_repository: { full_name: string } | null;
  status: string | null;
  conclusion: string | null;
  created_at: string;
  /** When the latest attempt started; the API describes only the latest attempt. */
  run_started_at?: string;
}

/** An artifact, as the Actions API returns it. */
export interface Artifact {
  id: number;
  name: string;
  size_in_bytes: number;
  expired: boolean;
  created_at: string | null;
  workflow_run?: { id?: number } | null;
}

/** When a run's latest attempt started; re-running an old run makes it the newest. */
export function attemptStarted(run: WorkflowRun): number {
  return Date.parse(run.run_started_at ?? run.created_at);
}

/** The run whose latest attempt started last wins, even when it failed: an older success never stands in for it. */
export function newestRun<T extends WorkflowRun>(runs: T[]): T | undefined {
  return runs.reduce<T | undefined>(
    (newest, run) =>
      !newest || attemptStarted(run) > attemptStarted(newest) ||
        (attemptStarted(run) === attemptStarted(newest) && run.id > newest.id)
        ? run
        : newest,
    undefined,
  );
}

/** What a producer's run must match: the producer, the pull request's head, this repository and its default branch. */
export interface BindingExpectation {
  producer: Producer;
  headSha: string;
  repository: string;
  defaultBranch: string;
}

/**
 * Checks that a run is one of the producer's own: from this repository, from the expected workflow
 * file, by the expected event, on the head (or, for a follow-up run, on the default branch). Only
 * such runs compete to be the newest, so an unrelated run cannot mask the producer's.
 *
 * @returns Why the run is not the producer's, or `undefined` when it is.
 */
export function identityError(run: WorkflowRun, expected: BindingExpectation): string | undefined {
  const { producer, headSha, repository, defaultBranch } = expected;
  if (run.path !== producer.workflow) return `ran from ${run.path}, not ${producer.workflow}`;
  if (run.head_repository?.full_name !== repository) return "ran from another repository";
  if (run.event === "pull_request") return run.head_sha === headSha ? undefined : "ran on another head commit";
  if (run.event === "workflow_run" && producer.triggeredBy !== undefined) {
    return run.head_branch === defaultBranch ? undefined : `ran on ${run.head_branch ?? "no branch"}, not ${defaultBranch}`;
  }
  return `ran on ${run.event}`;
}

/**
 * Checks that a run may publish a producer's artifact for this head: it is the producer's own
 * ({@link identityError}), and its latest attempt finished successfully.
 *
 * @returns Why the run is rejected, or `undefined` when it is bound.
 */
export function bindingError(run: WorkflowRun, expected: BindingExpectation): string | undefined {
  const identity = identityError(run, expected);
  if (identity) return identity;
  if (run.status !== "completed") return "still running";
  if (run.conclusion !== "success") return `concluded ${run.conclusion ?? "without a result"}`;
  return undefined;
}

/** Artifacts above this are not producer JSON. */
export const MAX_ARTIFACT_BYTES = 1_048_576;

/**
 * Picks the run's artifact for a producer: the newest one of that name made during the latest
 * attempt, so a re-run that uploaded nothing cannot pass off the earlier attempt's file.
 */
export function pickArtifact(artifacts: Artifact[], name: string, run: WorkflowRun): Artifact | undefined {
  const started = Date.parse(run.run_started_at ?? run.created_at);
  return artifacts
    .filter((artifact) =>
      artifact.name === name && !artifact.expired && artifact.size_in_bytes <= MAX_ARTIFACT_BYTES &&
      artifact.created_at !== null && Date.parse(artifact.created_at) >= started)
    .toSorted((a, b) => Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? ""))[0];
}

/**
 * Reads the one file in an artifact's zip archive. The archive must hold exactly that file.
 *
 * @returns The file's text, or why it could not be read.
 */
export function readArtifactFile(zip: Uint8Array, filename: string): { text: string } | { absent: string } {
  const data = Buffer.from(zip.buffer, zip.byteOffset, zip.byteLength);
  // The end-of-central-directory record is 22 bytes plus a comment of at most 65,535.
  const floor = Math.max(0, data.length - 22 - 65_535);
  let end = -1;
  for (let at = data.length - 22; at >= floor; at--) {
    if (data.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) return { absent: "not a zip archive" };
  if (data.readUInt16LE(end + 10) !== 1) return { absent: "the archive does not hold exactly one file" };
  const central = data.readUInt32LE(end + 16);
  if (central + 46 > data.length || data.readUInt32LE(central) !== 0x02014b50) return { absent: "corrupt archive" };
  const method = data.readUInt16LE(central + 10);
  const compressedSize = data.readUInt32LE(central + 20);
  const size = data.readUInt32LE(central + 24);
  const nameLength = data.readUInt16LE(central + 28);
  const local = data.readUInt32LE(central + 42);
  const name = data.toString("utf8", central + 46, central + 46 + nameLength);
  if (name !== filename) return { absent: `the archive holds ${name}, not ${filename}` };
  if (size > MAX_ARTIFACT_BYTES) return { absent: "the file is too large" };
  if (local + 30 > data.length || data.readUInt32LE(local) !== 0x04034b50) return { absent: "corrupt archive" };
  const start = local + 30 + data.readUInt16LE(local + 26) + data.readUInt16LE(local + 28);
  const body = data.subarray(start, start + compressedSize);
  if (body.length !== compressedSize) return { absent: "corrupt archive" };
  try {
    if (method === 0) return { text: body.toString("utf8") };
    if (method === 8) return { text: inflateRawSync(body, { maxOutputLength: MAX_ARTIFACT_BYTES }).toString("utf8") };
  } catch (error) {
    // A corrupt deflate stream is a named domain case: the input is unreadable, so absent.
    if (error instanceof Error) return { absent: `corrupt archive: ${error.message}` };
    throw error;
  }
  return { absent: `unsupported compression method ${method}` };
}
