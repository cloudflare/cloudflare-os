// What the GitHub gatekeeper's hooks rely on GitHub itself for, checked against GitHub: the fakes
// the other suites deliver through (`workerd/hooks.test.ts`, integration-tests' github-fake.ts)
// can only assume it. The github-contract workflow runs this weekly and on demand, against a
// disposable private repository that CONTRACT_GITHUB_TOKEN administers, named `owner/name` by
// CONTRACT_GITHUB_REPO. With either unset, every check is skipped. What the checks make is
// removed or closed after them, however they end.
//
// CONTRACT_GITHUB_OUTSIDER_TOKEN, a token that can't read the repository (the workflow passes its
// own), adds the access check. CONTRACT_GITHUB_WEBHOOK_URL is where the webhooks deliver,
// https://example.com/webhook unless set: nothing has to answer, since GitHub's delivery log
// records each request whatever the answer. CONTRACT_GITHUB_PAYLOADS_DIR, if set, receives each
// payload GitHub sent, with the account's and repository's names replaced, for fixtures.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitHubApi, type GitHubIssueResponse, type GitHubRepoResponse, type GitHubSimpleUser,
} from "../../src/github-api";
import { parseWebhookEvent, type WebhookPayload } from "../../src/github-webhook-events";

const token = process.env.CONTRACT_GITHUB_TOKEN;
const repoName = process.env.CONTRACT_GITHUB_REPO;
const outsiderToken = process.env.CONTRACT_GITHUB_OUTSIDER_TOKEN;
const receiver = process.env.CONTRACT_GITHUB_WEBHOOK_URL || "https://example.com/webhook";
const payloadsDir = process.env.CONTRACT_GITHUB_PAYLOADS_DIR;

/** One attempt in a webhook's delivery log, as GitHub lists it. */
type DeliverySummary = { id: number; guid: string; event: string; action: string | null; redelivery: boolean };
/** One attempt in full: where it went, and the request GitHub made. */
type Delivery = DeliverySummary & {
  url: string;
  request: { headers: Record<string, string>; payload: Record<string, unknown> & WebhookPayload };
};

