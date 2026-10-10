// GitLab event hooks, end to end inside the gatekeeper worker: a facet restored the way the
// Overseer restores it binds the hook, TestHooks enables it and answers each firing, GitLab is
// the fake below (on fake-gitlab.ts's fetch boundary), and its signed webhook deliveries arrive
// through the worker's own fetch handler.

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { HookDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, expect, it, vi } from "vitest";
import * as fx from "../fixtures/gitlab-docs.js";
import type { GitLabSubscribeOptions } from "../../src/types.js";
import { FakeGitLab, WEB, json, seedAccount, unwrap } from "./fake-gitlab.js";
import type { GatekeeperProps } from "./worker.js";

const PROJECT = "group/sub/project";
const P = encodeURIComponent(PROJECT);
const PROJECT_ID = 15;
const HOOKS = `/api/v4/projects/${PROJECT_ID}/hooks`;
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const ZERO = "0".repeat(40);
const CREATED = new Date().toISOString();

type Row = Record<string, unknown>;
type Webhook = { id: number; url: string; signingToken?: string; triggers: string[]; alertStatus?: string };
/** One attempt at a delivery, as GitLab logs it. */
type Delivery = {
  id: number; hookId: number; webhookId: string; event: string; body: string; url: string; status: string;
  createdAt: number;
};

const HOUR = 3_600_000;

const user = (username: string, id: number) => ({
  id, username, name: username[0].toUpperCase() + username.slice(1),
  avatar_url: `https://avatars.example/${username}`, email: `${username}@example.com`,
});
/** The connected account. */
const ADA = user("ada", 7);
const BOB = user("bob", 8);

const projectPayload = { id: PROJECT_ID, name: "Project", path_with_namespace: PROJECT, web_url: `${WEB}/${PROJECT}` };

/** How GitLab reports an issue's or merge request's event, under `X-Gitlab-Event`. */
function issueHook(action: string, iid: number, sender = BOB): Row {
  return {
    object_kind: "issue", event_type: "issue", user: sender, project: projectPayload,
    object_attributes: {
      id: 300 + iid, iid, title: "Crash on start", description: "It crashes.", action,
      state: action === "close" ? "closed" : "opened", url: `${WEB}/${PROJECT}/-/issues/${iid}`,
      created_at: CREATED, updated_at: CREATED, confidential: false,
    },
    labels: [], assignees: [], changes: {},
  };
}

function mergeRequestHook(action: string, iid: number, attributes: Row = {}, changes: Row = {}, sender = BOB): Row {
  return {
    object_kind: "merge_request", event_type: "merge_request", user: sender, project: projectPayload,
    object_attributes: {
      id: 900 + iid, iid, title: "Fix the crash", action, state: "opened", draft: false,
      source_branch: "fix", target_branch: "main", url: `${WEB}/${PROJECT}/-/merge_requests/${iid}`,
      created_at: CREATED, updated_at: CREATED, ...attributes,
    },
    changes, labels: [], reviewers: [], assignees: [],
  };
}

/** A diff note's position, as GitLab gives one in both its webhooks and its REST API. */
const position = {
  base_sha: BASE, start_sha: BASE, head_sha: HEAD, old_path: "src/app.ts", new_path: "src/app.ts",
  position_type: "text", old_line: null, new_line: 12,
};

function noteHook(on: "Issue" | "MergeRequest", iid: number, body: string, options: {
  sender?: typeof ADA; diff?: boolean; id?: number; action?: string; internal?: boolean;
} = {}): Row {
  const { sender = BOB, diff = false, id = 1241, action = "create", internal = false } = options;
  return {
    object_kind: "note", event_type: "note", user: sender, project_id: PROJECT_ID, project: projectPayload,
    object_attributes: {
      id, note: body, noteable_type: on, author_id: sender.id, created_at: CREATED, updated_at: CREATED,
      system: false, internal, action, discussion_id: "d".repeat(40), type: diff ? "DiffNote" : null,
      url: `${WEB}/${PROJECT}/-/${on === "Issue" ? "issues" : "merge_requests"}/${iid}#note_${id}`,
      ...diff ? { position } : {},
    },
    ...on === "Issue"
      ? { issue: { id: 300 + iid, iid, title: "Crash on start" } }
      : { merge_request: { id: 900 + iid, iid, title: "Fix the crash" } },
  };
}

function pushHook(kind: "push" | "tag_push", ref: string, before: string, head: string, sender = ADA): Row {
  return {
    object_kind: kind, event_name: kind, before, after: head, ref, checkout_sha: head === ZERO ? null : head,
    user_id: sender.id, user_name: sender.name, user_username: sender.username, user_avatar: sender.avatar_url,
    project_id: PROJECT_ID, project: projectPayload, commits: [], total_commits_count: 0,
  };
}

/** The REST shapes of the issue and merge request whose events are delivered. */
function issueRest(iid: number, state = "opened"): Row {
  return {
    ...fx.issueResponse.data, iid, project_id: PROJECT_ID, title: "Crash on start", state,
    closed_at: state === "closed" ? CREATED : null, web_url: `${WEB}/${PROJECT}/-/issues/${iid}`, labels: ["bug"],
  };
}

function mergeRequestRest(iid: number, state = "opened"): Row {
  return {
    ...fx.mergeRequestResponse.data, iid, state, project_id: PROJECT_ID, source_project_id: PROJECT_ID,
    target_project_id: PROJECT_ID, title: "Fix the crash", source_branch: "fix", target_branch: "main",
    sha: HEAD, diff_refs: { base_sha: BASE, head_sha: HEAD, start_sha: BASE },
    web_url: `${WEB}/${PROJECT}/-/merge_requests/${iid}`,
  };
}

/** A reviewer's review state changing, as a merge request event's `changes` reports it. */
const reviewerState = (previous: string, current: string) => ({
  reviewers: [[{ ...BOB, state: previous }], [{ ...BOB, state: current }]],
});

/** An issue's or merge request's event as the driver queues it, for delivering to a facet directly. */
const storedEvent = (kind: "issue" | "mergeRequest", iid: number) => ({
  id: crypto.randomUUID(), projectId: PROJECT_ID, actor: null, kind, action: "opened", target: { kind, iid },
});

