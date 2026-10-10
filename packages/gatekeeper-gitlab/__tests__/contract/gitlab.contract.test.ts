// What the GitLab gatekeeper's hooks rely on GitLab itself for, checked against GitLab: the fakes
// the other suites deliver through (`workerd/hooks.test.ts`, integration-tests' gitlab-fake.ts)
// can only assume it. The gitlab-contract workflow runs this weekly and on demand against a
// disposable private project, with at least one commit, on GitLab 19.0 or later (gitlab.com
// unless CONTRACT_GITLAB_URL names another instance). CONTRACT_GITLAB_PROJECT names it by its path,
// and CONTRACT_GITLAB_TOKEN is an access token with the `api` scope of an account that maintains
// it. With either unset, every check is skipped. What the checks make is removed or closed after
// them, however they end.
//
// CONTRACT_GITLAB_WEBHOOK_URL is where the webhooks deliver, https://example.com/webhook unless
// set: nothing has to answer, since GitLab's webhook log records each request whatever the answer.
// CONTRACT_GITLAB_PAYLOADS_DIR, if set, receives each payload GitLab sent, with the account's and
// project's names replaced, for fixtures.

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GitLabApi, type GitLabIssueResponse, type GitLabProjectResponse, type GitLabUserResponse, type GitLabWebhookTrigger,
} from "../../src/gitlab-api";
import { parseWebhookEvent, type WebhookPayload } from "../../src/gitlab-webhook-events";

const token = process.env.CONTRACT_GITLAB_TOKEN;
const projectPath = process.env.CONTRACT_GITLAB_PROJECT;
const origin = (process.env.CONTRACT_GITLAB_URL || "https://gitlab.com").replace(/\/+$/, "");
const receiver = process.env.CONTRACT_GITLAB_WEBHOOK_URL || "https://example.com/webhook";
const payloadsDir = process.env.CONTRACT_GITLAB_PAYLOADS_DIR;

/** One attempt in a webhook's log, as GitLab lists it, with what it sent. */
type LoggedEvent = {
  id: number;
  url: string;
  request_headers?: Record<string, string> | null;
  request_data?: unknown;
  response_status: string | number;
  created_at: string;
};

const header = (event: LoggedEvent, name: string) => Object.entries(event.request_headers ?? {})
  .find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
/** The delivery an attempt belongs to, which a retry or resend repeats, as the hourly check reads it. */
const deliveryOf = (event: LoggedEvent) => header(event, "webhook-id") ?? header(event, "Idempotency-Key");
const payloadOf = (event: LoggedEvent) => (typeof event.request_data === "string"
  ? JSON.parse(event.request_data) : event.request_data) as Record<string, unknown> & WebhookPayload;
const newSigningToken = () => `whsec_${randomBytes(32).toString("base64")}`;
/** The Standard Webhooks signature of `body`, sent at `timestamp` as delivery `id`, under `signingToken`. */
const sign = (signingToken: string, id: string, timestamp: string, body: string) =>
  `v1,${createHmac("sha256", Buffer.from(signingToken.slice("whsec_".length), "base64"))
    .update(`${id}.${timestamp}.${body}`).digest("base64")}`;
/** Whether `event`'s logged signature is `signingToken`'s, over the payload as the log gives it. */
const signedWith = (event: LoggedEvent, signingToken: string) =>
  (header(event, "webhook-signature") ?? "").split(" ").includes(sign(signingToken, deliveryOf(event) ?? "",
    header(event, "webhook-timestamp") ?? "",
    typeof event.request_data === "string" ? event.request_data : JSON.stringify(event.request_data)));

/** Whether `found` is the attempt at delivering `issue`'s `action`. */
const ofIssue = (issue: GitLabIssueResponse, action: string) => (found: LoggedEvent) => {
  const attributes = payloadOf(found).object_attributes;
  return attributes?.iid === issue.iid && attributes.action === action;
};

/** Poll `attempt` until it returns something, as GitLab delivers in its own time. */
async function eventually<T>(what: string, attempt: () => Promise<T | undefined>): Promise<T> {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const result = await attempt();
    if (result !== undefined) return result;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await new Promise(resolve => setTimeout(resolve, 3_000));
  }
}

/** A request the gatekeeper's client has no method for, as the account or (`anonymous`) no one. */
async function gitlab<T>(method: string, path: string, body?: unknown, { anonymous = false } = {}): Promise<Response & { data?: T }> {
  const response = await fetch(`${origin}/api/v4${path}`, {
    method,
    headers: {
      ...anonymous ? {} : { Authorization: `Bearer ${token}` },
      ...body === undefined ? {} : { "Content-Type": "application/json" },
    },
    ...body === undefined ? {} : { body: JSON.stringify(body) },
  });
  if (anonymous) return response;
  if (!response.ok) throw new Error(`${method} ${path} answered ${response.status}: ${await response.text()}`);
  return Object.assign(response, { data: response.status === 204 ? undefined : await response.json() as T });
}

