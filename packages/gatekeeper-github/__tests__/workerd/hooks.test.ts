// GitHub event hooks, end to end inside the gatekeeper worker: a facet restored the way the
// Overseer restores it binds the hook, TestHooks enables it and answers each firing, GitHub is the
// fetch mock below, and its signed webhook deliveries arrive through the worker's own fetch handler.

import { SELF, env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import type { HookDescription } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, expect, it, vi } from "vitest";
import type { GitHubSubscribeOptions } from "../../src/types";
import type { GatekeeperProps, Outcome } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const REPO_ID = 1296269;
const API = `/repos/${OWNER}/${REPO}`;
const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);
const ZERO = "0".repeat(40);
/** When the events here happen: an event older than a day is refused as a replay. */
const CREATED = new Date().toISOString();

type Row = Record<string, unknown>;
type Webhook = {
  id: number; url: string; secret: string; events: string[]; active: boolean;
  /** The name of the repository it is on, in `acme`. */
  repo: string;
  /** `"json"` or `"form"`, GitHub's `config.content_type`. */
  contentType: string;
  /** `"0"` to verify the receiver's certificate, GitHub's `config.insecure_ssl`. */
  insecureSsl: string;
};
/** One attempt at a delivery, as GitHub logs it. */
type Delivery = {
  id: number; hookId: number; guid: string; event: string; body: string; status_code: number; delivered_at: string;
};

const HOUR = 3_600_000;

const user = (login: string, id: number) =>
  ({ id, login, html_url: `https://github.com/${login}`, avatar_url: `https://avatars.example/${login}` });
/** The connected account. */
const ADA = user("ada", 7);
const BOB = user("bob", 8);

const repository = {
  id: REPO_ID, name: REPO, full_name: `${OWNER}/${REPO}`, html_url: `https://github.com/${OWNER}/${REPO}`,
  default_branch: "main", owner: user(OWNER, 1),
};

/** A second repository of the account's, for what spans repositories. */
const gizmos = {
  ...repository, id: 4242, name: "gizmos", full_name: `${OWNER}/gizmos`, html_url: `https://github.com/${OWNER}/gizmos`,
};
const REPOSITORIES: Record<string, typeof repository> = { [REPO]: repository, gizmos };

function issue(number: number, overrides: Row = {}): Row {
  return {
    number, html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`, title: "Crash on start",
    state: "open", body: "It crashes.", user: BOB, labels: [{ name: "bug" }], assignees: [],
    created_at: CREATED, updated_at: CREATED, closed_at: null, comments: 0, ...overrides,
  };
}

function pull(number: number, overrides: Row = {}): Row {
  return {
    ...issue(number, { html_url: `https://github.com/${OWNER}/${REPO}/pull/${number}`, title: "Fix the crash" }),
    draft: false, merged_at: null, mergeable: null, requested_reviewers: [], commits: 1, additions: 3,
    deletions: 1, changed_files: 1,
    head: { ref: "fix", sha: HEAD, repo: repository }, base: { ref: "main", sha: BASE, repo: repository },
    ...overrides,
  };
}

const issues = (action: string, number: number, sender = BOB) =>
  ({ action, repository, sender, issue: issue(number) });
const pullRequest = (action: string, number: number, overrides: Row = {}) =>
  ({ action, repository, sender: BOB, pull_request: pull(number, overrides) });
const comment = (number: number, body: string, { sender = BOB, onPullRequest = false } = {}) => ({
  action: "created", repository, sender,
  issue: issue(number, onPullRequest ? { pull_request: { url: "https://api.github.com/pulls/1" } } : {}),
  comment: {
    id: 900, html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}#issuecomment-900`, body,
    user: sender, created_at: CREATED, updated_at: CREATED,
  },
});
/** An issue event as the driver queues it, for delivering to a facet with no webhook involved. */
const storedIssueEvent = (number: number) => ({
  id: "e".repeat(64), repoId: REPO_ID, actor: null, kind: "issue", action: "opened", number, issue: issue(number),
});

/** A push, as GitHub delivers one: its repository carries `pushed_at`, in seconds, in this event alone. */
const push = (ref: string, before: string, head: string, extra: Row = {}) => ({
  ref, before, after: head, repository: { ...repository, pushed_at: Math.floor(Date.now() / 1000) }, ...extra,
});