const sign = (secret: string, body: string) => `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
const newSecret = () => randomBytes(32).toString("hex");
const header = (delivery: Delivery, name: string) => Object.entries(delivery.request.headers)
  .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];

/** Poll `attempt` until it returns something, as GitHub delivers in its own time. */
async function eventually<T>(what: string, attempt: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
}

/** A request the gatekeeper's client has no method for. */
async function github<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "Cloudflare-Gadgets-contract",
      ...body === undefined ? {} : { "Content-Type": "application/json" },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return (response.status === 204 ? undefined : await response.json()) as T;
}

/** Whether `found` is the delivery of `issue`'s `action`. */
const ofIssue = (issue: GitHubIssueResponse, action: string) => (found: Delivery) =>
  found.action === action && found.request.payload.issue?.number === issue.number;

describe.skipIf(!token || !repoName)("GitHub, as the GitHub gatekeeper's hooks rely on it", () => {
  const api = new GitHubApi(async () => token!);
  const [owner = "", name = ""] = repoName?.split("/") ?? [];
  const repoPath = `/repos/${owner}/${name}`;
  const cleanups: (() => Promise<unknown>)[] = [];
  let repository: GitHubRepoResponse;
  let viewer: GitHubSimpleUser;

  /** A webhook made as the gatekeeper makes one, deleted after the checks. */
  async function webhook(events: string[], secret = newSecret(), url = receiver) {
    const made = await api.createRepoWebhook(owner, name, { url, secret, events });
    cleanups.push(() => api.deleteRepoWebhook(owner, name, made.id));
    return { id: made.id, secret };
  }

  /** An issue the account opens, closed after the checks. */
  async function openIssue(): Promise<GitHubIssueResponse> {
    const issue = await api.createIssue(owner, name, { title: "Contract check", body: "Opened by the GitHub contract checks." });
    cleanups.push(() => api.updateIssue(owner, name, issue.number, { state: "closed" }));
    return issue;
  }

  /** The first attempt, or redelivery, logged for webhook `hookId` that `matches`. */
  function delivery(hookId: number, event: string, matches: (delivery: Delivery) => boolean, redelivery = false) {
    return eventually(`${redelivery ? "a redelivery" : "a delivery"} of ${event}`, async () => {
      const log = await github<DeliverySummary[]>("GET", `${repoPath}/hooks/${hookId}/deliveries?per_page=100`);
      for (const summary of log.filter(entry => entry.event === event && entry.redelivery === redelivery)) {
        const found = await github<Delivery>("GET", `${repoPath}/hooks/${hookId}/deliveries/${summary.id}`);
        if (matches(found)) return found;
      }
      return undefined;
    });
  }

  /** Keep `found`'s payload as a fixture, with the account's and repository's names replaced. */
  function keep(fixture: string, found: Delivery): void {
    if (!payloadsDir) return;
    let text = JSON.stringify(found.request.payload, null, 2);
    for (const [real, placeholder] of [[name, "widgets"], [owner, "acme"], [viewer.login, "ada"]] as const) {
      text = text.replaceAll(new RegExp(`\\b${real.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), placeholder);
    }
    mkdirSync(payloadsDir, { recursive: true });
    writeFileSync(join(payloadsDir, `${fixture}.json`), `${text}\n`);
  }

  beforeAll(async () => {
    repository = await api.getRepo(owner, name);
    if (repository.private !== true) {
      throw new Error(`${repoName} must be private, or anyone could read it and the access check would prove nothing.`);
    }
    viewer = (await api.getViewer()).user;
  });

  afterAll(async () => {
    const failures: unknown[] = [];
    for (const cleanup of cleanups.toReversed()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) throw new AggregateError(failures, "Failed to clean up after the contract checks");
  });

  it.skipIf(!outsiderToken)("answers 404, not 304, to a token that can't read the repository, whatever ETag it sends", async () => {
    const fresh = await api.getRepoByIdConditional(repository.id);
    const etag = fresh.headers.get("ETag");
    expect(fresh.status).toBe(200);
    expect(etag).toBeTruthy();
    // The ETag is current: the account itself is told nothing changed.
    expect((await api.getRepoByIdConditional(repository.id, { ifNoneMatch: etag! })).status).toBe(304);
    const outsider = new GitHubApi(async () => outsiderToken!);
    await expect(outsider.getRepoByIdConditional(repository.id, { ifNoneMatch: etag! }))
      .rejects.toMatchObject({ status: 404 });
  });

  it("signs each delivery, names the account as the sender of what it did, and sends what the gatekeeper reads", async () => {
    const hook = await webhook(["issues", "issue_comment"]);
    const issue = await openIssue();
    const comment = await api.createIssueComment(owner, name, issue.number, "Commented by the GitHub contract checks.");
    const opened = await delivery(hook.id, "issues", ofIssue(issue, "opened"));
    const commented = await delivery(hook.id, "issue_comment", found => found.request.payload.comment?.id === comment.id);
    keep("issues.opened", opened);
    keep("issue_comment.created", commented);
    for (const found of [opened, commented]) {
      expect(header(found, "Content-Type")).toBe("application/json");
      expect(header(found, "X-GitHub-Delivery")).toBe(found.guid);
      expect(header(found, "X-Hub-Signature-256")).toMatch(/^sha256=[0-9a-f]{64}$/);
    }
    // The comment is the account's own, which no hook of the account's is handed.
    expect(parseWebhookEvent("issues", opened.guid, opened.request.payload)).toMatchObject({
      event: { kind: "issue", action: "opened", number: issue.number, repoId: repository.id }, senderId: viewer.id,
    });
    expect(parseWebhookEvent("issue_comment", commented.guid, commented.request.payload)).toMatchObject({
      event: { kind: "comment", number: issue.number, comment: { id: comment.id } }, senderId: viewer.id,
    });
  });

  it("redelivers with the webhook's URL, encoding and secret as they are now, not as they were", async () => {
    const was = { secret: newSecret(), url: `${receiver}?contract=was` };
    const now = { secret: newSecret(), url: `${receiver}?contract=now` };
    // One webhook sending JSON, and one sending forms, as someone may have switched it to.
    const json = await webhook(["issues"], was.secret, was.url);
    const form = await github<{ id: number }>("POST", `${repoPath}/hooks`, {
      name: "web", active: true, events: ["issues"],
      config: { url: was.url, secret: was.secret, content_type: "form", insecure_ssl: "0" },
    });
    cleanups.push(() => api.deleteRepoWebhook(owner, name, form.id));
    const issue = await openIssue();
    const jsonFirst = await delivery(json.id, "issues", ofIssue(issue, "opened"));
    const formFirst = await delivery(form.id, "issues", ofIssue(issue, "opened"));
    expect(header(formFirst, "Content-Type")).toBe("application/x-www-form-urlencoded");

    // Repaired as the gatekeeper's hourly check repairs a webhook, then redelivered.
    for (const id of [json.id, form.id]) await api.updateRepoWebhook(owner, name, id, { ...now, events: ["issues"] });
    await api.redeliverRepoWebhookDelivery(owner, name, json.id, jsonFirst.id);
    await api.redeliverRepoWebhookDelivery(owner, name, form.id, formFirst.id);
    const jsonAgain = await delivery(json.id, "issues", found => found.guid === jsonFirst.guid, true);
    const formAgain = await delivery(form.id, "issues", found => found.guid === formFirst.guid, true);
    expect([jsonAgain.url, formAgain.url]).toEqual([now.url, now.url]);
    expect(header(formAgain, "Content-Type")).toBe("application/json");
    // The same payload under the same secret would carry the same signature.
    const signature = header(jsonFirst, "X-Hub-Signature-256");
    expect(header(jsonAgain, "X-Hub-Signature-256")).not.toBe(signature);
    // Where the log's payload re-serializes to the bytes GitHub signed, the new secret can be named.
    if (signature === sign(was.secret, JSON.stringify(jsonFirst.request.payload))) {
      expect(header(jsonAgain, "X-Hub-Signature-256")).toBe(sign(now.secret, JSON.stringify(jsonAgain.request.payload)));
    }
  });

  it("lists a webhook's deliveries newest first, the gatekeeper paging through them as it does", async () => {
    const hook = await webhook(["issues"]);
    const issue = await openIssue();
    await api.updateIssue(owner, name, issue.number, { state: "closed" });
    await api.updateIssue(owner, name, issue.number, { state: "open" });
    const opened = await delivery(hook.id, "issues", ofIssue(issue, "opened"));
    await delivery(hook.id, "issues", ofIssue(issue, "reopened"));
    await api.redeliverRepoWebhookDelivery(owner, name, hook.id, opened.id);
    const again = await delivery(hook.id, "issues", found => found.guid === opened.guid, true);

    const listed = await api.listRepoWebhookDeliveries(owner, name, hook.id, 0);
    const times = listed.map(entry => Date.parse(entry.delivered_at));
    expect(times).toEqual(times.toSorted((a, b) => b - a));
    expect(listed.map(entry => entry.id)).toEqual(expect.arrayContaining([opened.id, again.id]));
    expect(listed[0]?.id).toBe(again.id);
  });

  it("sends the push, pull request and review events the gatekeeper reads", async () => {
    const hook = await webhook(["push", "pull_request", "pull_request_review"]);
    const branch = `contract-${randomUUID()}`;
    const base = await github<{ object: { sha: string } }>(
      "GET", `${repoPath}/git/ref/heads/${encodeURIComponent(repository.default_branch)}`);
    await github("POST", `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: base.object.sha });
    cleanups.push(() => github("DELETE", `${repoPath}/git/refs/heads/${branch}`));
    const file = await github<{ commit: { sha: string } }>("PUT", `${repoPath}/contents/contract/${branch}.md`, {
      message: "Contract check", branch, content: Buffer.from("Committed by the GitHub contract checks.\n").toString("base64"),
    });
    const pull = await api.createPullRequest(owner, name, {
      title: "Contract check", head: branch, base: repository.default_branch, body: "Opened by the GitHub contract checks.",
    });
    cleanups.push(() => github("PATCH", `${repoPath}/pulls/${pull.number}`, { state: "closed" }));
    const review = await github<{ id: number }>("POST", `${repoPath}/pulls/${pull.number}/reviews`, {
      event: "COMMENT", body: "Reviewed by the GitHub contract checks.",
    });

    const pushed = await delivery(hook.id, "push", found => found.request.payload.after === file.commit.sha);
    const opened = await delivery(hook.id, "pull_request",
      found => found.action === "opened" && found.request.payload.pull_request?.number === pull.number);
    const reviewed = await delivery(hook.id, "pull_request_review", found => found.request.payload.review?.id === review.id);
    keep("push", pushed);
    keep("pull_request.opened", opened);
    keep("pull_request_review.submitted", reviewed);
    const push = parseWebhookEvent("push", pushed.guid, pushed.request.payload);
    expect(push).toMatchObject({
      event: { kind: "push", branch, before: base.object.sha, after: file.commit.sha, forced: false },
      senderId: viewer.id,
    });
    // When it happened: the push's own payload spells it in seconds.
    expect(Math.abs(push!.at - Date.now())).toBeLessThan(3_600_000);
    expect(parseWebhookEvent("pull_request", opened.guid, opened.request.payload)).toMatchObject({
      event: { kind: "pullRequest", action: "opened", number: pull.number }, senderId: viewer.id,
    });
    expect(parseWebhookEvent("pull_request_review", reviewed.guid, reviewed.request.payload)).toMatchObject({
      event: { kind: "review", number: pull.number, review: { id: review.id } }, senderId: viewer.id,
    });
  });
});