const notFound = () => json({ message: "404 Not found" }, { status: 404 });

const TRIGGERS: Record<string, string> = {
  "Issue Hook": "issues_events", "Merge Request Hook": "merge_requests_events", "Note Hook": "note_events",
  "Push Hook": "push_events", "Tag Push Hook": "tag_push_events",
};

function fromBase64(encoded: string): Uint8Array {
  return Uint8Array.from(atob(encoded), char => char.charCodeAt(0));
}

/** A Standard Webhooks signature, as GitLab signs a delivery with a webhook's signing token. */
async function sign(signingToken: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", fromBase64(signingToken.slice("whsec_".length)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${timestamp}.${body}`));
  return `v1,${btoa(String.fromCharCode(...new Uint8Array(signature)))}`;
}

/**
 * GitLab, as far as hooks use it: the instance's version, the project and who may manage its
 * webhooks, the viewer, the issue and merge request REST reads, and webhooks that sign what they
 * deliver.
 */
class FakeGitLabHooks {
  readonly gitlab = new FakeGitLab();
  maintainer = true;
  /** Whether the account can still read the project at all. */
  readable = true;
  version = "19.4.0-ee";
  /** Whether webhooks keep a signing token, as from GitLab 19.0. */
  signs = true;
  readonly webhooks = new Map<number, Webhook>();
  readonly deleted: number[] = [];
  /** Each issue's and merge request's state by iid, `"opened"` unless set. */
  readonly states = { issue: new Map<number, string>(), mergeRequest: new Map<number, string>() };
  /** Each merge request's approvals by iid, the fixture's unless set. */
  readonly approvals = new Map<number, Row[]>();
  /** Every delivery attempt, oldest first. */
  readonly log: Delivery[] = [];
  /** The logged attempts the driver had resent, by id. */
  readonly resends: number[] = [];
  /** While set, deliveries fail with this status without reaching the worker. */
  failDeliveriesWith: number | undefined;
  #nextDeliveryId = 1;
  /**
   * While set, a webhook DELETE stalls, counted in `stalledDeletes`. Polled rather than awaited:
   * a promise settled from the test would carry the test's I/O context into the driver.
   */
  stallDeletes = false;
  stalledDeletes = 0;
  #nextId = 100;