async function hmac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return [...new Uint8Array(signature)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

/** GitHub, as far as hooks use it: the repository and who administers it, the viewer, webhooks. */
class FakeGitHub {
  admin = true;
  /** Whether the account can still read the repository at all. */
  readable = true;
  readonly webhooks = new Map<number, Webhook>();
  readonly deleted: number[] = [];
  /** Each request made to GitHub, as `METHOD /path`. */
  readonly requests: string[] = [];
  /** Every delivery attempt, oldest first. */
  readonly log: Delivery[] = [];
  /** While set, deliveries fail with this status without reaching the worker. */
  failDeliveriesWith: number | undefined;
  /** The deliveries the driver asked to have made again, which `redeliver()` makes. */
  #redeliveries: number[] = [];
  #nextDeliveryId = 1;
  /**
   * While set, a webhook DELETE stalls, counted in `stalledDeletes`. Polled rather than awaited:
   * a promise settled from the test would carry the test's I/O context into the driver.
   */
  stallDeletes = false;
  stalledDeletes = 0;
  /** How many repository reads GitHub answered 304, as it does a conditional read of an unchanged one. */
  notModified = 0;
  /** While set, GitHub agrees to this many more redeliveries, then refuses the rest with a 500. */
  redeliveriesAllowed: number | undefined;
  #nextId = 100;

  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) =>
      this.#handle(new Request(input, init)));
  }

  async #handle(request: Request): Promise<Response> {
    const { pathname, searchParams } = new URL(request.url);
    const { method } = request;
    this.requests.push(`${method} ${pathname}`);
    if (pathname === "/user") return Response.json(ADA);
    if (pathname === "/applications/test-client/token" && method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    const [, name = "", rest = ""] = new RegExp(`^/repos/${OWNER}/([^/]+)(/.*)?$`).exec(pathname) ?? [];
    const repo = REPOSITORIES[name];
    if (!repo) throw new Error(`test: unexpected fetch ${method} ${request.url}`);
    // An account that can't read the repository is refused whatever ETag it presents.
    if (rest === "" && !this.readable) return Response.json({ message: "Not Found" }, { status: 404 });
    if (rest === "") {
      const etag = `"repo-${name}-${this.admin}"`;
      if (request.headers.get("If-None-Match") === etag) {
        this.notModified++;
        return new Response(null, { status: 304, headers: { ETag: etag } });
      }
      return Response.json({ ...repo, permissions: { admin: this.admin } }, { headers: { ETag: etag } });
    }
    if (rest === "/issues/42") return Response.json(issue(42));
    if (rest.startsWith("/hooks") && !this.admin) {
      return Response.json({ message: "Not Found" }, { status: 404 });
    }
    const own = [...this.webhooks.values()].filter(webhook => webhook.repo === name);
    if (rest === "/hooks" && method === "GET") {
      return Response.json(own.map(({ id, url }) => ({ id, config: { url } })));
    }
    if (rest === "/hooks" && method === "POST") {
      const { config } = await request.clone().json<WebhookBody>();
      if (own.some(webhook => webhook.url === config.url)) {
        return Response.json({
          message: "Validation Failed", errors: [{ message: "Hook already exists on this repository" }],
        }, { status: 422 });
      }
      const id = this.#nextId++;
      this.webhooks.set(id, this.#configured(id, name, await request.json<WebhookBody>()));
      return Response.json({ id, config: { url: this.webhooks.get(id)!.url } }, { status: 201 });
    }
    const id = Number(/^\/hooks\/(\d+)/.exec(rest)?.[1]);
    const webhook = own.find(found => found.id === id);
    if (rest === `/hooks/${id}`) {
      if (method === "DELETE") {
        if (this.stallDeletes) {
          this.stalledDeletes++;
          while (this.stallDeletes) await scheduler.wait(1);
        }
        this.webhooks.delete(id);
        this.deleted.push(id);
        return new Response(null, { status: 204 });
      }
      if (!webhook) return Response.json({ message: "Not Found" }, { status: 404 });
      if (method === "GET") {
        const { url, events, active, contentType, insecureSsl } = webhook;
        return Response.json({
          id, active, events, config: { url, content_type: contentType, insecure_ssl: insecureSsl, secret: "********" },
        });
      }
      if (method === "PATCH") {
        this.webhooks.set(id, this.#configured(id, name, await request.json<WebhookBody>()));
        return Response.json({ id, config: { url: this.webhooks.get(id)!.url } });
      }
    }
    if (webhook && rest === `/hooks/${id}/deliveries` && method === "GET") {
      const perPage = Number(searchParams.get("per_page") ?? 30);
      const start = Number(searchParams.get("cursor") ?? 0);
      const newestFirst = this.log.filter(({ hookId }) => hookId === id).toReversed();
      const next = start + perPage < newestFirst.length
        ? `<https://api.github.com${pathname}?per_page=${perPage}&cursor=${start + perPage}>; rel="next"`
        : undefined;
      return Response.json(
        newestFirst.slice(start, start + perPage).map(({ id: deliveryId, guid, status_code, delivered_at }) =>
          ({ id: deliveryId, guid, status_code, delivered_at })),
        next === undefined ? {} : { headers: { Link: next } });
    }
    const redelivery = /^\/hooks\/\d+\/deliveries\/(\d+)\/attempts$/.exec(rest);
    if (webhook && redelivery && method === "POST") {
      if (this.redeliveriesAllowed !== undefined) {
        if (this.redeliveriesAllowed === 0) return Response.json({ message: "Server Error" }, { status: 500 });
        this.redeliveriesAllowed--;
      }
      this.#redeliveries.push(Number(redelivery[1]));
      return Response.json({}, { status: 202 });
    }
    throw new Error(`test: unexpected fetch ${method} ${request.url}`);
  }

  /**
   * Deliver one event as GitHub would: to each of the repository's webhooks that subscribes to it,
   * signed with its secret.
   */
  async deliver(event: string, payload: Row, { id = crypto.randomUUID(), secret }: {
    id?: string; secret?: string;
  } = {}): Promise<number[]> {
    const body = JSON.stringify(payload);
    const to = (payload.repository as { name?: string } | undefined)?.name ?? REPO;
    const subscribed = [...this.webhooks.values()].filter(webhook => webhook.repo === to &&
      webhook.active && (event === "ping" || webhook.events.includes(event)));
    return await Promise.all(subscribed.map(webhook => this.#attempt(webhook, id, event, body, secret)));
  }

  /** The redeliveries the driver has asked for and `redeliver()` hasn't made, by repository. */
  pendingRedeliveries(): Record<string, number> {
    const pending: Record<string, number> = {};
    for (const deliveryId of this.#redeliveries) {
      const { repo } = this.webhooks.get(this.log.find(({ id }) => id === deliveryId)!.hookId)!;
      pending[repo] = (pending[repo] ?? 0) + 1;
    }
    return pending;
  }

  /** Make the redeliveries the driver asked for, as GitHub does in its own time: signed afresh. */
  async redeliver(): Promise<number[]> {
    return await Promise.all(this.#redeliveries.splice(0).map(deliveryId => {
      const { hookId, guid, event, body } = this.log.find(({ id }) => id === deliveryId)!;
      return this.#attempt(this.webhooks.get(hookId)!, guid, event, body);
    }));
  }

  /** Log `count` deliveries to a webhook that succeeded, as a busy repository's would. */
  logDelivered(hookId: number, count: number): void {
    for (let i = 0; i < count; i++) {
      this.log.push({
        id: this.#nextDeliveryId++, hookId, guid: crypto.randomUUID(), event: "issues", body: "{}",
        status_code: 204, delivered_at: new Date().toISOString(),
      });
    }
  }

  #configured(id: number, repo: string, { events, config, active }: WebhookBody): Webhook {
    return {
      id, repo, url: config.url, secret: config.secret, events, active, contentType: config.content_type,
      insecureSsl: config.insecure_ssl,
    };
  }

  /**
   * One attempt at a delivery, encoded as the webhook is configured now: GitHub builds a
   * redelivery from the webhook's current configuration, as it signs one with the current secret.
   */
  async #attempt(webhook: Webhook, guid: string, event: string, body: string, secret = webhook.secret): Promise<number> {
    const [contentType, sent] = webhook.contentType === "form"
      ? ["application/x-www-form-urlencoded", `payload=${encodeURIComponent(body)}`]
      : ["application/json", body];
    const status = this.failDeliveriesWith ?? (await SELF.fetch(webhook.url, {
      method: "POST",
      headers: {
        "Content-Type": contentType, "X-GitHub-Event": event, "X-GitHub-Delivery": guid,
        "X-Hub-Signature-256": `sha256=${await hmac(secret, sent)}`,
      },
      body: sent,
    })).status;
    this.log.push({
      id: this.#nextDeliveryId++, hookId: webhook.id, guid, event, body, status_code: status,
      delivered_at: new Date().toISOString(),
    });
    return status;
  }
}

