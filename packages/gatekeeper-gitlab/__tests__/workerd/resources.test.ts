// Resource resolution and observer admission: the URL patterns are ordered most-specific first
// (the project pattern also matches issue and merge request URLs, and resolution is first-match),
// `getGatekeeperClassFor` parses nested namespaces via the `/-/` separator and binds the instance
// root (GITLAB_INSTANCE_CODE_SEARCH is on in this suite) to the read-only instance binding, stale
// stub-era props fail closed, and the observer probe requires Reporter membership whatever the
// project's visibility.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesResourceUrlPattern, resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import * as fx from "../fixtures/gitlab-docs.js";
import { FakeGitLab, hooks, json, projectProps, seedAccount, stageReconnect, unwrap } from "./fake-gitlab.js";
import type { SessionStep } from "./worker.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const PROJECT = "https://gitlab.example.com/group/sub/project";

describe("supported resources", () => {
  it("lists merge request, issue, project, then the instance, all on the configured instance", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    const resources = await unwrap(await hooks().supportedResources(id));
    expect(resources.map(r => r.title)).toEqual(["GitLab Merge Request", "GitLab Issue", "GitLab Project", "GitLab instance code"]);
    expect(resources.map(r => r.urlPattern)).toEqual([
      "https://gitlab.example.com/:project+/-/merge_requests/:iid{/*}?",
      "https://gitlab.example.com/:project+/-/issues/:iid{/*}?",
      "https://gitlab.example.com/:project+",
      "https://gitlab.example.com/",
    ]);
  });

  it("resolves the instance root, and only the root, to the instance resource", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    const resources = await unwrap(await hooks().supportedResources(id));
    for (const root of ["https://gitlab.example.com", "https://gitlab.example.com/"]) {
      expect(resolveRequestedResource(resources, root), root).toEqual({ ok: true, resource: resources[3] });
    }
    // A project URL never matches the root pattern, which is why the order does not matter.
    expect(matchesResourceUrlPattern(resources[3].urlPattern, PROJECT)).toBe(false);
    expect(resolveRequestedResource(resources, PROJECT)).toEqual({ ok: true, resource: resources[2] });
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

  it("binds the instance root to the instance resource, and a project URL never to it", async () => {
    new FakeGitLab().install();
    const id = await seedAccount();
    for (const root of ["https://gitlab.example.com", "https://gitlab.example.com/", "https://gitlab.example.com/?tab=1#top"]) {
      expect(await unwrap(await hooks().resourceFor(id, root)), root).toBe("https://gitlab.example.com/");
    }
    expect(await unwrap(await hooks().resourceFor(id, PROJECT))).toBe("https://gitlab.example.com/:project+");
    // Another instance's root is not this one.
    await expect(unwrap(await hooks().resourceFor(id, "https://gitlab.com/"))).rejects.toThrow(/Unsupported GitLab URL/);
  });
});