  constructor() {
    this.gitlab
      .on("GET", /^\/api\/v4\/user$/, () => json({ ...ADA, web_url: `${WEB}/ada`, confirmed_at: CREATED }))
      .on("GET", /^\/api\/v4\/metadata$/, () => json({ version: this.version }))
      .on("GET", new RegExp(`^/api/v4/projects/${P}$`), () => this.readable
        ? json({ ...fx.projectResponse.data, id: PROJECT_ID, path_with_namespace: PROJECT, web_url: `${WEB}/${PROJECT}` })
        : notFound())
      .on("GET", new RegExp(`^/api/v4/projects/${P}/issues/(\\d+)\\?`), request => {
        const iid = Number(/issues\/(\d+)/.exec(request.url.pathname)![1]);
        return this.readable ? json(issueRest(iid, this.states.issue.get(iid))) : notFound();
      })
      .on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/(\\d+)\\?`), request => {
        const iid = Number(/merge_requests\/(\d+)/.exec(request.url.pathname)![1]);
        return this.readable ? json(mergeRequestRest(iid, this.states.mergeRequest.get(iid))) : notFound();
      })
      .on("GET", new RegExp(`^/api/v4/projects/${P}/merge_requests/\\d+/approvals$`), request => {
        const iid = Number(/merge_requests\/(\d+)/.exec(request.url.pathname)![1]);
        return json({ ...fx.approvalsResponse.data, approved_by: this.approvals.get(iid) ?? fx.approvalsResponse.data.approved_by });
      })
      .on("GET", new RegExp(`^${HOOKS}\\?`), () => this.maintainer
        ? json([...this.webhooks.values()].map(webhook => this.#reported(webhook)))
        : json({ message: "403 Forbidden" }, { status: 403 }))
      .on("POST", new RegExp(`^${HOOKS}$`), request => {
        if (!this.maintainer) return json({ message: "403 Forbidden" }, { status: 403 });
        const webhook = this.#configured(this.#nextId++, request.body!);
        this.webhooks.set(webhook.id, webhook);
        return json(this.#reported(webhook), { status: 201 });
      })
      .on("GET", new RegExp(`^${HOOKS}/(\\d+)$`), request => {
        const webhook = this.webhooks.get(Number(/hooks\/(\d+)/.exec(request.url.pathname)![1]));
        return webhook ? json(this.#reported(webhook)) : notFound();
      })
      .on("GET", new RegExp(`^${HOOKS}/(\\d+)/events\\?`), request => {
        const hookId = Number(/hooks\/(\d+)/.exec(request.url.pathname)![1]);
        const page = Number(request.url.searchParams.get("page") ?? 1);
        const perPage = Number(request.url.searchParams.get("per_page") ?? 20);
        const newestFirst = this.log.filter(delivery => delivery.hookId === hookId).toReversed();
        const more = page * perPage < newestFirst.length;
        return json(newestFirst.slice((page - 1) * perPage, page * perPage).map(delivery => ({
          id: delivery.id, url: delivery.url, response_status: delivery.status,
          created_at: new Date(delivery.createdAt).toISOString(),
          request_headers: {
            "X-Gitlab-Event": delivery.event, "Idempotency-Key": delivery.webhookId, "webhook-id": delivery.webhookId,
          },
        })), { headers: { "x-next-page": more ? String(page + 1) : "" } });
      })
      .on("POST", new RegExp(`^${HOOKS}/\\d+/events/\\d+/resend$`), async request => {
        const [, hookId, deliveryId] = /hooks\/(\d+)\/events\/(\d+)/.exec(request.url.pathname)!.map(Number);
        const delivery = this.log.find(logged => logged.id === deliveryId && logged.hookId === hookId)!;
        const webhook = this.webhooks.get(hookId);
        if (webhook?.url !== delivery.url) {
          return json({ message: "The hook URL has changed. This log entry cannot be retried." }, { status: 422 });
        }
        this.resends.push(deliveryId);
        return json({ response_status: await this.#attempt(webhook, delivery.webhookId, delivery.event, delivery.body) });
      })
      .on("PUT", new RegExp(`^${HOOKS}/(\\d+)$`), request => {
        const id = Number(/hooks\/(\d+)/.exec(request.url.pathname)![1]);
        if (!this.webhooks.has(id)) return notFound();
        const webhook = this.#configured(id, request.body!);
        this.webhooks.set(id, webhook);
        return json(this.#reported(webhook));
      })
      .on("DELETE", new RegExp(`^${HOOKS}/(\\d+)$`), async request => {
        const id = Number(/hooks\/(\d+)/.exec(request.url.pathname)![1]);
        if (this.stallDeletes) {
          this.stalledDeletes++;
          while (this.stallDeletes) await scheduler.wait(1);
        }
        if (!this.webhooks.delete(id)) return notFound();
        this.deleted.push(id);
        return new Response(null, { status: 204 });
      });
    this.gitlab.install();
  }

  #configured(id: number, body: string): Webhook {
    const config = JSON.parse(body) as Row;
    return {
      id, url: String(config.url),
      ...this.signs && typeof config.signing_token === "string" ? { signingToken: config.signing_token } : {},
      triggers: Object.keys(config).filter(key => key.endsWith("_events") && config[key] === true).toSorted(),
    };
  }

  #reported({ id, url, signingToken, triggers, alertStatus = "executable" }: Webhook): Row {
    return {
      id, url, alert_status: alertStatus, enable_ssl_verification: true,
      ...Object.fromEntries(triggers.map(trigger => [trigger, true])),
      ...this.version.startsWith("18.") ? {} : { signing_token_present: signingToken !== undefined },
    };
  }

  /**
   * Deliver one event as GitLab would: to each of the project's webhooks with its trigger on,
   * signed with its signing token, at `sentAt`.
   */
  async deliver(event: string, payload: object, { id = crypto.randomUUID(), sentAt = Date.now(), signingToken }: {
    id?: string; sentAt?: number; signingToken?: string;
  } = {}): Promise<number[]> {
    const body = JSON.stringify(payload);
    // GitLab sends nothing while it holds a webhook back after failures.
    const subscribed = [...this.webhooks.values()].filter(webhook =>
      webhook.triggers.includes(TRIGGERS[event]) && (webhook.alertStatus ?? "executable") === "executable");
    return await Promise.all(subscribed.map(webhook => this.#attempt(webhook, id, event, body, { sentAt, signingToken })));
  }

  /** Log `count` deliveries to a webhook that succeeded, as a busy project's would. */
  logDelivered(hookId: number, count: number): void {
    const { url } = this.webhooks.get(hookId)!;
    for (let i = 0; i < count; i++) {
      this.log.push({
        id: this.#nextDeliveryId++, hookId, webhookId: crypto.randomUUID(), event: "Issue Hook", body: "{}", url,
        status: "204", createdAt: Date.now(),
      });
    }
  }

  /** One attempt at a delivery, signed with its timestamp, and logged as GitLab logs it. */
  async #attempt(webhook: Webhook, id: string, event: string, body: string, { sentAt = Date.now(), signingToken }: {
    sentAt?: number; signingToken?: string;
  } = {}): Promise<number> {
    // Somewhere other than this deployment, which answers for itself.
    let status = this.failDeliveriesWith ?? (webhook.url.startsWith("https://gadgets.test/") ? undefined : 502);
    if (status === undefined) {
      const token = signingToken ?? webhook.signingToken;
      const timestamp = String(Math.floor(sentAt / 1000));
      const headers: Record<string, string> = {
        "Content-Type": "application/json", "X-Gitlab-Event": event, "webhook-id": id, "webhook-timestamp": timestamp,
      };
      if (token !== undefined) headers["webhook-signature"] = await sign(token, id, timestamp, body);
      status = (await SELF.fetch(webhook.url, { method: "POST", headers, body })).status;
    }
    this.log.push({
      id: this.#nextDeliveryId++, hookId: webhook.id, webhookId: id, event, body, url: webhook.url,
      status: String(status), createdAt: Date.now(),
    });
    return status;
  }
}

/** A connected account, whose token outlives the hours these tests move the clock on by. */
const connectAccount = () => seedAccount({ expiresInMs: 7 * 24 * HOUR });

let nextScenario = 0;

/** A binding of the account's, with one hook TestHooks can subscribe, enable and fire. */
function binding(account: string, overrides: Partial<GatekeeperProps> = {}) {
  const scenario = `gitlab-hooks-${nextScenario++}`;
  const props: GatekeeperProps = { userObjectId: account, resourceKind: "project", projectPath: PROJECT, ...overrides };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    hooks,
    scenario,
    props,
    subscribe: async (options?: GitLabSubscribeOptions, target?: { kind: "issue" | "mergeRequest"; id: string }) =>
      await unwrap<HookDescription>(await hooks.subscribeHook(scenario, props, options, target)),
    enable: async () => await unwrap(await hooks.enableHook()),
    disable: () => hooks.disableHook(),
    read: () => hooks.readHook(),
  };
}

const driver = (account: string) => env.GITLAB_HOOK_DRIVER.getByName(account);

/**
 * Wait until the account's driver has no delivery due: its own alarm runs them, and forcing that
 * alarm here as well would deliver one event twice from two concurrent alarm() calls.
 */
const settled = (account: string) => vi.waitFor(() => runInDurableObject(driver(account), (_instance, state) => {
  const due = [...state.storage.kv.list<{ at?: number }>({ prefix: "msg:" })]
    .filter(([, row]) => row.at !== undefined && row.at <= Date.now());
  if (due.length > 0) throw new Error(`${due.length} deliveries due`);
}));

/** Run the driver's alarm at `ms` from now, on a faked clock the runtime itself never wakes for. */
async function after(ms: number, account: string): Promise<void> {
  vi.setSystemTime(Date.now() + ms);
  try {
    await runDurableObjectAlarm(driver(account));
  } finally {
    vi.useRealTimers();
  }
}

/**
 * Each step at a set time from now, with the driver's alarm run by hand: the runtime never runs
 * one on a faked clock.
 */
function clock(account: string) {
  const start = Date.now();
  return {
    at: async <T>(offset: number, step: () => Promise<T>): Promise<T> => {
      vi.setSystemTime(start + offset);
      try {
        return await step();
      } finally {
        vi.useRealTimers();
      }
    },
    alarm: () => runDurableObjectAlarm(driver(account)),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it("adds the webhook once a hook is enabled, and delivers the events it watches for", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);

  expect(await triage.subscribe({ events: ["issue"] })).toEqual({
    title: `Watch ${PROJECT} on GitLab`,
    description: `Call this hook with each issue event in ${PROJECT}, letting it read each one and queue ` +
      "changes there for approval. Enabling it adds a webhook to the project on GitLab, unless an earlier " +
      "hook there already has.",
  });
  // A hook is bound disabled, so nothing changes on GitLab until the user enables it.
  expect(gitlab.webhooks.size).toBe(0);
  await triage.enable();
  expect([...gitlab.webhooks.values()]).toEqual([{
    id: 100,
    url: `https://gadgets.test/gatekeeper/gitlab/webhook/${env.GITLAB_HOOK_DRIVER.idFromName(account)}`,
    signingToken: expect.stringMatching(/^whsec_[A-Za-z0-9+/]{43}=$/),
    // Only what its hooks watch, so GitLab doesn't deliver the push below at all.
    triggers: ["issues_events"],
  }]);
  // Confidential issues and internal comments are never asked for.
  const [created] = gitlab.gitlab.requests.filter(request => request.method === "POST");
  expect(JSON.parse(created.body!)).toMatchObject({
    confidential_issues_events: false, confidential_note_events: false, enable_ssl_verification: true,
  });

  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([204]);
  expect(await gitlab.deliver("Issue Hook", issueHook("update", 42))).toEqual([204]);
  expect(await gitlab.deliver("Push Hook", pushHook("push", "refs/heads/main", BASE, HEAD))).toEqual([]);
  await settled(account);

  const { received, observations } = await triage.read();
  expect(received).toEqual([{
    kind: "issue", id: expect.any(String), action: "opened",
    actor: { username: "bob", displayName: "Bob", url: `${WEB}/bob`, avatarUrl: "https://avatars.example/bob" },
    // Read through the REST API, as `getDetails()` reads it: the webhook doesn't carry these.
    info: expect.objectContaining({
      id: "42", title: "Crash on start", bodyMarkdown: fx.issueResponse.data.description,
      author: expect.objectContaining({ username: "root" }), commentCount: 1, labels: [{ name: "bug" }],
      url: `${WEB}/${PROJECT}/-/issues/42`,
    }),
  }]);
  expect(observations).toEqual([{
    title: "GitLab issue #42 opened: Crash on start",
    description: `Receive issue #42 in ${PROJECT}, opened by \`@bob\`: its title, description, author, ` +
      "assignees, and labels.",
  }]);
});