type WebhookBody = {
  events: string[]; config: { url: string; secret: string; content_type: string; insecure_ssl: string }; active: boolean;
};

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

/** A newly connected GitHub account's `UserAccount` id. */
async function connectAccount(): Promise<string> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  return id.toString();
}

let nextScenario = 0;

/** A binding of the account's, with one hook TestHooks can subscribe, enable and fire. */
function binding(account: string, overrides: Partial<GatekeeperProps> = {}) {
  const scenario = `hooks-${nextScenario++}`;
  const props: GatekeeperProps = { userObjectId: account, resourceKind: "repo", owner: OWNER, repo: REPO, ...overrides };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return {
    hooks,
    subscribe: (options?: GitHubSubscribeOptions, target?: { kind: "issue" | "pull"; id: string }) =>
      unwrap<HookDescription>(hooks.subscribeHook(scenario, props, options, target)),
    enable: () => unwrap(hooks.enableHook()),
    disable: () => hooks.disableHook(),
    read: () => hooks.readHook(),
  };
}

const driver = (account: string) => env.GITHUB_HOOK_DRIVER.getByName(account);

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
    at: async (offset: number, step: () => Promise<unknown>) => {
      vi.setSystemTime(start + offset);
      try {
        await step();
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
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);

  expect(await triage.subscribe({ events: ["issue"] })).toEqual({
    title: "Watch acme/widgets on GitHub",
    description: "Call this hook with each issue event in acme/widgets, letting it read each one and " +
      "queue changes there for approval. Enabling it adds a webhook to the repository on GitHub, " +
      "unless an earlier hook there already has.",
  });
  // A hook is bound disabled, so nothing changes on GitHub until the user enables it.
  expect(github.webhooks.size).toBe(0);
  await triage.enable();
  expect([...github.webhooks.values()]).toEqual([{
    id: 100,
    url: `https://gadgets.test/gatekeeper/github/webhook/${env.GITHUB_HOOK_DRIVER.idFromName(account)}`,
    secret: expect.stringMatching(/^[0-9a-f]{64}$/),
    // Only what its hooks watch, so GitHub doesn't deliver the push below at all.
    events: ["issues"],
    active: true,
    repo: REPO,
    contentType: "json",
    insecureSsl: "0",
  }]);

  expect(await github.deliver("ping", { zen: "Keep it logically awesome.", repository })).toEqual([204]);
  expect(await github.deliver("issues", issues("opened", 42))).toEqual([204]);
  expect(await github.deliver("issues", issues("labeled", 42))).toEqual([204]);
  expect(await github.deliver("push", push("refs/heads/main", BASE, HEAD))).toEqual([]);
  await settled(account);

  const { received, observations } = await triage.read();
  expect(received).toEqual([{
    kind: "issue", id: expect.stringMatching(/^[0-9a-f]{64}$/), action: "opened",
    actor: { login: "bob", url: "https://github.com/bob", avatarUrl: "https://avatars.example/bob" },
    info: expect.objectContaining({
      id: "42", title: "Crash on start", bodyMarkdown: "It crashes.", labels: [{ name: "bug" }],
      url: "https://github.com/acme/widgets/issues/42",
    }),
  }]);
  expect(observations).toEqual([{
    title: "GitHub issue #42 opened: Crash on start",
    description: "Receive issue #42 in acme/widgets, opened by `@bob`: its title, body, author, " +
      "assignees, and labels.",
  }]);
});