describe.skipIf(!token || !projectPath)("GitLab, as the GitLab gatekeeper's hooks rely on it", () => {
  const api = new GitLabApi({ apiOrigin: origin, headers: {} }, async () => token!);
  const cleanups: (() => Promise<unknown>)[] = [];
  let project: GitLabProjectResponse;
  let defaultBranch: string;
  let viewer: GitLabUserResponse;

  /** A webhook made as the gatekeeper makes one, deleted after the checks. */
  async function webhook(triggers: GitLabWebhookTrigger[], signingToken = newSigningToken(), url = receiver) {
    const made = await api.createProjectWebhook(project.id, { url, signingToken, triggers });
    cleanups.push(() => api.deleteProjectWebhook(project.id, made.id));
    return { id: made.id, signingToken, url, triggers };
  }

  /** An issue the account opens, closed after the checks. */
  async function openIssue(): Promise<GitLabIssueResponse> {
    const issue = await api.createIssue(projectPath!, { title: "Contract check", description: "Opened by the GitLab contract checks." });
    cleanups.push(() => gitlab("PUT", `/projects/${project.id}/issues/${issue.iid}`, { state_event: "close" }));
    return issue;
  }

  /** Every attempt logged for webhook `hookId`, newest first. */
  async function logged(hookId: number): Promise<LoggedEvent[]> {
    return (await gitlab<LoggedEvent[]>("GET", `/projects/${project.id}/hooks/${hookId}/events?per_page=100`)).data!;
  }

  /** The first attempt logged for webhook `hookId` whose `X-Gitlab-Event` is `event` and that `matches`. */
  function attempt(hookId: number, event: string, matches: (found: LoggedEvent) => boolean) {
    return eventually(`an attempt at a ${event}`, async () =>
      (await logged(hookId)).toReversed().find(found => header(found, "X-Gitlab-Event") === event && matches(found)));
  }

  /** Keep `found`'s payload as a fixture, with the account's and project's names replaced. */
  function keep(fixture: string, found: LoggedEvent): void {
    if (!payloadsDir) return;
    let text = JSON.stringify(payloadOf(found), null, 2);
    const [namespace = "", ...rest] = projectPath!.split("/");
    for (const [real, placeholder] of [[rest.join("/"), "widgets"], [namespace, "acme"], [viewer.username, "ada"]] as const) {
      if (!real) continue;
      text = text.replaceAll(new RegExp(`\\b${real.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "g"), placeholder);
    }
    mkdirSync(payloadsDir, { recursive: true });
    writeFileSync(join(payloadsDir, `${fixture}.json`), `${text}\n`);
  }

  beforeAll(async () => {
    project = await api.getProject(projectPath!);
    if (project.visibility !== "private") {
      throw new Error(`${projectPath} must be private, or anyone could read it and the access check would prove nothing.`);
    }
    if (!project.default_branch) throw new Error(`${projectPath} needs a commit, for the push and merge request checks.`);
    defaultBranch = project.default_branch;
    viewer = await api.getCurrentUser();
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

  it("answers 404 to a reader that can't see the project, as a delivery's fresh reads take it", async () => {
    const issue = await openIssue();
    expect((await api.getIssue(projectPath!, issue.iid)).iid).toBe(issue.iid);
    for (const path of [`/projects/${project.id}`, `/projects/${project.id}/issues/${issue.iid}`]) {
      expect((await gitlab("GET", path, undefined, { anonymous: true })).status).toBe(404);
    }
  });

  it("keeps a webhook as the gatekeeper configures it, which its hourly check takes to be intact", async () => {
    const hook = await webhook(["issues_events", "note_events"]);
    const found = await api.getProjectWebhook(project.id, hook.id);
    expect(found).toMatchObject({
      url: hook.url, signing_token_present: true, enable_ssl_verification: true,
      issues_events: true, note_events: true, merge_requests_events: false, push_events: false, tag_push_events: false,
      confidential_issues_events: false, confidential_note_events: false,
    });
    expect(found.custom_webhook_template || "").toBe("");
    expect(found.push_events_branch_filter || "").toBe("");
  });

  it("names each delivery, names the account as the sender of what it did, and sends what the gatekeeper reads", async () => {
    const hook = await webhook(["issues_events", "note_events"]);
    const issue = await openIssue();
    const note = await api.createNote(projectPath!, "issues", issue.iid, "Commented by the GitLab contract checks.");
    const opened = await attempt(hook.id, "Issue Hook", ofIssue(issue, "open"));
    const commented = await attempt(hook.id, "Note Hook", found => payloadOf(found).object_attributes?.id === note.id);
    keep("issue.open", opened);
    keep("note.create", commented);
    for (const found of [opened, commented]) {
      expect(deliveryOf(found)).toMatch(/\S/);
      expect(header(found, "webhook-timestamp")).toMatch(/^\d+$/);
    }
    // The comment is the account's own, which no hook of the account's is handed.
    expect(parseWebhookEvent("Issue Hook", deliveryOf(opened)!, project.id, payloadOf(opened), origin)).toMatchObject({
      event: { kind: "issue", action: "opened", target: { kind: "issue", iid: issue.iid } }, senderId: viewer.id,
    });
    expect(parseWebhookEvent("Note Hook", deliveryOf(commented)!, project.id, payloadOf(commented), origin)).toMatchObject({
      event: { kind: "comment", target: { kind: "issue", iid: issue.iid }, noteId: note.id }, senderId: viewer.id,
    });
  });

  it("resends a delivery as itself, signed with the webhook's signing token as it is now, until its URL changes", async ctx => {
    const was = newSigningToken();
    const now = newSigningToken();
    const hook = await webhook(["issues_events"], was);
    const issue = await openIssue();
    const first = await attempt(hook.id, "Issue Hook", ofIssue(issue, "open"));

    // A new signing token, as the hourly check restores the gatekeeper's over someone else's.
    await api.updateProjectWebhook(project.id, hook.id, { url: hook.url, signingToken: now, triggers: hook.triggers });
    await api.resendProjectWebhookEvent(project.id, hook.id, first.id);
    const again = await attempt(hook.id, "Issue Hook", found => found.id !== first.id && deliveryOf(found) === deliveryOf(first));
    expect(again.url).toBe(hook.url);

    // Moved, the webhook's earlier attempts can't be resent.
    await api.updateProjectWebhook(project.id, hook.id, { url: `${receiver}?contract=moved`, signingToken: now, triggers: hook.triggers });
    await expect(api.resendProjectWebhookEvent(project.id, hook.id, first.id)).rejects.toMatchObject({ status: 422 });

    // The log can show which token signed an attempt only if its payload re-serializes to the
    // bytes GitLab signed, which the first attempt, signed with the old token, shows.
    if (!signedWith(first, was)) {
      ctx.skip("GitLab's log does not give the bytes it signed, so the resend's signing token can't be named");
    }
    expect(signedWith(again, now)).toBe(true);
  });

  it("lists a webhook's events newest first, the gatekeeper paging through them as it does", async () => {
    const hook = await webhook(["issues_events"]);
    const issue = await openIssue();
    await api.updateIssue(projectPath!, issue.iid, { state_event: "close" });
    await api.updateIssue(projectPath!, issue.iid, { state_event: "reopen" });
    const opened = await attempt(hook.id, "Issue Hook", ofIssue(issue, "open"));
    await attempt(hook.id, "Issue Hook", ofIssue(issue, "reopen"));
    await api.resendProjectWebhookEvent(project.id, hook.id, opened.id);
    const again = await attempt(hook.id, "Issue Hook", found => found.id !== opened.id && deliveryOf(found) === deliveryOf(opened));

    const listed = await api.listProjectWebhookEvents(project.id, hook.id, 0);
    const times = listed.map(event => Date.parse(event.created_at));
    expect(times).toEqual(times.toSorted((a, b) => b - a));
    expect(listed[0]?.id).toBe(again.id);
  });

  it("sends the push and merge request events the gatekeeper reads", async () => {
    const hook = await webhook(["push_events", "merge_requests_events"]);
    const branch = `contract-${randomUUID()}`;
    await gitlab("POST", `/projects/${project.id}/repository/branches?branch=${branch}&ref=${encodeURIComponent(defaultBranch)}`);
    cleanups.push(() => gitlab("DELETE", `/projects/${project.id}/repository/branches/${branch}`));
    const commit = (await gitlab<{ id: string; parent_ids: string[] }>("POST", `/projects/${project.id}/repository/commits`, {
      branch, commit_message: "Contract check",
      actions: [{ action: "create", file_path: `contract/${branch}.md`, content: "Committed by the GitLab contract checks.\n" }],
    })).data!;
    const opened = (await gitlab<{ iid: number }>("POST", `/projects/${project.id}/merge_requests`, {
      source_branch: branch, target_branch: defaultBranch, title: "Contract check",
    })).data!;
    cleanups.push(() => gitlab("PUT", `/projects/${project.id}/merge_requests/${opened.iid}`, { state_event: "close" }));

    const pushed = await attempt(hook.id, "Push Hook", found => payloadOf(found).after === commit.id);
    const mergeRequest = await attempt(hook.id, "Merge Request Hook", found =>
      payloadOf(found).object_attributes?.iid === opened.iid && payloadOf(found).object_attributes?.action === "open");
    keep("push", pushed);
    keep("merge_request.open", mergeRequest);
    expect(parseWebhookEvent("Push Hook", deliveryOf(pushed)!, project.id, payloadOf(pushed), origin)).toMatchObject({
      event: { kind: "push", branch, before: commit.parent_ids[0], after: commit.id },
    });
    expect(parseWebhookEvent("Merge Request Hook", deliveryOf(mergeRequest)!, project.id, payloadOf(mergeRequest), origin))
      .toMatchObject({ event: { kind: "mergeRequest", action: "opened", target: { kind: "mergeRequest", iid: opened.iid } }, senderId: viewer.id });
  });
});
