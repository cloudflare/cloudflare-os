// Resource resolution and observer admission: the URL patterns are ordered most-specific first
// (the project pattern also matches issue and merge request URLs, and resolution is first-match),
// `getGatekeeperClassFor` parses nested namespaces via the `/-/` separator, stale stub-era props
// fail closed, the observer probe requires GitLab to show the observer's own token the project,
// member or not, a project feature requires their token to list its data, and the roles GitLab
// checks by role are read from the effective membership.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesResourceUrlPattern, resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, stageReconnect, unwrap } from "./fake-gitlab.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT = "https://gitlab.example.com/group/sub/project";

describe("supported resources", () => {
  it("lists merge request, issue, then project, all on the configured instance", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    const resources = await unwrap(await hooks().supportedResources(id));
    expect(resources.map(r => r.title)).toEqual(["GitLab Merge Request", "GitLab Issue", "GitLab Project"]);
    expect(resources.map(r => r.urlPattern)).toEqual([
      "https://gitlab.example.com/:project+/-/merge_requests/:iid{/*}?",
      "https://gitlab.example.com/:project+/-/issues/:iid{/*}?",
      "https://gitlab.example.com/:project+",
    ]);
  });

  it("resolves a merge request URL to the merge request resource, not the project one", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    const resources = await unwrap(await hooks().supportedResources(id));
    const mrUrl = `${PROJECT}/-/merge_requests/7`;
    // The project pattern matches too -- ordering is what keeps first-match right.
    expect(matchesResourceUrlPattern(resources[2].urlPattern, mrUrl)).toBe(true);
    const resolved = resolveRequestedResource(resources, mrUrl);
    expect(resolved).toEqual({ ok: true, resource: resources[0] });
    expect(resolveRequestedResource(resources, `${PROJECT}/-/issues/42`)).toEqual({ ok: true, resource: resources[1] });
    expect(resolveRequestedResource(resources, PROJECT)).toEqual({ ok: true, resource: resources[2] });
    expect(resolveRequestedResource(resources, `${PROJECT}/`)).toEqual({ ok: true, resource: resources[2] });
  });

  it("keeps a merge request or issue URL with GitLab's tab suffix on its own resource, not the project's", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    const resources = await unwrap(await hooks().supportedResources(id));
    for (const suffix of ["/diffs", "/commits", "/pipelines", "/diffs?commit_id=abc", "/"]) {
      expect(resolveRequestedResource(resources, `${PROJECT}/-/merge_requests/7${suffix}`), suffix)
        .toEqual({ ok: true, resource: resources[0] });
    }
    expect(resolveRequestedResource(resources, `${PROJECT}/-/issues/42/designs`)).toEqual({ ok: true, resource: resources[1] });
    // ...while a tree or blob URL under the project is still the project.
    expect(resolveRequestedResource(resources, `${PROJECT}/-/tree/main/src`)).toEqual({ ok: true, resource: resources[2] });
  });
});

describe("getGatekeeperClassFor", () => {
  it("parses nested namespaces, issues, and merge requests, and refuses other origins", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    expect(await unwrap(await hooks().resourceFor(id, PROJECT))).toBe("https://gitlab.example.com/:project+");
    expect(await unwrap(await hooks().resourceFor(id, `${PROJECT}/-/issues/42`)))
      .toBe("https://gitlab.example.com/:project+/-/issues/:iid{/*}?");
    expect(await unwrap(await hooks().resourceFor(id, `${PROJECT}/-/merge_requests/7/diffs`)))
      .toBe("https://gitlab.example.com/:project+/-/merge_requests/:iid{/*}?");
    // A tree/blob URL under the project is the project.
    expect(await unwrap(await hooks().resourceFor(id, `${PROJECT}/-/tree/main`))).toBe("https://gitlab.example.com/:project+");
    await expect(unwrap(await hooks().resourceFor(id, "https://gitlab.com/group/project"))).rejects.toThrow(/Unsupported GitLab URL/);
    await expect(unwrap(await hooks().resourceFor(id, "https://gitlab.example.com/onlyone"))).rejects.toThrow(/Unsupported GitLab URL/);
    // An issue route with a malformed number is refused, not widened to the whole project.
    await expect(unwrap(await hooks().resourceFor(id, `${PROJECT}/-/issues/abc`))).rejects.toThrow(/Unsupported GitLab URL/);
  });
});

describe("stale bindings", () => {
  it("refuses stub-era props with a reconnect message rather than misbehaving", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    // The incubating gatekeeper stored `{ userObjectId, scopePath }`.
    const stale = { userObjectId: id, scopePath: "group" } as unknown as ReturnType<typeof projectProps>;
    await expect(unwrap(await hooks().projectMetadata("stale-props", stale)))
      .rejects.toThrow(/created by an earlier version/);
  });
});