it("takes GitHub's payloads as they are, which differ from its REST API's", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const watcher = binding(account);
  await watcher.subscribe();
  await watcher.enable();

  await github.deliver("issues", {
    ...issues("closed", 42), issue: issue(42, { state: "closed", state_reason: "duplicate", closed_at: CREATED }),
  });
  // Webhooks list a requested team among the reviewers.
  await github.deliver("pull_request", pullRequest("opened", 7, {
    requested_reviewers: [ADA, { id: 3, name: "Core", slug: "core", html_url: "https://github.com/orgs/acme/teams/core" }],
  }));
  // A comment on a whole file has no line.
  await github.deliver("pull_request_review_comment", {
    action: "created", repository, sender: BOB, pull_request: pull(7),
    comment: {
      id: 903, pull_request_review_id: 302, body: "Rename this file.", user: BOB,
      html_url: "https://github.com/acme/widgets/pull/7#discussion_r903", created_at: CREATED, updated_at: CREATED,
      path: "README.md", line: null, original_line: null, side: null, start_line: null, start_side: null,
      position: null, original_position: null, subject_type: "file",
    },
  });
  await settled(account);

  const { received } = await watcher.read();
  expect(received.map(event => event.kind).toSorted()).toEqual(["comment", "issue", "pullRequest"]);
  expect(received.find(event => event.kind === "pullRequest")).toMatchObject({
    info: { requestedReviewers: [{ login: "ada" }] },
  });
  expect(received.find(event => event.kind === "comment")).toMatchObject({
    comment: { target: { path: "README.md", subjectType: "file" }, threadId: "903" },
  });
});

it("queues a hook's writes on its firing, and never hands the account its own comments", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const responder = binding(account);
  await responder.subscribe({ events: ["comment"] });
  await responder.enable();
  await responder.hooks.setHookBehavior({ reply: "Thanks, looking into it." });

  await github.deliver("issue_comment", comment(42, "Me too."));
  await github.deliver("issue_comment", comment(42, "Thanks, looking into it.", { sender: ADA }));
  await github.deliver("issue_comment", comment(7, "Ready for review?", { onPullRequest: true }));
  await settled(account);

  const { received, submissions } = await responder.read();
  expect(received).toEqual([
    expect.objectContaining({
      kind: "comment",
      subject: { repo: expect.objectContaining({ fullName: "acme/widgets" }), id: "42", title: "Crash on start",
        url: "https://github.com/acme/widgets/issues/42" },
      comment: { kind: "comment", id: "900", bodyMarkdown: "Me too.", author: expect.objectContaining({ login: "bob" }),
        createdAt: new Date(CREATED), updatedAt: new Date(CREATED),
        url: "https://github.com/acme/widgets/issues/42#issuecomment-900" },
    }),
    expect.objectContaining({
      kind: "comment", subject: expect.objectContaining({ id: "7", url: "https://github.com/acme/widgets/pull/7" }),
    }),
  ]);
  expect(submissions.map(submission => submission.title).toSorted()).toEqual(["Comment on #42", "Comment on #7"]);
});

it("delivers a pull request's lifecycle, reviews and diff comments, advertising their commits", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const reviewer = binding(account);
  await reviewer.subscribe({ events: ["pullRequest", "review", "comment"] });
  await reviewer.enable();

  const review = (state: string, body: string | null) => ({
    action: "submitted", repository, sender: BOB, pull_request: pull(7),
    review: { id: 300, body, state, html_url: "https://github.com/acme/widgets/pull/7#review-300", user: BOB,
      submitted_at: CREATED, commit_id: HEAD },
  });
  await github.deliver("pull_request", pullRequest("synchronize", 7));
  await github.deliver("pull_request", pullRequest("closed", 7, { state: "closed", merged_at: CREATED }));
  await github.deliver("pull_request", pullRequest("labeled", 7));
  await github.deliver("pull_request_review", review("approved", null));
  // A reply in a diff thread is a review with nothing but its comment, which arrives on its own.
  await github.deliver("pull_request_review", review("commented", null));
  await github.deliver("pull_request_review_comment", {
    action: "created", repository, sender: BOB, pull_request: pull(7),
    comment: {
      id: 902, in_reply_to_id: 901, pull_request_review_id: 301, body: "Why?", user: BOB,
      html_url: "https://github.com/acme/widgets/pull/7#discussion_r902", created_at: CREATED, updated_at: CREATED,
      path: "src/app.ts", line: 3, side: "RIGHT", subject_type: "line",
    },
  });
  await settled(account);

  const { received, advertised } = await reviewer.read();
  const byKind = (kind: string) => received.filter(event => event.kind === kind);
  expect(byKind("pullRequest").map(event => "action" in event && event.action).toSorted()).toEqual(["merged", "pushed"]);
  expect(byKind("review")).toEqual([expect.objectContaining({
    review: expect.objectContaining({ id: "300", decision: "approve", bodyMarkdown: "", commitId: HEAD }),
  })]);
  expect(byKind("comment")).toEqual([expect.objectContaining({
    comment: expect.objectContaining({
      id: "902", bodyMarkdown: "Why?",
      target: { path: "src/app.ts", subjectType: "line", line: 3, side: "new" }, threadId: "901",
    }),
  })]);
  expect(new Set(advertised)).toEqual(new Set([HEAD, BASE]));
});

it("delivers branch pushes with the repository, but not tag pushes", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const deployer = binding(account);
  await deployer.subscribe({ events: ["push"] });
  await deployer.enable();

  await github.deliver("push", push("refs/heads/release/1.0", ZERO, HEAD, { forced: false, sender: ADA }));
  await github.deliver("push", push("refs/tags/v1.0", ZERO, HEAD, { sender: ADA }));
  await settled(account);

  const { received, observations, advertised } = await deployer.read();
  expect(received).toEqual([expect.objectContaining({
    kind: "push", branch: "release/1.0", after: HEAD, forced: false,
    actor: expect.objectContaining({ login: "ada" }),
  })]);
  expect(observations).toEqual([{
    title: "GitHub push to release/1.0 in acme/widgets",
    description: `Receive a push by \`@ada\` to branch \`release/1.0\` of acme/widgets, creating it at \`${HEAD}\`.`,
  }]);
  // A created branch had no head before the push, which is not a commit to advertise.
  expect(advertised).toEqual([HEAD]);
});

