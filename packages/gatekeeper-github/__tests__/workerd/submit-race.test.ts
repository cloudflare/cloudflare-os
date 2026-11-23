// The overseer's auto-approval drain can apply (or a user can discard) an action while
// `submitActionForApproval` is still awaiting the queue's reply. These drive the real
// `GitHubGatekeeperImpl` with approval queues that resolve the action before replying, and check
// that the resolution stands: the action is not revived as pending, nor its provisional ID unbound.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps, GitHubActionData, Outcome } from "./worker";

const OWNER = "acme";
const REPO = "widgets";
const REPO_PATH = new RegExp(`^/(repos/${OWNER}/${REPO}|repositories/1)(?=/|$)`);

function issue(number: number, title: string): Record<string, unknown> {
  return {
    number, html_url: `https://github.com/${OWNER}/${REPO}/issues/${number}`, title, state: "open", body: "",
    user: { login: "ada" }, labels: [], assignees: [], created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z", closed_at: null, comments: 0,
  };
}

/** GitHub's REST API for one repository whose issues the test creates. */
class FakeGitHub {
  readonly issues = new Map<number, Record<string, unknown>>();
  created = 0;

  constructor() {
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => this.#handle(new Request(input, init)));
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname.replace(REPO_PATH, "");
    if (path === "") {
      return Response.json({
        id: 1, name: REPO, owner: { login: OWNER }, description: null, visibility: "public",
        private: false, default_branch: "main",
      });
    }
    if (path === "/user") return Response.json({ login: "ada" });
    if (path === "/issues" && request.method === "POST") {
      const number = 41 + ++this.created;
      this.issues.set(number, issue(number, (await request.json<{ title: string }>()).title));
      return Response.json(this.issues.get(number), { status: 201 });
    }
    if (path === "/issues") return Response.json([...this.issues.values()]);
    const match = /^\/issues\/(\d+)$/.exec(path);
    if (match && this.issues.has(Number(match[1]))) return Response.json(this.issues.get(Number(match[1])));
    throw new Error(`test: unexpected fetch ${request.method} ${request.url}`);
  }
}

class UnusedGitCache extends RpcTarget {}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

let nextScenario = 0;
let nextApprovalId = 1;

async function repoGatekeeper() {
  const scenario = `submit-race-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = { userObjectId: accountId.toString(), resourceKind: "repo", owner: OWNER, repo: REPO };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  const apply = (actionId: number) =>
    unwrap(hooks.applyAction(scenario, props, actionId, new RpcStub(new UnusedGitCache()) as never));
  const reject = (actionId: number) => unwrap(hooks.rejectAction(scenario, props, actionId));

  /**
   * An approval queue whose `submitAction` first runs `before` on the action, as the overseer's
   * drain may, then replies, or fails as a refusal or a lost reply would.
   */
  class ResolvingQueue extends RpcTarget {
    constructor(readonly before: "apply" | "reject" | "none", readonly reply: "ok" | "throw") {
      super();
    }
    async authorizeObservation(): Promise<void> {}
    async submitAction(actionId: number): Promise<void> {
      // The drain records a failed apply for a retry rather than failing the submit.
      if (this.before === "apply") await apply(actionId).catch(() => {});
      if (this.before === "reject") await reject(actionId);
      if (this.reply === "throw") throw new Error("Network connection lost.");
    }
  }

  return {
    /** Submits a `createIssue` for provisional `~1` through `queue`; answers its approval ID. */
    createIssue: async (before: "apply" | "reject" | "none", reply: "ok" | "throw") => {
      const action: GitHubActionData = {
        approvalId: nextApprovalId++, submittedAt: Date.now(), owner: OWNER, repo: REPO,
        type: "createIssue", provisionalId: "~1", options: { title: "Bug" },
      };
      await unwrap(hooks.submitAction(scenario, props, new RpcStub(new ResolvingQueue(before, reply)) as never, action,
        { title: "Create issue", description: "Create issue", implementsRevert: false }));
      return action.approvalId;
    },
    apply,
    openIssue: (id: string) => unwrap(hooks.openIssue(scenario, props, id)),
    listedIds: async () => (await unwrap(hooks.listingPages(scenario, props, "listIssues", undefined, 100)) as
      ({ id: string }[] | null)[]).flatMap(page => page ?? []).map(item => item.id),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("submitActionForApproval when the action is resolved before the queue replies", () => {
  it("leaves an action applied during the submit applied, with its provisional ID bound to the real issue", async () => {
    const github = new FakeGitHub();
    const gk = await repoGatekeeper();
    const actionId = await gk.createIssue("apply", "ok");

    expect(github.created).toBe(1);
    expect(await gk.openIssue("~1")).toMatchObject({ id: "42", title: "Bug" });
    // Not simulated again on top of the issue it created.
    expect(await gk.listedIds()).toEqual(["42"]);
    // A re-delivered apply is answered by the retired record, not run again.
    await gk.apply(actionId);
    expect(github.created).toBe(1);
  });

  it("leaves an action discarded during the submit discarded", async () => {
    const github = new FakeGitHub();
    const gk = await repoGatekeeper();
    const actionId = await gk.createIssue("reject", "ok");

    await expect(gk.openIssue("~1")).rejects.toThrow(/No provisional issue exists/);
    expect(await gk.listedIds()).toEqual([]);
    await expect(gk.apply(actionId)).rejects.toThrow(/was discarded/);
    expect(github.created).toBe(0);
  });

  it("leaves no trace of an action the approval queue refuses", async () => {
    const github = new FakeGitHub();
    const gk = await repoGatekeeper();
    await expect(gk.createIssue("none", "throw")).rejects.toThrow("Network connection lost.");

    await expect(gk.openIssue("~1")).rejects.toThrow(/No provisional issue exists/);
    expect(await gk.listedIds()).toEqual([]);
    expect(github.created).toBe(0);
  });

  it("reports success when the reply is lost after the action applied", async () => {
    const github = new FakeGitHub();
    const gk = await repoGatekeeper();
    const actionId = await gk.createIssue("apply", "throw");

    expect(await gk.openIssue("~1")).toMatchObject({ id: "42", title: "Bug" });
    expect(await gk.listedIds()).toEqual(["42"]);
    await gk.apply(actionId);
    expect(github.created).toBe(1);
  });

  it("keeps an action whose apply failed for a retry when the reply is lost", async () => {
    vi.stubGlobal("fetch", () => Response.json({ message: "Bad Gateway" }, { status: 502 }));
    const gk = await repoGatekeeper();
    const actionId = await gk.createIssue("apply", "throw");

    // The overseer holds the action for a retry, so it still reads as queued, and the retry runs.
    const github = new FakeGitHub();
    expect(await gk.openIssue("~1")).toMatchObject({ id: "~1", title: "Bug" });
    await gk.apply(actionId);
    expect(github.created).toBe(1);
    expect(await gk.openIssue("~1")).toMatchObject({ id: "42" });
  });
});
