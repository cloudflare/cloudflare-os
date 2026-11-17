// The contributor binding on the real gatekeeper Durable Object: what it describes itself as,
// and the policy it applies to each write when it is queued and again when it is applied --
// branches under the prefix only, never the default or a protected branch, no force, merge
// requests into the default branch only, and no write to a public project unless allowed, read
// fresh each time. Any other action is refused at apply. GitLab is faked at fetch.

import { RpcStub, RpcTarget } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, seedAccount, unwrap } from "./fake-gitlab.js";
import type { ActionPresentation, GatekeeperProps } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** The project by name, which the binding reads only to pin its id. */
const PATH = "group%2Fsub%2Fproject";
/** Where the binding reads the project once pinned: by its id. */
const P = String(fx.projectResponse.data.id);
const PROJECT = "group/sub/project";
const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const DESC: ActionPresentation = { title: "write", implementsRevert: false };
const BRANCH = "cloudflare-os/fix/1-2";

/** A workspace git cache for pushes that only ever create branches, so nothing is consulted. */
class UnusedGitCache extends RpcTarget {
  async isAncestor(): Promise<boolean> { throw new Error("test: a branch creation needs no ancestry check"); }
  async get(): Promise<null> { return null; }
  async buildPack(): Promise<never> { throw new Error("test: nothing may be pushed"); }
  async consumePack(): Promise<never> { throw new Error("test: nothing may be pulled"); }
}

/** A project whose visibility, default branch, and branches (with protection) the test controls. */
class ContributorFake extends FakeGitLab {
  visibility: "public" | "private" | "internal" = "private";
  defaultBranch = "main";
  readonly branches = new Map<string, { head: string; protected: boolean }>([["main", { head: BASE, protected: true }]]);

  constructor() {
    super();
    this.on("GET", new RegExp(`^/api/v4/projects/(?:${PATH}|${P})$`), () => json({
      ...fx.projectResponse.data, path_with_namespace: PROJECT, default_branch: this.defaultBranch,
      visibility: this.visibility, web_url: `https://gitlab.example.com/${PROJECT}`,
      namespace: { ...fx.projectResponse.data.namespace, full_path: "group/sub" },
    }));
    this.on("GET", new RegExp(`^/api/v4/projects/(?:${PATH}|${P})/repository/branches/`), request => {
      const name = decodeURIComponent(request.url.pathname.split("/repository/branches/")[1]);
      const branch = this.branches.get(name);
      return branch === undefined ? json({ message: "404 Branch Not Found" }, { status: 404 })
        : json({ ...fx.branchResponse.data, name, protected: branch.protected, default: name === this.defaultBranch,
          commit: { ...fx.branchResponse.data.commit, id: branch.head } });
    });
    this.on("POST", /git-receive-pack$/, () => { throw new Error("test: nothing may be pushed"); });
  }
}

let scenario = 0;
async function setup(scope: { branchPrefix?: string; allowPublic?: boolean } = {}) {
  const gitlab = new ContributorFake();
  gitlab.install();
  const userObjectId = await seedAccount();
  const props: GatekeeperProps = {
    userObjectId, resourceKind: "contributor", projectPath: PROJECT,
    branchPrefix: scope.branchPrefix ?? "cloudflare-os/", allowPublic: scope.allowPublic ?? false,
  };
  return { gitlab, props, name: `contributor-${scenario++}` };
}

async function queuePush(name: string, props: GatekeeperProps, branch: string, force = false) {
  return await unwrap(await hooks().queuePush(name, props, [branch, HEAD, force, new RpcStub(new UnusedGitCache())], DESC));
}

async function queueMergeRequest(name: string, props: GatekeeperProps, sourceBranch: string, targetBranch = "main") {
  return await unwrap(await hooks().queueAction(name, props, "prepareCreateMergeRequest",
    [{ title: "Fix checkout", sourceBranch, targetBranch }], DESC));
}