it("delivers tag pushes as tag events, to hooks that watch for tags", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const releaser = binding(account);
  expect((await releaser.subscribe({ events: ["tag"] })).description).toMatch(
    /^Call this hook with each tag event in acme\/widgets,/);
  await releaser.enable();
  // GitHub reports tags in its push events.
  expect([...github.webhooks.values()].map(webhook => webhook.events)).toEqual([["push"]]);

  await github.deliver("push", push("refs/tags/v1.0", ZERO, HEAD, { sender: ADA }));
  await github.deliver("push", push("refs/heads/main", BASE, HEAD, { sender: ADA }));
  await github.deliver("push", push("refs/tags/v0.9", BASE, ZERO, { sender: ADA }));
  await settled(account);

  const { received, observations, advertised } = await releaser.read();
  expect(received).toHaveLength(2);
  expect(received).toEqual(expect.arrayContaining([
    expect.objectContaining({
      kind: "tag", tag: "v1.0", before: undefined, after: HEAD, actor: expect.objectContaining({ login: "ada" }),
    }),
    expect.objectContaining({ kind: "tag", tag: "v0.9", before: BASE, after: undefined }),
  ]));
  expect(observations.toSorted((a, b) => a.title.localeCompare(b.title))).toEqual([{
    title: "GitHub push of tag v0.9 in acme/widgets",
    description: "Receive a push by `@ada` of tag `v0.9` in acme/widgets, deleting it.",
  }, {
    title: "GitHub push of tag v1.0 in acme/widgets",
    description: `Receive a push by \`@ada\` of tag \`v1.0\` in acme/widgets, creating it at \`${HEAD}\`.`,
  }]);
  // An annotated tag names its tag object rather than a commit.
  expect(advertised).toEqual([]);
});

it("gives a hook on one issue only that issue's events", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const issueBinding = binding(account, { resourceKind: "issue", issueNumber: 42 });
  await expect(issueBinding.subscribe({ events: ["push"] })).rejects.toThrow(/only watch for issue or comment events/);
  await issueBinding.subscribe();
  await issueBinding.enable();
  // The same narrowing, from a whole-repository binding.
  const narrowed = binding(account);
  expect((await narrowed.subscribe(undefined, { kind: "issue", id: "42" })).title)
    .toBe("Watch issue #42 in acme/widgets on GitHub");
  await narrowed.enable();

  await github.deliver("issues", issues("closed", 43));
  await github.deliver("issue_comment", comment(43, "Elsewhere."));
  await github.deliver("push", push("refs/heads/main", BASE, HEAD));
  await github.deliver("issues", issues("reopened", 42));
  await github.deliver("issue_comment", comment(42, "Here."));
  await settled(account);

  for (const hook of [issueBinding, narrowed]) {
    const { received } = await hook.read();
    expect(received.map(event => event.kind).toSorted()).toEqual(["comment", "issue"]);
  }
  // One webhook serves every hook the account has on the repository.
  expect(github.webhooks.size).toBe(1);
});

it("keeps an issue binding's hooks to its issue, whatever their delivery stub's parameters", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const props: GatekeeperProps = { userObjectId: account, resourceKind: "issue", owner: OWNER, repo: REPO, issueNumber: 42 };
  const scenario = `hooks-${nextScenario++}`;
  const hooks = env.TEST_HOOKS.getByName(scenario);
  await unwrap(hooks.subscribeHook(scenario, props));

  // Parameters only this binding's subscribe() seals, here claiming the whole repository.
  await hooks.deliverDirectly(scenario, props, {}, storedIssueEvent(43));
  await hooks.deliverDirectly(scenario, props, { number: 43 }, storedIssueEvent(43));
  await hooks.deliverDirectly(scenario, props, {}, storedIssueEvent(42));

  expect((await hooks.readHook()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
  // Delivered without any webhook: these deliveries came straight to the facet.
  expect(github.webhooks.size).toBe(0);
});

it("gives a hook on one pull request its lifecycle, comments and reviews", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const pullBinding = binding(account, { resourceKind: "pull", issueNumber: 7 });
  expect((await pullBinding.subscribe()).description).toMatch(
    /^Call this hook with each pull request, comment and review event in pull request #7 in acme\/widgets,/);
  await pullBinding.enable();

  await github.deliver("pull_request", pullRequest("ready_for_review", 7));
  await github.deliver("issue_comment", comment(7, "LGTM", { onPullRequest: true }));
  await github.deliver("pull_request_review", {
    action: "submitted", repository, sender: BOB, pull_request: pull(7),
    review: { id: 301, body: "Needs tests.", state: "changes_requested", user: BOB, submitted_at: CREATED,
      html_url: "https://github.com/acme/widgets/pull/7#review-301", commit_id: HEAD },
  });
  await github.deliver("pull_request", pullRequest("opened", 8));
  await settled(account);

  const { received } = await pullBinding.read();
  expect(received.map(event => event.kind).toSorted()).toEqual(["comment", "pullRequest", "review"]);
  expect(received.find(event => event.kind === "review")).toMatchObject({
    review: { decision: "requestChanges", bodyMarkdown: "Needs tests." },
    subject: { id: "7", title: "Fix the crash", url: "https://github.com/acme/widgets/pull/7" },
  });
});

it("refuses deliveries that aren't signed with the webhook's secret", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ url }] = github.webhooks.values();

  expect(await github.deliver("issues", issues("opened", 42), { secret: "not-the-secret" })).toEqual([401]);
  const unsigned = await SELF.fetch(url, {
    method: "POST", body: "{}",
    headers: { "X-GitHub-Event": "issues", "X-GitHub-Delivery": crypto.randomUUID() },
  });
  expect(unsigned.status).toBe(400);
  const elsewhere = await SELF.fetch(url.replace(/[0-9a-f]{64}$/, "f".repeat(64)), { method: "POST", body: "{}" });
  expect(elsewhere.status).toBe(404);
  // Signed, but for a repository this webhook isn't on, or not JSON at all.
  expect(await github.deliver("issues", { ...issues("opened", 42), repository: { ...repository, id: 999 } }))
    .toEqual([404]);
  const [{ secret }] = github.webhooks.values();
  const garbled = await SELF.fetch(url, {
    method: "POST", body: "not json",
    headers: { "X-GitHub-Event": "issues", "X-Hub-Signature-256": `sha256=${await hmac(secret, "not json")}` },
  });
  expect(garbled.status).toBe(400);
  const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
  const headers = { "X-GitHub-Event": "issues", "X-Hub-Signature-256": `sha256=${"0".repeat(64)}` };
  expect((await SELF.fetch(url, { method: "POST", body: oversized, headers })).status).toBe(413);
  const streamed = new ReadableStream({ type: "bytes", start(controller) {
    controller.enqueue(oversized);
    controller.close();
  } });
  expect((await SELF.fetch(url, { method: "POST", body: streamed, headers })).status).toBe(413);
  await settled(account);

  expect((await triage.read()).received).toEqual([]);
});