it("queues a hook's writes on its firing, and never hands the account its own comments or reviews", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const responder = binding(account);
  await responder.subscribe({ events: ["comment", "review"] });
  await responder.enable();
  await responder.hooks.setHookBehavior({ reply: "On it." });

  await gitlab.deliver("Note Hook", noteHook("Issue", 42, "Please look.", { id: 1 }));
  await gitlab.deliver("Note Hook", noteHook("Issue", 42, "On it.", { id: 2, sender: ADA }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("approval", 7, {}, {}, ADA));
  await settled(account);

  const { received, submissions } = await responder.read();
  expect(received).toEqual([expect.objectContaining({
    kind: "comment", comment: expect.objectContaining({ bodyMarkdown: "Please look." }),
  })]);
  expect(submissions).toEqual([{ actionId: expect.any(Number), title: "Comment on #42" }]);
});

it("delivers a merge request's lifecycle, reviews and diff comments, advertising its commits", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const reviewer = binding(account);
  await reviewer.subscribe({ events: ["mergeRequest", "review", "comment"] });
  await reviewer.enable();

  await gitlab.deliver("Merge Request Hook", mergeRequestHook("open", 7));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("update", 7, { oldrev: BASE }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("update", 7, {}, { draft: { previous: true, current: false } }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("update", 7, {}, { title: { previous: "a", current: "b" } }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("merge", 7, { state: "merged" }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("approval", 7));
  // GitLab's own unapproval on a push is no one's review; a re-request is no review at all.
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("approval", 7, { system: true }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("update", 7, {}, reviewerState("review_started", "requested_changes")));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("update", 7, {}, reviewerState("approved", "unreviewed")));
  await gitlab.deliver("Note Hook", noteHook("MergeRequest", 7, "Off by one here.", { diff: true }));
  // An edit is no new comment, and an internal one is never delivered.
  await gitlab.deliver("Note Hook", noteHook("MergeRequest", 7, "Off by one, here.", { diff: true, action: "update" }));
  await gitlab.deliver("Note Hook", noteHook("MergeRequest", 7, "Between us.", { id: 1250, internal: true }));
  await settled(account);

  const { received, observations, advertised } = await reviewer.read();
  const byKind = (kind: string) => received.filter(event => event.kind === kind);
  expect(byKind("mergeRequest").map(event => "action" in event && event.action).toSorted())
    .toEqual(["merged", "opened", "pushed", "readyForReview"]);
  expect(byKind("mergeRequest")[0]).toMatchObject({
    info: { id: "7", title: "Fix the crash", source: { branch: "fix", sha: HEAD }, approvedBy: [{ username: "root" }] },
  });
  expect(byKind("review").map(event => "decision" in event && event.decision).toSorted())
    .toEqual(["approve", "requestChanges"]);
  expect(byKind("review")[0]).toMatchObject({
    actor: { username: "bob" },
    subject: { kind: "mergeRequest", id: "7", title: "Fix the crash", url: `${WEB}/${PROJECT}/-/merge_requests/7` },
  });
  expect(byKind("comment")).toEqual([expect.objectContaining({
    subject: expect.objectContaining({ kind: "mergeRequest", id: "7" }),
    comment: expect.objectContaining({
      id: "1241", bodyMarkdown: "Off by one here.", threadId: "d".repeat(40),
      target: { path: "src/app.ts", subjectType: "line", line: 12, side: "new" },
      url: `${WEB}/${PROJECT}/-/merge_requests/7#note_1241`,
    }),
  })]);
  expect(observations).toContainEqual({
    title: "GitLab merge request !7 marked ready: Fix the crash",
    description: `Receive merge request !7 in ${PROJECT}, marked ready by \`@bob\`: its title, description, ` +
      "author, assignees, reviewers, approvals, labels, branches, and merge status.",
  });
  expect(observations).toContainEqual({
    title: "GitLab comment on !7: Fix the crash",
    description: `Read a new comment by \`@bob\` on the diff of merge request !7 in ${PROJECT}.`,
  });
  expect(new Set(advertised)).toEqual(new Set([HEAD, BASE]));
});

it("delivers branch pushes and tag pushes, each to hooks that watch for them", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const deployer = binding(account);
  const releaser = binding(account);
  await deployer.subscribe({ events: ["push"] });
  await releaser.subscribe({ events: ["tag"] });
  await deployer.enable();
  await releaser.enable();

  await gitlab.deliver("Push Hook", pushHook("push", "refs/heads/release/1.0", ZERO, HEAD));
  await gitlab.deliver("Tag Push Hook", pushHook("tag_push", "refs/tags/v1.0", ZERO, HEAD));
  await gitlab.deliver("Tag Push Hook", pushHook("tag_push", "refs/tags/v0.9", BASE, ZERO));
  await settled(account);

  const pushes = await deployer.read();
  expect(pushes.received).toEqual([expect.objectContaining({
    kind: "push", branch: "release/1.0", after: HEAD, actor: expect.objectContaining({ username: "ada" }),
  })]);
  expect(pushes.received[0]).toMatchObject({ before: undefined });
  expect(pushes.observations).toEqual([{
    title: "GitLab push to release/1.0 in group/sub/project",
    description: `Receive a push by \`@ada\` to branch \`release/1.0\` of ${PROJECT}, creating it at \`${HEAD}\`.`,
  }]);
  // A created branch had no head before the push, which is not a commit to advertise.
  expect(pushes.advertised).toEqual([HEAD]);

  const tags = await releaser.read();
  expect(tags.received.map(event => "tag" in event && event.tag).toSorted()).toEqual(["v0.9", "v1.0"]);
  expect(tags.observations).toContainEqual({
    title: "GitLab push of tag v0.9 in group/sub/project",
    description: `Receive a push by \`@ada\` of tag \`v0.9\` in ${PROJECT}, deleting it.`,
  });
  // An annotated tag names its tag object rather than a commit.
  expect(tags.advertised).toEqual([]);
});