describe("instance binding", () => {
  const ROOT = "https://gitlab.example.com/";
  const PROJECT_ID = 7;
  let scenarios = 0;

  /**
   * GitLab with `group/sub/project` (id 7) and nothing else, and `GET /user` answering for every
   * token as an active user, internal unless named in `external`.
   */
  function instanceGitLab(external: string[] = []): FakeGitLab {
    const project = { ...fx.projectResponse.data, id: PROJECT_ID, path_with_namespace: "group/sub/project", web_url: PROJECT };
    return new FakeGitLab()
      .on("GET", /^\/api\/v4\/projects\//, () => json({ message: "404 Project Not Found" }, { status: 404 }))
      .on("GET", new RegExp(`^/api/v4/projects/(group%2Fsub%2Fproject|${PROJECT_ID})(\\?|$)`), () => json(project))
      .on("GET", /^\/api\/v4\/user$/, request => {
        const token = request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
        return json({
          id: token.length, username: token, name: token, web_url: `${ROOT}${token}`,
          state: "active", external: external.includes(token),
        });
      });
  }

  async function binding() {
    const name = `instance-${++scenarios}`;
    const owner = await seedAccount({ accessToken: "owner" });
    return {
      describe: () => hooks().boundDescribe(name, owner, ROOT),
      baseline: () => hooks().boundObserverBaseline(name, owner, ROOT),
      read: (steps: SessionStep[]) => hooks().boundSession(name, owner, ROOT, steps),
      observations: async () => {
        const log = await hooks().queueLog(name);
        return log.observations.map((title, index) => ({ title, subresources: log.subresources[index] }));
      },
      verify: (observers: Record<string, string>, subresources: string[]) => hooks().boundVerifyObservers(
        name, owner, ROOT, Object.entries(observers).map(([id, userObjectId]) => ({ id, userObjectId })), subresources),
    };
  }

  it("is the GitLabInstance the root binds to: read-only, with nothing recorded before it", async () => {
    instanceGitLab().install();
    const gk = await binding();
    expect(await gk.describe()).toEqual({ ok: {
      url: ROOT,
      title: "GitLab code on gitlab.example.com",
      snippet: "Search and read code in every project you can read on gitlab.example.com.",
      suggestedBindingName: "GITLAB_INSTANCE",
      tsType: "GitLabInstance",
    } });
    expect(await gk.baseline()).toEqual({ ok: { autoApprovable: [], historical: [] } });
  });

  it("opens a repository whose reads report it, reporting the opening, found or not, as the instance", async () => {
    instanceGitLab().install();
    const gk = await binding();
    expect(await gk.read([{ method: "getRepository", args: ["group/sub/project"] }, { method: "getMetadata" }]))
      .toMatchObject({ ok: { path: "group/sub/project" } });
    await expect(unwrap(await gk.read([{ method: "getRepository", args: ["group/missing"] }])))
      .rejects.toThrow(/no GitLab project "group\/missing"/);
    expect(await gk.observations()).toEqual([
      { title: "Open GitLab repository group/sub/project", subresources: ["instance/gitlab.example.com"] },
      { title: "Read project metadata for group/sub/project", subresources: [`repository/${PROJECT_ID}`] },
      { title: "Open GitLab repository group/missing", subresources: ["instance/gitlab.example.com"] },
    ]);
  });

  it("refuses a language not on the list before asking GitLab", async () => {
    const gitlab = instanceGitLab();
    gitlab.install();
    const gk = await binding();
    expect(await gk.read([{ method: "searchCode", args: [{ text: "x", language: "py" }], drain: true }]))
      .toEqual({ error: expect.stringMatching(/searchCode\[0\]\.language/) });
    expect(gitlab.requests.filter(request => request.url.pathname.endsWith("/search"))).toEqual([]);
    expect(await gk.observations()).toEqual([]);
  });

  it("admits observers through their own accounts, and refuses a requirement its reads never report", async () => {
    instanceGitLab(["bob"]).install();
    const gk = await binding();
    const [alice, bob] = await Promise.all([seedAccount({ accessToken: "alice" }), seedAccount({ accessToken: "bob" })]);
    expect(await gk.verify({ alice, bob }, ["instance/gitlab.example.com"])).toEqual({ ok: ["alice"] });
    // A project's membership, which metadata of a project whose repository is disabled reports:
    // neither is a member here.
    expect(await gk.verify({ alice, bob }, [`project/${PROJECT_ID}`])).toEqual({ ok: [] });
    await expect(unwrap(await gk.verify({ alice, bob }, [`project/${PROJECT_ID}/role/developer`])))
      .rejects.toThrow(/reports no subresource like project\/7\/role\/developer/);
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
  // The probe reads the observer's *effective* membership from `members/all?user_ids[]=`, never
  // the project's `permissions` object: on the instance this was checked against, `permissions`
  // reported null/null for group-inherited Developer access on every project but the one with a
  // direct membership -- and inherited access is what ~90% of members hold. The list form's
  // answers were checked live: a non-member is `[]`, an inherited Developer one row at 30.
  type Member = { access_level: number; membership_state?: string; expires_at?: string | null } | null;

  /** The bound project's numeric id, which a binding pins from its path and then reads it by. */
  const PROJECT_ID = 7;

  /**
   * A fake where the token names the user (`Bearer <username>`), `/user` answers with that
   * user's id, the project answers its path with its id, and `members/all` answers each user's
   * membership of it, addressed by path or by id -- 404 for a non-member, as for a project the
   * token cannot see.
   */
  function fakeMembers(members: Record<string, Member>, projectStatus = 200): FakeGitLab {
    const gitlab = new FakeGitLab();
    const ids = Object.fromEntries(Object.keys(members).map((name, i) => [name, 100 + i]));
    gitlab.on("GET", /^\/api\/v4\/user$/, request => {
      const name = request.headers.get("authorization")!.replace("Bearer ", "");
      return json({ id: ids[name] ?? 999, username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    gitlab.on("GET", new RegExp(`^/api/v4/projects/(?:group%2Fsub%2Fproject|${PROJECT_ID})$`), () => json({
      ...fx.projectResponse.data, id: PROJECT_ID, path_with_namespace: "group/sub/project",
      web_url: "https://gitlab.example.com/group/sub/project",
    }));
    gitlab.on("GET", new RegExp(`^/api/v4/projects/(?:group%2Fsub%2Fproject|${PROJECT_ID})/members/all\\?`), request => {
      if (projectStatus !== 200) return json({ message: `${projectStatus}` }, { status: projectStatus });
      // The documented `user_ids[]` filter; a non-member is the documented empty list.
      const id = Number(request.url.searchParams.get("user_ids[]"));
      const name = Object.keys(ids).find(n => ids[n] === id);
      const member = name === undefined ? null : members[name];
      return json(member === null || member === undefined ? [] : [{ id, username: name, ...member }]);
    });
    return gitlab;
  }

  async function probe(member: Member, projectStatus = 200) {
    fakeMembers({ observer: member }, projectStatus).install();
    const id = await seedAccount({ accessToken: "observer" });
    return await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
  }

  it("admits Reporter and above, however the membership is held -- direct, inherited, or through a shared group", async () => {
    // `members/all` already folds those into one effective level, so the probe never sees the
    // distinction; what it must not do is read the project's `permissions`, which drops it.
    expect(await probe({ access_level: 20 })).toBe(true);
    expect(await probe({ access_level: 30 })).toBe(true);
    expect(await probe({ access_level: 50 })).toBe(true);
  });

  it("denies Guest and Planner: they cannot read the repository, and Guest cannot read confidential issues", async () => {
    expect(await probe({ access_level: 10 })).toBe(false);
    expect(await probe({ access_level: 15 })).toBe(false);
  });

  it("denies a non-member whatever the visibility: a public project can still hold confidential issues and internal notes", async () => {
    expect(await probe(null)).toBe(false);
  });

  it("denies an invitation not yet accepted, and a project the token cannot see", async () => {
    expect(await probe({ access_level: 30, membership_state: "awaiting" })).toBe(false);
    expect(await probe({ access_level: 30 }, 404)).toBe(false);
    expect(await probe({ access_level: 30 }, 403)).toBe(false);
  });

  it("denies a membership whose expires_at has arrived, even while GitLab still lists the row", async () => {
    // GitLab: from that date on, the user can no longer access the project. The row lingers until
    // the daily sweep removes it, so the date is checked here rather than trusting the listing.
    const today = new Date().toISOString().slice(0, 10);
    expect(await probe({ access_level: 30, expires_at: "2000-01-01" })).toBe(false);
    expect(await probe({ access_level: 30, expires_at: today })).toBe(false);
    expect(await probe({ access_level: 30, expires_at: "not a date" })).toBe(false);
    expect(await probe({ access_level: 30, expires_at: "2999-01-01" })).toBe(true);
    expect(await probe({ access_level: 30, expires_at: null })).toBe(true);
  });

  it("lets an upstream failure propagate rather than answering it as a denial or an admission", async () => {
    await expect(probe({ access_level: 30 }, 502)).rejects.toThrow(/502/);
  });

  it("never consults the project's permissions object, and learns the observer's id once per grant", async () => {
    const gitlab = fakeMembers({ observer: { access_level: 30 } });
    gitlab.install();
    const id = await seedAccount({ accessToken: "observer" });
    await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
    expect(gitlab.requests.map(r => r.url.pathname + r.url.search)).toEqual([
      "/api/v4/user",
      "/api/v4/projects/group%2Fsub%2Fproject",
      `/api/v4/projects/${PROJECT_ID}/members/all?user_ids%5B%5D=100&per_page=100`,
    ]);
    // Re-verification (every workspace open) costs the path's project read and the membership read.
    await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
    expect(gitlab.count("GET", /\/api\/v4\/user$/)).toBe(1);
    expect(gitlab.count("GET", /members\/all/)).toBe(2);
  });

  it("does not admit a reconnected user on the previous user's membership", async () => {
    // Reporter `alice` connects; while her /user read is in flight the account is reconnected as
    // `bob`, a non-member. A probe that kept alice's id and used bob's token would look up alice's
    // Reporter row and admit bob. Instead the id is fenced to the connection that answered it, and
    // the probe re-reads under the new one -- and denies bob.
    const gitlab = fakeMembers({ alice: { access_level: 20 }, bob: null });
    gitlab.on("GET", /^\/api\/v4\/user$/, async request => {
      const name = request.headers.get("authorization")!.replace("Bearer ", "");
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

  it("is what addObserver enforces", async () => {
    fakeMembers({ owner: { access_level: 50 }, reporter: { access_level: 20 }, guest: { access_level: 10 }, outsider: null }).install();
    const owner = await seedAccount({ accessToken: "owner" });
    const reporter = await seedAccount({ accessToken: "reporter" });
    const guest = await seedAccount({ accessToken: "guest" });
    const outsider = await seedAccount({ accessToken: "outsider" });
    await unwrap(await hooks().addObserver("observers", projectProps(owner), reporter));
    for (const denied of [guest, outsider]) {
      await expect(unwrap(await hooks().addObserver("observers", projectProps(owner), denied)))
        .rejects.toThrow(/does not have read access to the GitLab project group\/sub\/project/);
    }
  });
});