it("delivers an event once, however often its payload is delivered, and never once a day old", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  const id = crypto.randomUUID();
  await github.deliver("issues", issues("opened", 42), { id });
  await github.deliver("issues", issues("opened", 42), { id });
  // A replay of the signed payload, under a delivery id of the replayer's choosing.
  await github.deliver("issues", issues("opened", 42));
  const lastWeek = new Date(Date.now() - 7 * 24 * 3_600_000).toISOString();
  await github.deliver("issues", { ...issues("opened", 41), issue: issue(41, { updated_at: lastWeek }) });
  await settled(account);

  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
});

it("refuses a push a day old, or one with no timestamp to tell its age by", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const deployer = binding(account);
  await deployer.subscribe({ events: ["push"] });
  await deployer.enable();
  const pushedAt = (value: unknown) => push("refs/heads/main", BASE, HEAD, { repository: { ...repository, pushed_at: value } });

  await github.deliver("push", pushedAt(Math.floor(Date.now() / 1000) - 7 * 24 * 3600));
  // Without one, nothing would stop a replay once the payload's dedupe row was forgotten.
  await github.deliver("push", { ...push("refs/heads/a", BASE, HEAD), repository });
  await github.deliver("push", pushedAt(null));
  // The schema allows a date string too, which a push carrying one is dated by.
  await github.deliver("push", { ...pushedAt(new Date().toISOString()), ref: "refs/heads/b" });
  await settled(account);

  expect((await deployer.read()).received).toEqual([expect.objectContaining({ kind: "push", branch: "b" })]);
});

it.each([
  ["the hook failed", { failures: 1 }],
  ["whose firing the Workshop failed to start", { admissionFailures: 1 }],
])("retries a delivery %s", async (_, behavior) => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  await triage.hooks.setHookBehavior(behavior);

  await github.deliver("issues", issues("opened", 42));
  await settled(account);
  expect((await triage.read()).received).toEqual([]);
  await after(60_000, account);

  expect((await triage.read()).received).toHaveLength(1);
});

it("shares one webhook among an account's hooks on a repository, and deletes it with the last", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const first = binding(account);
  const second = binding(account);
  await first.subscribe();
  await second.subscribe();

  await Promise.all([first.enable(), second.enable()]);
  expect(github.webhooks.size).toBe(1);
  await first.disable();
  expect(github.deleted).toEqual([]);
  await second.disable();
  expect(github.deleted).toEqual([100]);

  await first.enable();
  expect([...github.webhooks.keys()]).toEqual([101]);
  await github.deliver("issues", issues("opened", 42));
  await settled(account);
  expect((await first.read()).received).toHaveLength(1);
  expect((await second.read()).received).toEqual([]);
});

it("subscribes the webhook to what its hooks watch, as they are enabled and disabled", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  const deployer = binding(account);
  await triage.subscribe({ events: ["issue", "comment"] });
  await deployer.subscribe({ events: ["push"] });
  const events = () => [...github.webhooks.values()].map(webhook => webhook.events.toSorted());

  await triage.enable();
  expect(events()).toEqual([["issue_comment", "issues", "pull_request_review_comment"]]);
  await deployer.enable();
  expect(events()).toEqual([["issue_comment", "issues", "pull_request_review_comment", "push"]]);
  await deployer.disable();
  expect(events()).toEqual([["issue_comment", "issues", "pull_request_review_comment"]]);
  await triage.disable();
  expect(events()).toEqual([]);
});

it("leaves a working webhook when a hook is enabled while the last one's is being deleted", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const first = binding(account);
  const second = binding(account);
  await first.subscribe();
  await second.subscribe();
  await first.enable();

  github.stallDeletes = true;
  const disabling = first.disable();
  await vi.waitFor(() => expect(github.stalledDeletes).toBe(1));
  const enabling = second.enable();
  // Time for the enable to reach the driver, which must not touch the webhook being deleted.
  await scheduler.wait(100);
  github.stallDeletes = false;
  await Promise.all([disabling, enabling]);

  expect(github.deleted).toEqual([100]);
  expect([...github.webhooks.keys()]).toEqual([101]);
  await github.deliver("issues", issues("opened", 42));
  await settled(account);
  expect((await second.read()).received).toHaveLength(1);
});

