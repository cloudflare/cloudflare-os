#!/usr/bin/env node

// Kenton's weekly sample of rung 3: lists the pull requests merged in the past seven days that the
// risk-review gate let through a rung 3 area (`kernel-small`, `agent-facing-api`, `kernel`) without
// a person, samples up to SAMPLE_SIZE of them and files one issue for a person to read.
//
// It does nothing while rung 3 is closed: when `.github/automerge-bands.json` on the default
// branch is missing, is not in enforce mode, or opens no band in a rung 3 area. A pull request
// counts as auto-merged when the newest `risk-review` check run the gate's App posted on its head
// records, in enforce mode, an `auto` decision through a rung 3 area. The sample is the same for
// a rerun in the same week: pull requests are ordered by a hash of the week and their number.
//
//   node scripts/automerge/evidence/weekly-sample.ts
//   env: GITHUB_TOKEN, GITHUB_REPOSITORY, RISK_REVIEW_APP_ID, SAMPLE_ASSIGNEE (optional),
//        SAMPLE_NOW (optional ISO time, for a rerun of a past week)

import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import { asArray, asNumber, asObject, asString, isObject, parseJson, type Json, type JsonObject } from "../proofs/json.ts";

/** The areas whose auto-merges this samples. */
export const RUNG3_AREAS = ["kernel-small", "agent-facing-api", "kernel"];
const BANDS = ["low", "medium", "high"];
const BANDS_FILE = ".github/automerge-bands.json";
export const SAMPLE_SIZE = 5;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Why rung 3 is closed, or undefined when some rung 3 band is open in enforce mode. */
export function rung3Closed(bandsText: string | undefined): string | undefined {
  if (bandsText === undefined) return `${BANDS_FILE} is missing`;
  let root: Json;
  try {
    root = parseJson(bandsText);
  } catch {
    return `${BANDS_FILE} is not JSON`;
  }
  if (!isObject(root) || root.schema !== 1) return `${BANDS_FILE} is not schema 1`;
  if (root.mode !== "enforce") return `mode is ${JSON.stringify(root.mode ?? null)}, not enforce`;
  const areas = isObject(root.areas) ? root.areas : {};
  const open = RUNG3_AREAS.some((area) => {
    const bands = areas[area];
    return isObject(bands) && BANDS.some((band) => {
      const rule = bands[band];
      return isObject(rule) && rule.open === true;
    });
  });
  return open ? undefined : "no rung 3 band is open";
}