it("gives a hook on one issue only that issue's events, never the merge request numbered alike", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const issueBinding = binding(account, { resourceKind: "issue", iid: 42 });
  expect((await issueBinding.subscribe()).description).toMatch(
    new RegExp(`^Call this hook with each issue and comment event in issue #42 in ${PROJECT},`));
  await issueBinding.enable();
  // The same, through a project binding's issue.
  const narrowed = binding(account);
  await narrowed.subscribe(undefined, { kind: "issue", id: "42" });
  await narrowed.enable();

  await gitlab.deliver("Issue Hook", issueHook("close", 43));
  await gitlab.deliver("Note Hook", noteHook("MergeRequest", 42, "Not the issue.", { id: 5 }));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("open", 42));
  await gitlab.deliver("Push Hook", pushHook("push", "refs/heads/main", BASE, HEAD));
  await gitlab.deliver("Issue Hook", issueHook("reopen", 42));
  await gitlab.deliver("Note Hook", noteHook("Issue", 42, "Here.", { id: 6 }));
  await settled(account);

  for (const hook of [issueBinding, narrowed]) {
    const { received } = await hook.read();
    expect(received.map(event => event.kind).toSorted()).toEqual(["comment", "issue"]);
  }
  // One webhook serves every hook the account has on the project.
  expect(gitlab.webhooks.size).toBe(1);
});

it("keeps an issue binding's hooks to its issue, whatever their delivery stub's parameters", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const issueBinding = binding(account, { resourceKind: "issue", iid: 42 });
  await issueBinding.subscribe();

  // Parameters only this binding's subscribe() seals, here claiming the whole project or another number.
  await issueBinding.hooks.deliverDirectly(issueBinding.scenario, issueBinding.props, {}, storedEvent("issue", 43));
  await issueBinding.hooks.deliverDirectly(issueBinding.scenario, issueBinding.props,
    { target: { kind: "issue", iid: 43 } }, storedEvent("issue", 43));
  await issueBinding.hooks.deliverDirectly(issueBinding.scenario, issueBinding.props, {}, storedEvent("mergeRequest", 42));
  await issueBinding.hooks.deliverDirectly(issueBinding.scenario, issueBinding.props, {}, storedEvent("issue", 42));

  expect((await issueBinding.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
  // Delivered without any webhook: these deliveries came straight to the facet.
  expect(gitlab.webhooks.size).toBe(0);
});

it("gives a hook on one merge request its lifecycle, comments and reviews", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const mergeRequestBinding = binding(account, { resourceKind: "mergeRequest", iid: 7 });
  expect((await mergeRequestBinding.subscribe()).description).toMatch(
    new RegExp(`^Call this hook with each merge request, comment and review event in merge request !7 in ${PROJECT},`));
  await mergeRequestBinding.enable();

  await gitlab.deliver("Merge Request Hook", mergeRequestHook("open", 7));
  await gitlab.deliver("Note Hook", noteHook("MergeRequest", 7, "LGTM"));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("approval", 7));
  await gitlab.deliver("Merge Request Hook", mergeRequestHook("open", 8));
  await gitlab.deliver("Note Hook", noteHook("Issue", 7, "Not the merge request.", { id: 9 }));
  await settled(account);

  const { received } = await mergeRequestBinding.read();
  expect(received.map(event => event.kind).toSorted()).toEqual(["comment", "mergeRequest", "review"]);
});