it("gives each account its own webhook on a repository, and each its own events", async () => {
  const github = new FakeGitHub();
  const [ada, carol] = await Promise.all([connectAccount(), connectAccount()]);
  const adaHook = binding(ada);
  const carolHook = binding(carol);
  await adaHook.subscribe();
  await carolHook.subscribe();
  await adaHook.enable();
  await carolHook.enable();
  expect(github.webhooks.size).toBe(2);

  expect(await github.deliver("issues", issues("opened", 42))).toEqual([204, 204]);
  await settled(ada);
  await settled(carol);

  expect((await adaHook.read()).received).toHaveLength(1);
  expect((await carolHook.read()).received).toHaveLength(1);
  // One account's webhook secret signs nothing another's will accept.
  const [adaWebhook, carolWebhook] = github.webhooks.values();
  github.webhooks.set(carolWebhook.id, { ...carolWebhook, secret: adaWebhook.secret });
  expect(await github.deliver("issues", issues("reopened", 42))).toEqual([204, 401]);
});

it("adopts the webhook an earlier attempt left on the repository", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const url = `https://gadgets.test/gatekeeper/github/webhook/${env.GITHUB_HOOK_DRIVER.idFromName(account)}`;
  github.webhooks.set(5, {
    id: 5, url, secret: "lost", events: ["push"], active: true, repo: REPO, contentType: "json", insecureSsl: "0",
  });
  const triage = binding(account);
  await triage.subscribe();

  await triage.enable();
  expect(github.webhooks.size).toBe(1);
  expect(github.webhooks.get(5)).toMatchObject({ url, secret: expect.stringMatching(/^[0-9a-f]{64}$/) });
  await github.deliver("issues", issues("opened", 42));
  await settled(account);
  expect((await triage.read()).received).toHaveLength(1);
});

it("has GitHub redeliver, at its next hourly check, what GitHub failed to deliver", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id: webhookId }] = github.webhooks.values();

  github.failDeliveriesWith = 503;
  await github.deliver("issues", issues("opened", 42));
  github.failDeliveriesWith = undefined;
  // Refused for good: it's for a repository this webhook isn't on, or (from a webhook sending
  // JSON, as this one does) was malformed.
  expect(await github.deliver("issues", { ...issues("opened", 43), repository: { ...repository, id: 999 } }))
    .toEqual([404]);
  github.failDeliveriesWith = 400;
  await github.deliver("issues", issues("opened", 44));
  github.failDeliveriesWith = undefined;
  // A busy hour since, which leaves the failure past the first page of the webhook's delivery log.
  github.logDelivered(webhookId, 150);
  await after(HOUR, account);

  expect(await github.redeliver()).toEqual([204]);
  await settled(account);
  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
  // Delivered at last, it isn't asked for again.
  await after(2 * HOUR, account);
  expect(await github.redeliver()).toEqual([]);
});

it.each<[string, (github: FakeGitHub, webhook: Webhook) => void]>([
  ["deletes it", (github, webhook) => { github.webhooks.delete(webhook.id); }],
  ["deactivates it", (_github, webhook) => { webhook.active = false; }],
  ["points it elsewhere", (_github, webhook) => { webhook.url = "https://elsewhere.example/hook"; }],
  ["changes its events", (_github, webhook) => { webhook.events = ["*"]; }],
  ["has it send form-encoded payloads", (_github, webhook) => { webhook.contentType = "form"; }],
  ["stops it verifying this deployment's certificate", (_github, webhook) => { webhook.insecureSsl = "1"; }],
])("restores its webhook at the next hourly check when someone %s", async (_, change) => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe({ events: ["issue"] });
  await triage.enable();
  const [webhook] = github.webhooks.values();
  const configured = { ...webhook };
  change(github, webhook);

  await after(HOUR, account);
  expect([...github.webhooks.values()]).toEqual([{ ...configured, id: expect.any(Number) }]);
  expect(await github.deliver("issues", issues("opened", 42))).toEqual([204]);
  await settled(account);
  expect((await triage.read()).received).toHaveLength(1);
});

it("restores its webhook's payload encoding, and has GitHub redeliver what it refused meanwhile", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [webhook] = github.webhooks.values();

  // Signed, but form-encoded, so refused as malformed.
  webhook.contentType = "form";
  expect(await github.deliver("issues", issues("opened", 42))).toEqual([400]);
  await after(HOUR, account);

  expect(github.webhooks.get(webhook.id)).toMatchObject({ contentType: "json" });
  // Refused for the encoding alone, which GitHub's redelivery now sends as JSON.
  expect(await github.redeliver()).toEqual([204]);
  await settled(account);
  expect((await triage.read()).received).toEqual([expect.objectContaining({ info: expect.objectContaining({ id: "42" }) })]);
});

it("restores its webhook's secret, has GitHub redeliver what the wrong one signed, then leaves it", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id, secret }] = github.webhooks.values();
  const { at, alarm } = clock(account);

  github.webhooks.get(id)!.secret = "chosen-by-another-admin";
  await at(HOUR / 2, async () => expect(await github.deliver("issues", issues("opened", 42))).toEqual([401]));
  await at(HOUR, alarm);
  expect(github.webhooks.get(id)?.secret).toBe(secret);
  await at(HOUR + 60_000, async () => {
    expect(await github.redeliver()).toEqual([204]);
    await alarm();
  });
  expect((await triage.read()).received).toHaveLength(1);

  // The next check still reads the refused attempt, which a successful redelivery has superseded.
  github.requests.length = 0;
  await at(2 * HOUR + 60_000, alarm);
  expect(github.requests.filter(request => request.includes("/hooks") && !request.startsWith("GET"))).toEqual([]);
});

