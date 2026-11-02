#!/usr/bin/env node

// Decides whether .github/workflows/automerge-evidence.yml may start the jobs that hold a secret
// (consumer-build, preview-e2e) for this pull request. They may only when its head branch is in
// this repository, its author is not a bot, the author is listed in `.github/maintainers` at the
// base SHA, and the author still has write access. A missing or malformed maintainers file trusts
// nobody. The gate credits these jobs only for a maintainer's pull request, so starting them for
// anyone else would expose the secrets and buy nothing.
//
// Never fails the job: any error is written as `trusted=false`, so the dependent jobs are skipped
// and their evidence is absent.
//
//   node scripts/automerge/evidence/trust.ts
//   env: AUTOMERGE_BASE_SHA, PR_AUTHOR, PR_AUTHOR_TYPE, HEAD_REPO_ID, BASE_REPO_ID, GITHUB_TOKEN,
//        GITHUB_REPOSITORY, GITHUB_OUTPUT

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { fileAt } from "../proofs/git.ts";
import { isObject, parseJson } from "../proofs/json.ts";

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
const WRITE = ["admin", "maintain", "write"];

/** The maintainers file's logins, lowercased; empty when it is missing or any line is malformed. */
export function maintainers(text: string | undefined): Set<string> {
  if (text === undefined) return new Set();
  const logins = text.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  return logins.every((login) => LOGIN.test(login)) ? new Set(logins.map((login) => login.toLowerCase())) : new Set();
}

/** What the decision reads about the pull request. */
export interface Author {
  login: string;
  type: string;
  headRepoId: string;
  baseRepoId: string;
}

/** Why the author is not trusted with the secret-holding jobs, or undefined when they are. */
export function untrusted(author: Author, listed: Set<string>, permission: string | undefined): string | undefined {
  if (author.headRepoId === "" || author.headRepoId !== author.baseRepoId) return "the head branch is not in this repository";
  if (author.type !== "User") return `the author is a ${author.type || "account of unknown type"}, not a person`;
  if (!listed.has(author.login.toLowerCase())) return `${author.login} is not in .github/maintainers at the base`;
  if (permission === undefined || !WRITE.includes(permission)) return `${author.login} has ${permission ?? "no"} permission, not write`;
  return undefined;
}

async function permissionOf(repository: string, login: string): Promise<string | undefined> {
  const response = await fetch(`https://api.github.com/repos/${repository}/collaborators/${encodeURIComponent(login)}/permission`, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${process.env.GITHUB_TOKEN ?? ""}`, "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!response.ok) return undefined;
  const body = parseJson(await response.text());
  return isObject(body) && typeof body.permission === "string" ? body.permission : undefined;
}

async function main(): Promise<void> {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) throw new Error("GITHUB_OUTPUT is required");
  let reason: string | undefined;
  try {
    const author: Author = {
      login: process.env.PR_AUTHOR ?? "", type: process.env.PR_AUTHOR_TYPE ?? "",
      headRepoId: process.env.HEAD_REPO_ID ?? "", baseRepoId: process.env.BASE_REPO_ID ?? "",
    };
    const base = process.env.AUTOMERGE_BASE_SHA ?? "";
    if (!/^[0-9a-f]{40}$/.test(base)) throw new Error("AUTOMERGE_BASE_SHA is not a commit SHA");
    if (!LOGIN.test(author.login)) throw new Error("PR_AUTHOR is not a GitHub login");
    const listed = maintainers(fileAt(base, ".github/maintainers"));
    reason = untrusted(author, listed, await permissionOf(process.env.GITHUB_REPOSITORY ?? "", author.login));
  } catch (error) {
    reason = error instanceof Error ? error.message : String(error);
  }
  console.log(reason === undefined ? "trusted" : `not trusted: ${reason}`);
  appendFileSync(output, `trusted=${reason === undefined}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