describe("observer admission", () => {
  /** The bound project's numeric id, which a binding pins from its path and then reads it by. */
  const PROJECT_ID = 7;
  const PROJECT_SUBRESOURCE = `project/${PROJECT_ID}`;
  /**
   * Each project feature an observer's token lists one row of to check it. Issues are asked through
   * GraphQL's `issuesEnabled` instead, since their listing answers `200 []` to a token they are
   * closed to.
   */
  const FEATURES = { repository: "repository/branches", mergeRequests: "merge_requests", builds: "pipelines" };
  const LISTINGS = [...Object.values(FEATURES), "issues"];
  const ALL_FEATURES = [...Object.keys(FEATURES), "issues"];
  const userOf = (request: { headers: Headers }) => request.headers.get("authorization")!.replace("Bearer ", "");

  /**
   * A fake where the token names the user (`Bearer <username>`), `/user` answers with that
   * user's id, the project answers its path and its id with itself, or with the status `hidden`
   * gives it for that user, and each feature's listing answers 200, or the status `refused` gives
   * it for that user. A refused `issues` listing answers `200 []`, as GitLab's does, and GraphQL's
   * `issuesEnabled` false.
   */
  function fakeProject(options: { hidden?: Record<string, number>; refused?: Record<string, Record<string, number>> } = {}): FakeGitLab {
    const gitlab = new FakeGitLab();
    gitlab.on("GET", /^\/api\/v4\/user$/, request => {
      const name = userOf(request);
      return json({ id: name === "alice" ? 100 : 101, username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/(?:group%2Fsub%2Fproject|${PROJECT_ID})$`), request => {
      const status = options.hidden?.[userOf(request)];
      return status === undefined
        ? json({ ...fx.projectResponse.data, id: PROJECT_ID, path_with_namespace: "group/sub/project",
          web_url: "https://gitlab.example.com/group/sub/project" })
        : json({ message: `${status}` }, { status });
    });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/${PROJECT_ID}/(${LISTINGS.join("|")})\\?`), request => {
      const listing = request.url.pathname.replace(`/api/v4/projects/${PROJECT_ID}/`, "");
      const status = options.refused?.[userOf(request)]?.[listing];
      return status === undefined || listing === "issues" ? json([]) : json({ message: `${status}` }, { status });
    });
    gitlab.on("POST", /^\/api\/graphql$/, request => {
      const user = userOf(request);
      const visible = options.hidden?.[user] === undefined;
      return json({ data: { projects: { nodes: visible ? [{ issuesEnabled: options.refused?.[user]?.issues === undefined }] : [] } } });
    });
    return gitlab;
  }

  async function probe(hidden?: number) {
    fakeProject({ hidden: hidden === undefined ? {} : { observer: hidden } }).install();
    const id = await seedAccount({ accessToken: "observer" });
    return await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
  }

  it("admits whoever GitLab shows the project, member or not", async () => {
    // Nothing here knows the observer's membership: an internal or public project's non-member,
    // a custom role, or a Guest is admitted like a Reporter; what each read returned is checked
    // feature by feature (see checkSubresourceAccess).
    expect(await probe()).toBe(true);
  });

  it("denies a project the token cannot see", async () => {
    expect(await probe(404)).toBe(false);
    expect(await probe(403)).toBe(false);
  });

  it("lets an upstream failure propagate rather than answering it as a denial or an admission", async () => {
    await expect(probe(502)).rejects.toThrow(/502/);
  });

  it("asks the project alone, by its path or its id, and learns the observer's id once per grant", async () => {
    const gitlab = fakeProject();
    gitlab.install();
    const id = await seedAccount({ accessToken: "observer" });
    await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
    expect(gitlab.requests.map(r => r.url.pathname + r.url.search))
      .toEqual(["/api/v4/user", "/api/v4/projects/group%2Fsub%2Fproject"]);
    // Re-verification (every workspace open) costs one project read, by path or by id.
    await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
    await unwrap(await hooks().hasProjectAccess(id, PROJECT_ID));
    expect(gitlab.count("GET", /\/api\/v4\/user$/)).toBe(1);
    expect(gitlab.count("GET", /\/api\/v4\/projects\/group%2Fsub%2Fproject$/)).toBe(2);
    expect(gitlab.count("GET", new RegExp(`/api/v4/projects/${PROJECT_ID}$`))).toBe(1);
    expect(gitlab.count("GET", new RegExp(`/api/v4/projects/${PROJECT_ID}/`))).toBe(0);
  });

  it("does not admit a reconnected user on the previous user's answer", async () => {
    // `alice` can see the project; while her /user read is in flight the account is reconnected
    // as `bob`, who cannot. The answer is fenced to the connection that started it, so the probe
    // re-reads under the new one -- and denies bob.
    const gitlab = fakeProject({ hidden: { bob: 404 } });
    gitlab.on("GET", /^\/api\/v4\/user$/, async request => {
      const name = userOf(request);
      if (name === "alice") {
        // The reconnect commits before alice's answer is sent. The handler runs in the object
        // making the probe, so the account stub is made here: one made in the test's own context
        // is an I/O object of another context and cannot be used from this one.
        const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
        await runInDurableObject(account, async instance => {
          await instance.commitReconnect(await stageReconnect(instance, "code-bob"));
        });
      }
      return json({ id: name === "alice" ? 100 : 101, username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    // The reconnect's code exchange mints bob's token.
    gitlab.on("POST", /^\/oauth\/token/, () => json({ access_token: "bob", refresh_token: "bob-refresh", expires_in: 7200 }));
    gitlab.install();
    const id = await seedAccount({ accessToken: "alice" });
    await hooks().installCallback(id);

    expect(await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"))).toBe(false);
    // Alice's id was never stored against bob's connection: probing again reuses bob's.
    expect(await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"))).toBe(false);
    expect(gitlab.count("GET", /\/api\/v4\/user$/)).toBe(2);
  });

  it("is what addObserver enforces: the project, not its features", async () => {
    fakeProject({ hidden: { hidden: 404 }, refused: { restricted: { merge_requests: 403, pipelines: 403 } } }).install();
    const owner = await seedAccount({ accessToken: "owner" });
    const reader = await seedAccount({ accessToken: "reader" });
    const restricted = await seedAccount({ accessToken: "restricted" });
    const hidden = await seedAccount({ accessToken: "hidden" });
    await unwrap(await hooks().addObserver("observers", projectProps(owner), reader));
    // Releases before features were named reported the project alone, which is all it stands for.
    await unwrap(await hooks().addObserver("observers", projectProps(owner), restricted));
    await expect(unwrap(await hooks().addObserver("observers", projectProps(owner), hidden)))
      .rejects.toThrow(/does not have read access to the GitLab project group\/sub\/project/);
  });

  it("allows a feature to whoever can list one row of its data, or for issues whom GraphQL lets read them, once GitLab shows them the project", async () => {
    const gitlab = fakeProject();
    gitlab.install();
    const id = await seedAccount({ accessToken: "observer" });
    const features = ALL_FEATURES.map(feature => `${PROJECT_SUBRESOURCE}/feature/${feature}`);
    expect(await unwrap(await hooks().checkSubresourceAccess(id, features))).toEqual([true, true, true, true]);
    const asked = gitlab.requests.map(r => r.url.pathname + r.url.search);
    expect(asked.slice(0, 2)).toEqual(["/api/v4/user", `/api/v4/projects/${PROJECT_ID}`]);
    expect(asked.slice(2).toSorted()).toEqual([
      ...Object.values(FEATURES).map(listing => `/api/v4/projects/${PROJECT_ID}/${listing}?per_page=1`), "/api/graphql",
    ].toSorted());
  });

  it.each(Object.entries(FEATURES).flatMap(([feature, listing]) => [403, 404].map(status => [feature, listing, status] as const)))(
    "denies %s to an observer whose %s answers %i, a feature disabled, restricted to members, or above their role, but not the project",
    async (feature, listing, status) => {
      const gitlab = fakeProject({ refused: { observer: { [listing]: status } } });
      gitlab.install();
      const id = await seedAccount({ accessToken: "observer" });
      const others = ALL_FEATURES.filter(other => other !== feature).map(other => `${PROJECT_SUBRESOURCE}/feature/${other}`);
      expect(await unwrap(await hooks().checkSubresourceAccess(id,
        [PROJECT_SUBRESOURCE, `${PROJECT_SUBRESOURCE}/feature/${feature}`, ...others]))).toEqual([true, false, true, true, true]);
    });

  it("denies issues to an observer they are closed to, though GitLab's issue listing answers them 200 []", async () => {
    const gitlab = fakeProject({ refused: { observer: { issues: 403 } } });
    gitlab.install();
    const id = await seedAccount({ accessToken: "observer" });
    expect(await unwrap(await hooks().checkSubresourceAccess(id,
      [PROJECT_SUBRESOURCE, `${PROJECT_SUBRESOURCE}/feature/issues`, `${PROJECT_SUBRESOURCE}/feature/repository`])))
      .toEqual([true, false, true]);
  });

  it("denies every feature of a project the token cannot see, without listing any", async () => {
    const gitlab = fakeProject({ hidden: { observer: 404 } });
    gitlab.install();
    const id = await seedAccount({ accessToken: "observer" });
    expect(await unwrap(await hooks().checkSubresourceAccess(id,
      [PROJECT_SUBRESOURCE, `${PROJECT_SUBRESOURCE}/feature/repository`]))).toEqual([false, false]);
    expect(gitlab.count("GET", new RegExp(`/api/v4/projects/${PROJECT_ID}/`))).toBe(0);
  });

  it("lets a listing's upstream failure propagate rather than answering it as a denial", async () => {
    fakeProject({ refused: { observer: { pipelines: 502 } } }).install();
    const id = await seedAccount({ accessToken: "observer" });
    await expect(unwrap(await hooks().checkSubresourceAccess(id, [`${PROJECT_SUBRESOURCE}/feature/builds`])))
      .rejects.toThrow(/GitLab could not check access \(502\)/);
  });
});
