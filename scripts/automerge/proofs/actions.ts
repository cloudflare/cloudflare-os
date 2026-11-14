#!/usr/bin/env node

// proof-actions: a Dependabot github-actions pull request that only moves existing SHA pins of
// allowlisted publishers to the commit their new release tag names.
//
// Holds when Dependabot opened it from its github-actions branch; every change is a `uses:` line
// in a workflow that swaps one full 40-character SHA pin of the same action for another, with a
// `# <tag>` comment; the publisher is on PUBLISHERS; the tag resolves to that SHA in the action's
// own repository (so the pin cannot name a commit that exists only in a fork); every touched
// workflow, as it stands at the base, holds no credential, is not a reusable workflow and runs on
// GitHub-hosted runners; and no job in any workflow at the base both holds a credential and
// restores an Actions cache (workflow.ts). A pinned action then runs with a read-only token and no
// secret, whatever its new release does, and cannot pass code through the cache to a job that holds
// one.
//
// Which workflows are producers or the gate, and so always go to a person, is the gate's list,
// not this proof's, and so is whether Dependabot wrote every commit: the gate checks each commit's
// author, committer and signature through the API, which a commit email cannot show.
//
//   node scripts/automerge/proofs/actions.ts
//   env: AUTOMERGE_HEAD_SHA, AUTOMERGE_BASE_SHA, AUTOMERGE_PR_AUTHOR, AUTOMERGE_HEAD_REF

import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { decide, notApplicable, runProducer, type Outcome } from "./artifact.ts";
import type { FileDiff } from "./diff.ts";
import { filesIn, git, pullRequestDiff } from "./git.ts";
import { DEPENDABOT_LOGIN } from "./deps.ts";
import { cacheReasons, workflowReasons } from "./workflow.ts";

const ACTIONS_BRANCH_PREFIX = "dependabot/github_actions/";

/** Owners whose actions a Dependabot bump may move without a person. */
export const PUBLISHERS = ["actions", "voidzero-dev", "getsentry"];

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;
const USES = /^(\s*-?\s*)uses: ([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)((?:\/[^@\s]+)?)@([0-9a-f]{40}) # (\S+)$/;

/** One pin a bump moves. */
export interface PinMove {
  /** `owner/repo`. */
  repo: string;
  sha: string;
  tag: string;
}

/** Everything the rules read. */
export interface ActionsInput {
  author: string;
  headRef: string;
  files: FileDiff[];
  /** What each `owner/repo@tag` resolves to in that repository: the tag object and the commit. */
  tagTargets: Record<string, string[]>;
  /** Every workflow file at the base, by path. */
  baseWorkflows: Record<string, string>;
}

/** The pin moves a diff makes, and every rule its lines break. */
export function pinMoves(files: FileDiff[]): { moves: PinMove[]; reasons: string[] } {
  const moves: PinMove[] = [];
  const reasons: string[] = [];
  for (const file of files) {
    if (!WORKFLOW.test(file.path) || file.status !== "modified" || file.binary || file.modeChanged) {
      reasons.push(`${file.path}: not an edit to an existing workflow file`);
      continue;
    }
    for (const hunk of file.hunks) {
      if (hunk.removed.length !== hunk.added.length) {
        reasons.push(`${file.path}: adds or removes lines`);
        continue;
      }
      hunk.removed.forEach((line, i) => {
        const before = USES.exec(line);
        const after = USES.exec(hunk.added[i]);
        if (!before || !after || before[1] !== after[1] || before[2] !== after[2] ||
            before[3] !== after[3] || before[4] !== after[4]) {
          reasons.push(`${file.path}: "${hunk.added[i].trim()}" is not a SHA-pin move of "${line.trim()}"`);
          return;
        }
        const owner = after[2];
        if (!PUBLISHERS.includes(owner)) reasons.push(`${file.path}: ${owner} is not an allowlisted publisher`);
        moves.push({ repo: `${owner}/${after[3]}`, sha: after[5], tag: after[6] });
      });
    }
  }
  return { moves, reasons };
}

/** Applies every rule. */
export function evaluateActions(input: ActionsInput): Outcome {
  if (input.author !== DEPENDABOT_LOGIN || !input.headRef.startsWith(ACTIONS_BRANCH_PREFIX)) {
    return notApplicable("not a Dependabot github-actions pull request",
      { author: input.author, head_ref: input.headRef });
  }
  const { moves, reasons } = pinMoves(input.files);
  if (moves.length === 0) reasons.push("moves no pin");
  for (const move of moves) {
    const targets = input.tagTargets[`${move.repo}@${move.tag}`];
    if (targets === undefined) reasons.push(`${move.repo}@${move.tag}: tag not looked up`);
    else if (!targets.includes(move.sha)) {
      reasons.push(`${move.repo}@${move.tag}: the tag does not point at ${move.sha}`);
    }
  }
  const workflows = input.files.map((file) => file.path).filter((path) => WORKFLOW.test(path));
  for (const path of workflows) {
    const text = input.baseWorkflows[path];
    if (text === undefined) reasons.push(`${path}: not at the base`);
    else for (const reason of workflowReasons(text)) reasons.push(`${path}: ${reason}`);
  }
  // Every workflow, not only the touched ones: a bumped action in a workflow with no credential can
  // still write a cache entry that a job holding one restores.
  const all = Object.keys(input.baseWorkflows).toSorted();
  if (all.length === 0) reasons.push("no workflows at the base");
  const known = new Set(all);
  for (const path of all) {
    for (const reason of cacheReasons(input.baseWorkflows[path], known)) reasons.push(`${path}: ${reason}`);
  }
  return decide(reasons, {
    moves: moves.map((move) => `${move.repo}@${move.sha} # ${move.tag}`),
    workflows_checked: workflows,
    cache_rule_checked: all,
  });
}

/** Parses `git ls-remote` output for one tag into the SHAs it names (tag object and peeled commit). */
export function tagTargetsFromLsRemote(output: string, tag: string): string[] {
  return output.split("\n")
    .map((line) => line.split("\t"))
    .filter(([, ref]) => ref === `refs/tags/${tag}` || ref === `refs/tags/${tag}^{}`)
    .map(([sha]) => sha);
}

async function main(): Promise<void> {
  await runProducer("proof", "proof-actions", async ({ head, base }) => {
    const files = pullRequestDiff(base, head);
    const tagTargets: Record<string, string[]> = {};
    for (const move of pinMoves(files).moves) {
      const output = execFileSync("git", ["ls-remote", `https://github.com/${move.repo}.git`,
        `refs/tags/${move.tag}`, `refs/tags/${move.tag}^{}`], { encoding: "utf8" });
      tagTargets[`${move.repo}@${move.tag}`] = tagTargetsFromLsRemote(output, move.tag);
    }
    return evaluateActions({
      author: process.env.AUTOMERGE_PR_AUTHOR ?? "",
      headRef: process.env.AUTOMERGE_HEAD_REF ?? "",
      files,
      tagTargets,
      baseWorkflows: Object.fromEntries(filesIn(base, ".github/workflows/")
        .filter((path) => WORKFLOW.test(path))
        .map((path) => [path, git(["show", `${base}:${path}`])])),
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