it("refuses deliveries that aren't signed with the webhook's signing token, or recently", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ url, signingToken }] = gitlab.webhooks.values();

  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42), {
    signingToken: `whsec_${btoa("x".repeat(32))}`,
  })).toEqual([401]);
  // A captured delivery replayed after the signature's tolerance.
  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42), { sentAt: Date.now() - 10 * 60_000 }))
    .toEqual([401]);
  const unsigned = await SELF.fetch(url, {
    method: "POST", body: "{}",
    headers: { "X-Gitlab-Event": "Issue Hook", "webhook-id": crypto.randomUUID(), "webhook-timestamp": "1" },
  });
  expect(unsigned.status).toBe(401);
  const unnamed = await SELF.fetch(url, { method: "POST", body: "{}" });
  expect(unnamed.status).toBe(400);
  const elsewhere = await SELF.fetch(url.replace(/[0-9a-f]{64}$/, "f".repeat(64)), {
    method: "POST", body: "{}", headers: { "X-Gitlab-Event": "Issue Hook" },
  });
  expect(elsewhere.status).toBe(404);
  // Signed, but for a project this webhook isn't on, or not JSON at all.
  expect(await gitlab.deliver("Issue Hook", { ...issueHook("open", 42), project: { ...projectPayload, id: 999 } }))
    .toEqual([404]);
  const id = crypto.randomUUID();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const garbled = await SELF.fetch(url, {
    method: "POST", body: "not json",
    headers: {
      "X-Gitlab-Event": "Issue Hook", "webhook-id": id, "webhook-timestamp": timestamp,
      "webhook-signature": await sign(signingToken!, id, timestamp, "not json"),
    },
  });
  expect(garbled.status).toBe(400);
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  const headers = {
    "X-Gitlab-Event": "Issue Hook", "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": "v1,AAAA",
  };
  expect((await SELF.fetch(url, { method: "POST", body: oversized, headers })).status).toBe(413);
  const streamed = new ReadableStream({ type: "bytes", start(controller) {
    controller.enqueue(oversized);
    controller.close();
  } });
  expect((await SELF.fetch(url, { method: "POST", body: streamed, headers })).status).toBe(413);
  await settled(account);

  expect((await triage.read()).received).toEqual([]);
});

it("delivers an event once, however often GitLab delivers it", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  // A retry and a resend repeat the delivery's id, each signed afresh.
  const id = crypto.randomUUID();
  await gitlab.deliver("Issue Hook", issueHook("open", 42), { id });
  await gitlab.deliver("Issue Hook", issueHook("open", 42), { id, sentAt: Date.now() + 1000 });
  await gitlab.deliver("Issue Hook", issueHook("reopen", 41), { id });
  await settled(account);

  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
});

it.each([
  ["the hook failed", { failures: 1 }],
  ["whose firing the Workshop failed to start", { admissionFailures: 1 }],
])("retries a delivery %s", async (_, behavior) => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  await triage.hooks.setHookBehavior(behavior);

  await gitlab.deliver("Issue Hook", issueHook("open", 42));
  await settled(account);
  expect((await triage.read()).received).toEqual([]);
  await after(60_000, account);

  expect((await triage.read()).received).toHaveLength(1);
});

it("shares one webhook among an account's hooks on a project, and deletes it with the last", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const first = binding(account);
  const second = binding(account);
  await first.subscribe();
  await second.subscribe();

  await Promise.all([first.enable(), second.enable()]);
  expect(gitlab.webhooks.size).toBe(1);
  await first.disable();
  expect(gitlab.deleted).toEqual([]);
  await second.disable();
  expect(gitlab.deleted).toEqual([100]);

  await first.enable();
  expect([...gitlab.webhooks.keys()]).toEqual([101]);
  await gitlab.deliver("Issue Hook", issueHook("open", 42));
  await settled(account);
  expect((await first.read()).received).toHaveLength(1);
  expect((await second.read()).received).toEqual([]);
});

it("turns on the webhook triggers its hooks watch, as they are enabled and disabled", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  const reviewer = binding(account);
  const deployer = binding(account);
  await triage.subscribe({ events: ["issue", "comment"] });
  await reviewer.subscribe({ events: ["review"] });
  await deployer.subscribe({ events: ["push", "tag"] });
  const triggers = () => [...gitlab.webhooks.values()].map(webhook => webhook.triggers);

  await triage.enable();
  expect(triggers()).toEqual([["issues_events", "note_events"]]);
  await reviewer.enable();
  expect(triggers()).toEqual([["issues_events", "merge_requests_events", "note_events"]]);
  await deployer.enable();
  expect(triggers()).toEqual([["issues_events", "merge_requests_events", "note_events", "push_events", "tag_push_events"]]);
  await deployer.disable();
  await reviewer.disable();
  expect(triggers()).toEqual([["issues_events", "note_events"]]);
  await triage.disable();
  expect(triggers()).toEqual([]);
});

it("leaves a working webhook when a hook is enabled while the last one's is being deleted", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const first = binding(account);
  const second = binding(account);
  await first.subscribe();
  await second.subscribe();
  await first.enable();

  gitlab.stallDeletes = true;
  const disabling = first.disable();
  await vi.waitFor(() => expect(gitlab.stalledDeletes).toBe(1));
  const enabling = second.enable();
  // Time for the enable to reach the driver, which must not touch the webhook being deleted.
  await scheduler.wait(100);
  gitlab.stallDeletes = false;
  await Promise.all([disabling, enabling]);

  expect(gitlab.deleted).toEqual([100]);
  expect([...gitlab.webhooks.keys()]).toEqual([101]);
  await gitlab.deliver("Issue Hook", issueHook("open", 42));
  await settled(account);
  expect((await second.read()).received).toHaveLength(1);
});

