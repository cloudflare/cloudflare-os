// The contributor binding on the real gatekeeper Durable Object: what it resolves from and
// describes itself as, and the policy it applies to each write when it is queued and again when
// it is applied -- branches under the prefix only, never the default or a protected branch, no
// force, pull requests into the default branch only, and no write to a public repository unless
// allowed, read fresh each time. Any other action is refused at apply. GitHub is faked at fetch.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitHubActionData, GatekeeperProps, Outcome } from "./worker";

afterEach(() => {
  vi.unstubAllGlobals();
});

const OWNER = "acme";
const REPO = "widgets";
/** Where the binding reads the repository once pinned: by its id, 1. */
const API_BASE = "https://api.github.com/repositories/1";
/** The repository by name, which the binding reads only to pin its id. */
const NAME_ROOT = `https://api.github.com/repos/${OWNER}/${REPO}`;
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const BRANCH = "cloudflare-os/fix/1-2";

/** A workspace git cache for pushes that only ever create branches, so nothing is consulted. */
class UnusedGitCache extends RpcTarget {
  async isAncestor(): Promise<boolean> { throw new Error("test: a branch creation needs no ancestry check"); }
  async get(): Promise<null> { return null; }
  async buildPack(): Promise<never> { throw new Error("test: nothing may be pushed"); }
  async consumePack(): Promise<never> { throw new Error("test: nothing may be pulled"); }
}

class TestApprovalQueue extends RpcTarget {
  async authorizeObservation(): Promise<void> {}
  async submitAction(): Promise<void> {}
}

/** A repository whose visibility, default branch, and branches (with protection) the test controls. */
class FakeGitHub {
  visibility: "public" | "private" | "internal" = "private";
  defaultBranch = "main";
  readonly branches = new Map<string, { head: string; protected: boolean }>([["main", { head: BASE, protected: true }]]);
  readonly writes: string[] = [];

  install(): void {
    vi.stubGlobal("fetch", this.#handle.bind(this));
  }

  async #handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const path = url.origin + url.pathname;
    if (request.method !== "GET") {
      this.writes.push(`${request.method} ${path}`);
      throw new Error(`test: nothing may be written (${request.method} ${path})`);
    }
    if (path === API_BASE || path === NAME_ROOT) {
      return Response.json({
        id: 1, name: REPO, full_name: `${OWNER}/${REPO}`, html_url: `https://github.com/${OWNER}/${REPO}`,
        description: null, visibility: this.visibility, private: this.visibility !== "public",
        default_branch: this.defaultBranch, owner: { login: OWNER, html_url: `https://github.com/${OWNER}` },
      });
    }
    for (const [prefix, shape] of [
      [`${API_BASE}/git/ref/heads/`, "ref"], [`${API_BASE}/branches/`, "branch"],
      [`${NAME_ROOT}/git/ref/heads/`, "ref"], [`${NAME_ROOT}/branches/`, "branch"],
    ] as const) {
      if (!path.startsWith(prefix)) continue;
      const name = decodeURIComponent(path.slice(prefix.length));
      const branch = this.branches.get(name);
      if (branch === undefined) return Response.json({ message: "Not Found" }, { status: 404 });
      return Response.json(shape === "ref"
        ? { ref: `refs/heads/${name}`, object: { sha: branch.head, type: "commit" } }
        : { name, commit: { sha: branch.head }, protected: branch.protected });
    }
    throw new Error(`test: unexpected fetch to ${url}`);
  }
}

async function unwrap<T>(pending: Promise<Outcome<T>>): Promise<T> {
  const result = await pending;
  if ("error" in result) throw new Error(result.error);
  return result.ok;
}