it("changes nothing on GitHub while its webhook is intact, and stops checking with its last hook", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id }] = github.webhooks.values();
  const webhookRequests = () => github.requests.splice(0).filter(request => request.includes("/hooks"));
  webhookRequests();

  await after(HOUR, account);
  // The check reads what GitHub has, and writes nothing.
  const checked = webhookRequests();
  expect(checked.length).toBeGreaterThan(0);
  expect(checked.filter(request => !request.startsWith("GET"))).toEqual([]);
  await triage.disable();
  expect(webhookRequests()).toEqual([`DELETE ${API}/hooks/${id}`]);
  expect(await runInDurableObject(driver(account), (_instance, state) => state.storage.getAlarm())).toBeNull();
});

it("shares a check's redeliveries among the account's repositories, the rest waiting for the next", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const busy = binding(account);
  const quiet = binding(account, { repo: "gizmos" });
  for (const hook of [busy, quiet]) {
    await hook.subscribe();
    await hook.enable();
  }
  const { at, alarm } = clock(account);

  await at(0, async () => {
    github.failDeliveriesWith = 503;
    for (let number = 1; number <= 25; number++) await github.deliver("issues", issues("opened", number));
    for (let number = 1; number <= 3; number++) {
      await github.deliver("issues", { ...issues("opened", number), repository: gizmos });
    }
    github.failDeliveriesWith = undefined;
  });
  await at(HOUR, alarm);
  // The quiet repository's three, and the rest of the twenty to the busy one, which, listed first,
  // would otherwise have taken them all.
  expect(github.pendingRedeliveries()).toEqual({ [REPO]: 17, gizmos: 3 });
  await github.redeliver();
  await settled(account);
  await at(2 * HOUR, alarm);
  // The busy one's last eight, still within the next check's reach.
  expect(github.pendingRedeliveries()).toEqual({ [REPO]: 8 });
  await github.redeliver();
  await settled(account);

  expect((await busy.read()).received).toHaveLength(25);
  expect((await quiet.read()).received).toHaveLength(3);
});

it("asks again at the next check for the redeliveries GitHub refused to make", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const { at, alarm } = clock(account);

  await at(0, async () => {
    github.failDeliveriesWith = 503;
    for (let number = 1; number <= 3; number++) await github.deliver("issues", issues("opened", number));
    github.failDeliveriesWith = undefined;
  });
  // GitHub agrees to the first, then fails, and the check asks no more of it this time.
  github.redeliveriesAllowed = 1;
  await at(HOUR, alarm);
  expect(github.pendingRedeliveries()).toEqual({ [REPO]: 1 });
  github.redeliveriesAllowed = undefined;
  await github.redeliver();
  await settled(account);
  await at(2 * HOUR, alarm);
  expect(github.pendingRedeliveries()).toEqual({ [REPO]: 2 });
  await github.redeliver();
  await settled(account);

  expect((await triage.read()).received).toHaveLength(3);
});

it.each<[string, (github: FakeGitHub, webhookId: number) => void, number]>([
  ["older than the two hours a check reads back", () => {}, 2 * HOUR + 60_000],
  ["behind the thousand newer attempts a check reads at most", (github, webhookId) => github.logDelivered(webhookId, 1000), HOUR],
])("recovers no failed delivery %s", async (_, then, checkedAt) => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();
  const [{ id: webhookId }] = github.webhooks.values();
  const { at, alarm } = clock(account);

  await at(0, async () => {
    github.failDeliveriesWith = 503;
    await github.deliver("issues", issues("opened", 42));
    github.failDeliveriesWith = undefined;
    then(github, webhookId);
  });
  await at(checkedAt, alarm);

  expect(github.pendingRedeliveries()).toEqual({});
});

it("delivers nothing once the account can no longer read the repository", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  // Removed from the repository, the account still has its webhook there: GitHub keeps delivering.
  github.readable = false;
  expect(await github.deliver("issues", issues("opened", 42))).toEqual([204]);
  await settled(account);

  expect(await triage.read()).toMatchObject({ received: [], observations: [] });
});

it("delivers nothing once the account can no longer read the repository, even just after a delivery", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  // The first delivery caches the repository's metadata; the second asks GitHub again anyway,
  // which answers an unchanged repository 304, costing no rate limit.
  await github.deliver("issues", issues("opened", 42));
  await settled(account);
  await github.deliver("issues", issues("opened", 43));
  await settled(account);
  expect(github.notModified).toBe(1);
  github.readable = false;
  expect(await github.deliver("issues", issues("opened", 44))).toEqual([204]);
  await settled(account);

  const { received, observations } = await triage.read();
  expect(received).toEqual([
    expect.objectContaining({ info: expect.objectContaining({ id: "42" }) }),
    expect.objectContaining({ info: expect.objectContaining({ id: "43" }) }),
  ]);
  expect(observations).toHaveLength(2);
});

it("refuses to watch a repository whose webhooks the account can't manage", async () => {
  const github = new FakeGitHub();
  github.admin = false;
  const account = await connectAccount();

  await expect(binding(account).subscribe()).rejects.toThrow(
    "GitHub delivers events to a webhook, which only an admin of acme/widgets can add, and the connected " +
    "account is not one.");
});

it("deletes a disconnected account's webhooks and delivers nothing more", async () => {
  const github = new FakeGitHub();
  const account = await connectAccount();
  const triage = binding(account);
  await triage.subscribe();
  await triage.enable();

  const [webhook] = github.webhooks.values();
  await unwrap(triage.hooks.revokeAccount(account));
  expect(github.deleted).toEqual([webhook.id]);
  // Were GitHub to deliver anyway, the driver no longer answers for the webhook.
  github.webhooks.set(webhook.id, webhook);
  expect(await github.deliver("issues", issues("opened", 42))).toEqual([404]);
  await expect(triage.enable()).rejects.toThrow("This GitHub account has been disconnected.");
  expect((await triage.read()).received).toEqual([]);
});