/** The decision JSON a `risk-review` check run's summary leads with, or undefined. */
export function decisionFromSummary(summary: string): JsonObject | undefined {
  const match = /^```json\n(.*)\n```/s.exec(summary);
  if (!match) return undefined;
  try {
    const value = parseJson(match[1]);
    return isObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

/** A merged pull request the gate let through rung 3. */
export interface AutoMerged {
  number: number;
  title: string;
  url: string;
  area: string;
  band: string;
}

/** The rung 3 auto decision a decision record holds for pull request `number`, if any. */
export function rung3Decision(record: JsonObject, number: number): { area: string; band: string } | undefined {
  if (record.mode !== "enforce" || !Array.isArray(record.pulls)) return undefined;
  for (const entry of record.pulls) {
    if (!isObject(entry) || entry.number !== number || !isObject(entry.would)) continue;
    const { decision, area } = entry.would;
    // `would` is eligibility; the merge was the gate's own only if its rule passed with no person's
    // approval counted.
    const gatePassed = isObject(entry.gate) && entry.gate.passes === true;
    const noApprover = Array.isArray(entry.approvers) && entry.approvers.length === 0;
    if (decision === "auto" && gatePassed && noApprover && typeof area === "string" && RUNG3_AREAS.includes(area)) {
      return { area, band: typeof entry.band === "string" ? entry.band : "unknown" };
    }
  }
  return undefined;
}

/** Up to `size` pull requests, the same ones for every run in the week starting `weekStart`. */
export function sample(pulls: AutoMerged[], weekStart: string, size = SAMPLE_SIZE): AutoMerged[] {
  const key = (pull: AutoMerged) => createHash("sha256").update(`${weekStart}:${pull.number}`).digest("hex");
  return pulls.toSorted((a, b) => key(a).localeCompare(key(b))).slice(0, size).toSorted((a, b) => a.number - b.number);
}

/**
 * The issue for a week's sample. `unreadable` are merged pull requests with no `risk-review` decision
 * the sampler could read: whether they merged without a person is unknown, so they are listed for
 * a person to check rather than counted either way.
 */
export function issueFor(
  weekStart: string, weekEnd: string, all: AutoMerged[], picked: AutoMerged[], unreadable: number[],
): { title: string; body: string } {
  return {
    title: `Rung 3 weekly sample: ${weekStart} to ${weekEnd}`,
    body: [
      `${all.length} pull request(s) merged without a person through a rung 3 area between ${weekStart} and ${weekEnd}. ` +
      `This samples ${picked.length}. Read each one as a reviewer would, and say here whether it should have needed a person.`,
      "",
      ...picked.map((pull) => `- [ ] #${pull.number} ${pull.title} (${pull.area}, ${pull.band})`),
      ...(unreadable.length > 0
        ? ["", `No readable risk-review decision, so whether a person approved is unknown: ${unreadable.map((n) => `#${n}`).join(", ")}.`]
        : []),
      "",
      "Filed by `.github/workflows/automerge-weekly-sample.yml`.",
    ].join("\n"),
  };
}

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function github(path: string, options: { accept?: string; method?: string; body?: string } = {}): Promise<Response> {
  const response = await fetch(`https://api.github.com/${path}`, {
    method: options.method ?? "GET",
    body: options.body,
    headers: {
      Accept: options.accept ?? "application/vnd.github+json",
      Authorization: `Bearer ${env("GITHUB_TOKEN")}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "cloudflare-os-automerge-weekly-sample",
    },
  });
  if (!response.ok && response.status !== 404) throw new Error(`GitHub ${path}: ${response.status} ${await response.text()}`);
  return response;
}

async function json(path: string): Promise<Json> {
  const response = await github(path);
  if (response.status === 404) throw new Error(`GitHub ${path}: 404`);
  return parseJson(await response.text());
}

async function main(): Promise<void> {
  const repo = env("GITHUB_REPOSITORY");
  const meta = asObject(await json(`repos/${repo}`), "repository");
  const branch = asString(meta.default_branch, "default_branch");
  const file = await github(`repos/${repo}/contents/${BANDS_FILE}?ref=${encodeURIComponent(branch)}`, {
    accept: "application/vnd.github.raw+json",
  });
  const closed = rung3Closed(file.status === 404 ? undefined : await file.text());
  if (closed) {
    console.log(`Rung 3 is closed (${closed}); nothing to sample.`);
    return;
  }
  const appId = Number(env("RISK_REVIEW_APP_ID"));
  if (!Number.isInteger(appId) || appId <= 0) throw new Error("RISK_REVIEW_APP_ID is not an App id");
  const now = new Date(process.env.SAMPLE_NOW ?? Date.now());
  if (Number.isNaN(now.getTime())) throw new Error("SAMPLE_NOW is not a time");
  const weekStart = new Date(now.getTime() - WEEK_MS).toISOString().slice(0, 10);
  const weekEnd = now.toISOString().slice(0, 10);

  const merged: JsonObject[] = [];
  for (let page = 1; ; page++) {
    const query = encodeURIComponent(`repo:${repo} is:pr is:merged merged:${weekStart}..${weekEnd}`);
    const items = asArray(asObject(await json(`search/issues?q=${query}&per_page=100&page=${page}`), "search").items, "items");
    merged.push(...items.map((item) => asObject(item, "item")));
    if (items.length < 100) break;
  }

  const auto: AutoMerged[] = [];
  const unreadable: number[] = [];
  for (const item of merged) {
    const number = asNumber(item.number, "number");
    const pull = asObject(await json(`repos/${repo}/pulls/${number}`), "pull");
    const head = asString(asObject(pull.head, "head").sha, "head sha");
    const runs = asArray(asObject(await json(
      `repos/${repo}/commits/${head}/check-runs?check_name=risk-review&app_id=${appId}&filter=latest&per_page=100`,
    ), "check runs").check_runs, "check_runs");
    const newest = runs.map((run) => asObject(run, "check run"))
      .toSorted((a, b) => asNumber(b.id, "id") - asNumber(a.id, "id"))[0];
    const summary = newest && isObject(newest.output) ? newest.output.summary : undefined;
    const record = typeof summary === "string" ? decisionFromSummary(summary) : undefined;
    if (!record) {
      unreadable.push(number);
      continue;
    }
    const decision = rung3Decision(record, number);
    if (decision) auto.push({ number, title: asString(item.title, "title"), url: asString(item.html_url, "url"), ...decision });
  }
  if (auto.length === 0 && unreadable.length === 0) {
    console.log(`No pull request merged through rung 3 between ${weekStart} and ${weekEnd}.`);
    return;
  }
  const picked = sample(auto, weekStart);
  const issue = issueFor(weekStart, weekEnd, auto, picked, unreadable);
  const assignee = process.env.SAMPLE_ASSIGNEE;
  const created = await github(`repos/${repo}/issues`, {
    method: "POST",
    body: JSON.stringify({ ...issue, ...(assignee ? { assignees: [assignee] } : {}) }),
  });
  console.log(`Filed ${asString(asObject(parseJson(await created.text()), "issue").html_url, "issue url")} sampling ${picked.length} of ${auto.length}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