let nextScenario = 0;
async function contributor(scope: { allowPublic?: boolean } = {}) {
  const github = new FakeGitHub();
  github.install();
  const scenario = `contributor-${nextScenario++}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(), resourceKind: "contributor", owner: OWNER, repo: REPO,
    branchPrefix: "cloudflare-os/", allowPublic: scope.allowPublic ?? false,
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  const queue = () => new RpcStub(new TestApprovalQueue()) as never;
  const submit = async (action: GitHubActionData) => {
    await unwrap(hooks.submitAction(scenario, props, queue(), action,
      { title: "write", description: "test", implementsRevert: false }));
    return action;
  };
  return {
    github,
    describe: () => unwrap(hooks.describeResource(scenario, props)),
    push: async (branch: string, force = false) => {
      const action = await unwrap(hooks.preparePush(scenario, props, branch, HEAD, force, new RpcStub(new UnusedGitCache()) as never));
      return action === null ? null : await submit(action);
    },
    pullRequest: async (head: string, base = "main") =>
      await submit(await unwrap(hooks.prepareCreatePullRequest(scenario, props, { title: "Fix checkout", head, base }))),
    submit,
    apply: (actionId: number) => unwrap(hooks.applyAction(scenario, props, actionId, new RpcStub(new UnusedGitCache()) as never)),
  };
}

describe("the contributor binding", () => {
  it("is what a repository URL with a branchPrefix query resolves to, and a malformed scope is refused", async () => {
    const hooks = env.TEST_HOOKS.getByName("contributor-patterns");
    expect(await unwrap(hooks.resourcePatternFor(`https://github.com/${OWNER}/${REPO}?branchPrefix=cloudflare-os/`)))
      .toBe("https://github.com/:owner/:repo\\?branchPrefix=*");
    expect(await unwrap(hooks.resourcePatternFor(`https://github.com/${OWNER}/${REPO}`))).toBe("https://github.com/:owner/:repo");
    await expect(unwrap(hooks.resourcePatternFor(`https://github.com/${OWNER}/${REPO}?branchPrefix=main`)))
      .rejects.toThrow(/invalid branch prefix/);
    await expect(unwrap(hooks.resourcePatternFor(`https://github.com/${OWNER}/${REPO}/pull/3?branchPrefix=x/`)))
      .rejects.toThrow(/must name the repository itself/);
  });

  it("describes itself by its scope and suggests its own binding name, with no hook type", async () => {
    const gk = await contributor();
    const description = await gk.describe();
    expect(description).toMatchObject({
      url: `https://github.com/${OWNER}/${REPO}?branchPrefix=cloudflare-os%2F`,
      suggestedBindingName: "GITHUB_REPO_CONTRIBUTOR",
      tsType: "GitHubRepoContributor",
    });
    expect(description.hookTsType).toBeUndefined();
  });

  it("queues a push only to a new or unprotected branch under the prefix, never forced", async () => {
    const gk = await contributor();
    await expect(gk.push("main")).rejects.toThrow(/only write to branches whose names start with "cloudflare-os\/"/);
    await expect(gk.push("feature/x")).rejects.toThrow(/cloudflare-os\//);
    await expect(gk.push(BRANCH, true)).rejects.toThrow(/cannot force-push/);
    gk.github.branches.set("cloudflare-os/locked", { head: BASE, protected: true });
    await expect(gk.push("cloudflare-os/locked")).rejects.toThrow(/protected branch/);
    expect(await gk.push(BRANCH)).toMatchObject({ type: "push", branch: BRANCH, force: false });
  });

  it("refuses the default branch even when it lives under the prefix", async () => {
    const gk = await contributor();
    gk.github.defaultBranch = "cloudflare-os/main";
    await expect(gk.push("cloudflare-os/main")).rejects.toThrow(/default branch/);
  });

  it("opens pull requests only from the prefix into the default branch", async () => {
    const gk = await contributor();
    gk.github.branches.set("feature", { head: HEAD, protected: false }).set(BRANCH, { head: HEAD, protected: false });
    await expect(gk.pullRequest("feature")).rejects.toThrow(/cloudflare-os\//);
    await expect(gk.pullRequest(BRANCH, "release")).rejects.toThrow(/only open pull requests into the default branch "main"/);
    expect(await gk.pullRequest(BRANCH)).toMatchObject({ type: "createPullRequest", options: { head: BRANCH, base: "main" } });
  });

  it("refuses a public repository unless allowed, and treats internal as not public", async () => {
    const refused = await contributor();
    refused.github.visibility = "public";
    await expect(refused.push(BRANCH)).rejects.toThrow(/public/);

    const internal = await contributor();
    internal.github.visibility = "internal";
    expect(await internal.push(BRANCH)).toMatchObject({ type: "push" });

    const allowed = await contributor({ allowPublic: true });
    allowed.github.visibility = "public";
    expect(await allowed.push(BRANCH)).toMatchObject({ type: "push" });
  });

  it("re-checks at apply: a repository made public, or a branch protected, after queuing is not written to", async () => {
    const gk = await contributor();
    gk.github.branches.set(BRANCH, { head: HEAD, protected: false });
    const push = await gk.push("cloudflare-os/other");
    const pull = await gk.pullRequest(BRANCH);
    gk.github.visibility = "public";
    await expect(gk.apply(push!.approvalId)).rejects.toThrow(/public/);
    await expect(gk.apply(pull.approvalId)).rejects.toThrow(/public/);

    gk.github.visibility = "private";
    gk.github.branches.set("cloudflare-os/other", { head: BASE, protected: true });
    await expect(gk.apply(push!.approvalId)).rejects.toThrow(/protected branch/);
    expect(gk.github.writes).toEqual([]);
  });

  it("refuses at apply any action its session cannot queue", async () => {
    const gk = await contributor();
    const issue = await gk.submit({
      type: "createIssue", approvalId: 1000, submittedAt: Date.now(), owner: OWNER, repo: REPO,
      provisionalId: "~9", options: { title: "x" },
    } as GitHubActionData);
    await expect(gk.apply(issue.approvalId)).rejects.toThrow(/cannot apply a createIssue action/);
    expect(gk.github.writes).toEqual([]);
  });
});