it("gives each account its own webhook on a project, and each its own events", async () => {
  const gitlab = new FakeGitLabHooks();
  const [ada, carol] = await Promise.all([connectAccount(), connectAccount()]);
  const adaHook = binding(ada);
  const carolHook = binding(carol);
  await adaHook.subscribe();
  await carolHook.subscribe();
  await adaHook.enable();
  await carolHook.enable();
  expect(gitlab.webhooks.size).toBe(2);

  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([204, 204]);
  await settled(ada);
  await settled(carol);

  expect((await adaHook.read()).received).toHaveLength(1);
  expect((await carolHook.read()).received).toHaveLength(1);
  // One account's signing token signs nothing another's will accept.
  const [adaWebhook, carolWebhook] = gitlab.webhooks.values();
  gitlab.webhooks.set(carolWebhook.id, { ...carolWebhook, signingToken: adaWebhook.signingToken });
  expect(await gitlab.deliver("Issue Hook", issueHook("reopen", 42))).toEqual([204, 401]);
});

it("adopts the webhook an earlier attempt left on the project", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const url = `https://gadgets.test/gatekeeper/gitlab/webhook/${env.GITLAB_HOOK_DRIVER.idFromName(account)}`;
  gitlab.webhooks.set(5, { id: 5, url, signingToken: `whsec_${btoa("l".repeat(32))}`, triggers: ["push_events"] });
  const triage = binding(account);
  await triage.subscribe();

  await triage.enable();
  // GitLab would take a second webhook with the same URL, which would deliver everything twice.
  expect(gitlab.webhooks.size).toBe(1);
  expect(gitlab.webhooks.get(5)).toMatchObject({ url, triggers: expect.arrayContaining(["issues_events"]) });
  expect(gitlab.webhooks.get(5)?.signingToken).not.toBe(`whsec_${btoa("l".repeat(32))}`);
  await gitlab.deliver("Issue Hook", issueHook("open", 42));
  await settled(account);
  expect((await triage.read()).received).toHaveLength(1);
});

it("has GitLab resend, at its next hourly check, what GitLab failed to deliver", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id: webhookId }] = gitlab.webhooks.values();
  const { at, alarm } = clock(account);

  await at(0, async () => {
    gitlab.failDeliveriesWith = 503;
    await gitlab.deliver("Issue Hook", issueHook("open", 42));
    gitlab.failDeliveriesWith = undefined;
    // Refused for good: it's for a project this webhook isn't on.
    expect(await gitlab.deliver("Issue Hook", { ...issueHook("open", 43), project: { ...projectPayload, id: 999 } }))
      .toEqual([404]);
    // A busy hour since, which leaves the failure past the first page of the webhook's delivery log.
    gitlab.logDelivered(webhookId, 25);
  });
  await at(HOUR, alarm);

  expect(gitlab.resends).toHaveLength(1);
  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
  // Delivered at last, it isn't resent again.
  await at(2 * HOUR, alarm);
  expect(gitlab.resends).toHaveLength(1);
});

it("has GitLab resend at most five deliveries to a project at each check, as GitLab allows", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const { at, alarm } = clock(account);

  await at(0, async () => {
    gitlab.failDeliveriesWith = 503;
    for (let iid = 1; iid <= 7; iid++) await gitlab.deliver("Issue Hook", issueHook("open", iid));
    gitlab.failDeliveriesWith = undefined;
  });
  await at(HOUR, alarm);
  expect(gitlab.resends).toHaveLength(5);
  await at(2 * HOUR, alarm);

  expect(gitlab.resends).toHaveLength(7);
  expect((await triage.read()).received).toHaveLength(7);
});

it.each<[string, (gitlab: FakeGitLabHooks, webhook: Webhook) => void]>([
  ["deletes it", (gitlab, webhook) => { gitlab.webhooks.delete(webhook.id); }],
  ["points it elsewhere", (_gitlab, webhook) => { webhook.url = "https://elsewhere.example/hook"; }],
  ["turns on another of its triggers", (_gitlab, webhook) => { webhook.triggers = [...webhook.triggers, "push_events"]; }],
  ["turns on confidential issues", (_gitlab, webhook) => { webhook.triggers = [...webhook.triggers, "confidential_issues_events"]; }],
  ["removes its signing token", (_gitlab, webhook) => { webhook.signingToken = undefined; }],
])("restores its webhook at the next hourly check when someone %s", async (_, change) => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe({ events: ["issue"] });
  await triage.enable();
  const [webhook] = gitlab.webhooks.values();
  const configured = { ...webhook };
  change(gitlab, webhook);

  await clock(account).at(HOUR, () => runDurableObjectAlarm(driver(account)));
  expect([...gitlab.webhooks.values()]).toEqual([{ ...configured, id: expect.any(Number) }]);
  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([204]);
  await settled(account);
  expect((await triage.read()).received).toHaveLength(1);
});

it("never has GitLab resend what it sent while someone had pointed the webhook elsewhere", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [webhook] = gitlab.webhooks.values();
  const { at, alarm } = clock(account);

  // Not this deployment's to answer, or GitLab's to resend once the URL is restored.
  webhook.url = `${WEB}/elsewhere`;
  await at(0, async () => expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).not.toEqual([204]));
  await at(HOUR, alarm);

  expect(gitlab.webhooks.get(webhook.id)?.url).toMatch(/^https:\/\/gadgets\.test\//);
  expect(gitlab.gitlab.count("POST", /\/resend$/)).toBe(0);
});

it("recreates a webhook GitLab gave up on, and leaves one it holds back to GitLab", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [webhook] = gitlab.webhooks.values();
  const { at, alarm } = clock(account);
  await at(0, async () => {
    gitlab.failDeliveriesWith = 503;
    await gitlab.deliver("Issue Hook", issueHook("open", 42));
    gitlab.failDeliveriesWith = undefined;
  });

  // Held back after four failures, it is revived by GitLab, which sends nothing meanwhile.
  webhook.alertStatus = "temporarily_disabled";
  await at(HOUR, alarm);
  expect(gitlab.gitlab.requests.filter(request => request.method !== "GET")).toEqual(
    gitlab.gitlab.requests.filter(request => request.method === "POST" && request.url.pathname === HOOKS));
  expect(gitlab.resends).toEqual([]);
  // Disabled for good after forty, it is revived by nothing an edit does.
  webhook.alertStatus = "disabled";
  await at(2 * HOUR, alarm);
  expect(gitlab.deleted).toEqual([webhook.id]);
  expect([...gitlab.webhooks.values()]).toEqual([expect.objectContaining({ id: webhook.id + 1, triggers: webhook.triggers })]);
  expect(await gitlab.deliver("Issue Hook", issueHook("open", 43))).toEqual([204]);
});