describe("the contributor binding", () => {
  it("describes itself by its scope and suggests its own binding name", async () => {
    const { props, name } = await setup();
    expect(await unwrap(await hooks().describe(name, props))).toMatchObject({
      url: `https://gitlab.example.com/${PROJECT}?branchPrefix=cloudflare-os%2F`,
      suggestedBindingName: "GITLAB_PROJECT_CONTRIBUTOR",
      tsType: "GitLabProjectContributor",
    });
  });

  it("is what a project URL with a branchPrefix query binds, and a malformed scope is refused", async () => {
    const { props } = await setup();
    const id = props.userObjectId;
    expect(await unwrap(await hooks().resourceFor(id, `https://gitlab.example.com/${PROJECT}?branchPrefix=cloudflare-os/`)))
      .toBe("https://gitlab.example.com/:project+\\?branchPrefix=*");
    await expect(unwrap(await hooks().resourceFor(id, `https://gitlab.example.com/${PROJECT}?branchPrefix=main`)))
      .rejects.toThrow(/invalid branch prefix/);
    await expect(unwrap(await hooks().resourceFor(id, `https://gitlab.example.com/${PROJECT}?branchPrefix=x/&extra=1`)))
      .rejects.toThrow(/Unsupported repository URL parameter/);
  });

  it("queues a push only to a new or unprotected branch under the prefix, never forced", async () => {
    const { gitlab, props, name } = await setup();
    await expect(queuePush(name, props, "main")).rejects.toThrow(/only write to branches whose names start with "cloudflare-os\/"/);
    await expect(queuePush(name, props, "feature/x")).rejects.toThrow(/cloudflare-os\//);
    await expect(queuePush(name, props, BRANCH, true)).rejects.toThrow(/cannot force-push/);
    gitlab.branches.set("cloudflare-os/locked", { head: BASE, protected: true });
    await expect(queuePush(name, props, "cloudflare-os/locked")).rejects.toThrow(/protected branch/);
    expect(await queuePush(name, props, BRANCH)).toMatchObject({ type: "push", branch: BRANCH, force: false });
  });

  it("refuses the default branch even when it lives under the prefix", async () => {
    const { gitlab, props, name } = await setup();
    gitlab.defaultBranch = "cloudflare-os/main";
    await expect(queuePush(name, props, "cloudflare-os/main")).rejects.toThrow(/default branch/);
  });

  it("opens merge requests only from the prefix into the default branch", async () => {
    const { gitlab, props, name } = await setup();
    gitlab.branches.set("feature", { head: HEAD, protected: false }).set(BRANCH, { head: HEAD, protected: false });
    await expect(queueMergeRequest(name, props, "feature")).rejects.toThrow(/cloudflare-os\//);
    await expect(queueMergeRequest(name, props, BRANCH, "release")).rejects.toThrow(/only open merge requests into the default branch "main"/);
    expect(await queueMergeRequest(name, props, BRANCH)).toMatchObject({ type: "createMergeRequest", provisionalId: "~1" });
  });

  it("refuses a public project unless allowed, and treats internal as not public", async () => {
    const refused = await setup();
    refused.gitlab.visibility = "public";
    await expect(queuePush(refused.name, refused.props, BRANCH)).rejects.toThrow(/public/);

    const internal = await setup();
    internal.gitlab.visibility = "internal";
    expect(await queuePush(internal.name, internal.props, BRANCH)).toMatchObject({ type: "push" });

    const allowed = await setup({ allowPublic: true });
    allowed.gitlab.visibility = "public";
    expect(await queuePush(allowed.name, allowed.props, BRANCH)).toMatchObject({ type: "push" });
  });

  it("re-checks at apply: a project made public after queuing is not written to", async () => {
    const { gitlab, props, name } = await setup();
    gitlab.branches.set(BRANCH, { head: HEAD, protected: false });
    const push = await queuePush(name, props, "cloudflare-os/other");
    const mr = await queueMergeRequest(name, props, BRANCH);
    gitlab.visibility = "public";
    await expect(unwrap(await hooks().applyAction(name, props, push!.approvalId))).rejects.toThrow(/public/);
    await expect(unwrap(await hooks().applyAction(name, props, mr.approvalId))).rejects.toThrow(/public/);
    expect(gitlab.count("POST", /git-receive-pack$/)).toBe(0);
    expect(gitlab.count("POST", /merge_requests$/)).toBe(0);
  });

  it("re-checks at apply: a branch protected after queuing is not pushed to", async () => {
    const { gitlab, props, name } = await setup();
    const push = await queuePush(name, props, BRANCH);
    gitlab.branches.set(BRANCH, { head: BASE, protected: true });
    await expect(unwrap(await hooks().applyAction(name, props, push!.approvalId))).rejects.toThrow(/protected branch/);
    expect(gitlab.count("POST", /git-receive-pack$/)).toBe(0);
  });

  it("refuses at apply any action its session cannot queue", async () => {
    const { gitlab, props, name } = await setup();
    gitlab.on("GET", /^\/api\/v4\/users\?username=/, () => json([]));
    // Queued through the gatekeeper's own method, as no contributor session can.
    const issue = await unwrap(await hooks().queueAction(name, props, "prepareCreateIssue", [{ title: "x" }], DESC));
    await expect(unwrap(await hooks().applyAction(name, props, issue.approvalId))).rejects.toThrow(/cannot apply a createIssue action/);
    expect(gitlab.count("POST", /issues$/)).toBe(0);
  });
});