it("restores its webhook's signing token, has GitLab resend what the wrong one signed, then leaves it", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id, signingToken }] = gitlab.webhooks.values();
  const { at, alarm } = clock(account);

  gitlab.webhooks.get(id)!.signingToken = `whsec_${btoa("o".repeat(32))}`;
  await at(HOUR / 2, async () => expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([401]));
  await at(HOUR, alarm);
  expect(gitlab.webhooks.get(id)?.signingToken).toBe(signingToken);
  expect(gitlab.resends).toHaveLength(1);
  expect((await triage.read()).received).toHaveLength(1);

  // The next check still reads the refused attempt, which a successful resend has superseded.
  gitlab.gitlab.requests.length = 0;
  await at(2 * HOUR, alarm);
  expect(gitlab.gitlab.requests.filter(request => request.method !== "GET")).toEqual([]);
});

it("changes nothing on GitLab while its webhook is intact, and stops checking with its last hook", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id }] = gitlab.webhooks.values();
  const webhookRequests = () => gitlab.gitlab.requests.splice(0)
    .filter(request => request.url.pathname.startsWith(HOOKS)).map(request => request.method);
  webhookRequests();

  await clock(account).at(HOUR, () => runDurableObjectAlarm(driver(account)));
  // The check reads what GitLab has, and writes nothing.
  const checked = webhookRequests();
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.filter(method => method !== "GET")).toEqual([]);
  await triage.disable();
  expect(webhookRequests()).toEqual(["DELETE"]);
  expect(gitlab.webhooks.has(id)).toBe(false);
  expect(await runInDurableObject(driver(account), (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("delivers nothing once the account can no longer read the project, even just after a delivery", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  // The first delivery caches the project's id and the issue's details, which no later one trusts.
  await gitlab.deliver("Issue Hook", issueHook("open", 42));
  await settled(account);
  gitlab.readable = false;
  await gitlab.deliver("Issue Hook", issueHook("reopen", 42));
  await gitlab.deliver("Note Hook", noteHook("Issue", 42, "Meanwhile.", { id: 7 }));
  await settled(account);

  const { received, observations } = await triage.read();
  expect(received).toEqual([expect.objectContaining({ kind: "issue", action: "opened" })]);
  expect(observations).toHaveLength(1);
});

it.each([
  ["an issue's", "issue" as const, "close", { state: "closed" }],
  ["a merge request's", "mergeRequest" as const, "merge",
    { state: "merged", approvedBy: [expect.objectContaining({ username: "root" })] }],
])("gives %s event it as GitLab has it then, not as a read just before cached it", async (_, kind, action, then) => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe({ events: [kind] });
  await triage.enable();

  // Read while open, and a merge request before anyone approved it.
  gitlab.approvals.set(42, []);
  const read = kind === "issue"
    ? await unwrap(await triage.hooks.openIssue(triage.scenario, triage.props, "42"))
    : await unwrap(await triage.hooks.openMergeRequest(triage.scenario, triage.props, "42"));
  expect(read).toMatchObject({ state: "opened" });
  gitlab.states[kind].set(42, then.state);
  gitlab.approvals.delete(42);
  if (kind === "issue") await gitlab.deliver("Issue Hook", issueHook(action, 42));
  else await gitlab.deliver("Merge Request Hook", mergeRequestHook(action, 42, { state: then.state }));
  await settled(account);

  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining(then) })]);
});

it("delivers nothing once the account can no longer read the project", async () => {
  const gitlab = new FakeGitLabHooks();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  // Removed from the project, the account still has its webhook there: GitLab keeps delivering.
  gitlab.readable = false;
  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([204]);
  await settled(account);

  expect(await triage.read()).toMatchObject({ received: [], observations: [] });
});

it("refuses to watch a project whose webhooks the account can't manage", async () => {
  const gitlab = new FakeGitLabHooks();
  gitlab.maintainer = false;
  const account = await connectAccount();

  await expect(binding(account).subscribe()).rejects.toThrow(
    `GitLab delivers events to a webhook, which only a Maintainer or Owner of ${PROJECT} can add, and the ` +
    "connected account is not one.");
});

it("refuses to watch on a GitLab that cannot sign webhook deliveries", async () => {
  const gitlab = new FakeGitLabHooks();
  gitlab.version = "18.11.2-ee";
  const account = await connectAccount();
  await expect(binding(account).subscribe()).rejects.toThrow(
    `GitLab hooks need GitLab 19.0 or later, which signs webhook deliveries, and ${WEB} runs 18.11.2-ee.`);

  // One that claims a version it doesn't have gets no webhook it couldn't verify.
  gitlab.version = "19.4.0-ee";
  gitlab.signs = false;
  const triage = binding(account);
  await triage.subscribe();
  await expect(triage.enable()).rejects.toThrow("GitLab hooks need GitLab 19.0 or later, which signs webhook deliveries.");
  expect(gitlab.webhooks.size).toBe(0);
});

it("deletes a disconnected account's webhooks and delivers nothing more", async () => {
  const gitlab = new FakeGitLabHooks();
  gitlab.gitlab.on("POST", /^\/oauth\/revoke$/, () => json({}));
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  const [webhook] = gitlab.webhooks.values();
  await unwrap(await triage.hooks.revokeAccount(account));
  expect(gitlab.deleted).toEqual([webhook.id]);
  // Were GitLab to deliver anyway, the driver no longer answers for the webhook.
  gitlab.webhooks.set(webhook.id, webhook);
  expect(await gitlab.deliver("Issue Hook", issueHook("open", 42))).toEqual([404]);
  await expect(triage.enable()).rejects.toThrow("This GitLab account has been disconnected.");
  expect((await triage.read()).received).toEqual([]);
});
