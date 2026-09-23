// Resource resolution and observer admission: the URL patterns are ordered most-specific first
// (the project pattern also matches issue and merge request URLs, and resolution is first-match),
// `getGatekeeperClassFor` parses nested namespaces via the `/-/` separator, stale stub-era props
// fail closed, and the observer probe requires Reporter membership whatever the project's visibility.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesResourceUrlPattern, resolveRequestedResource } from "@gadgets/workshop-shared/gatekeeper";
import { FakeGitLab, hooks, json, projectProps, seedAccount, unwrap } from "./fake-gitlab.js";

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
  // The probe reads the observer's *effective* membership from `members/all?user_ids[]=`, never
  // the project's `permissions` object: on the instance this was checked against, `permissions`
  // reported null/null for group-inherited Developer access on every project but the one with a
  // direct membership -- and inherited access is what ~90% of members hold. The list form's
  // answers were checked live: a non-member is `[]`, an inherited Developer one row at 30.
  type Member = { access_level: number; membership_state?: string; expires_at?: string | null } | null;

  /**
   * A fake where the token names the user (`Bearer <username>`), `/user` answers with that
   * user's id, and `members/all/:id` answers each user's membership -- 404 for a non-member, as
   * for a project the token cannot see.
   */
  function fakeMembers(members: Record<string, Member>, projectStatus = 200): FakeGitLab {
    const gitlab = new FakeGitLab();
    const ids = Object.fromEntries(Object.keys(members).map((name, i) => [name, 100 + i]));
    gitlab.on("GET", /^\/api\/v4\/user$/, request => {
      const name = request.headers.get("authorization")!.replace("Bearer ", "");
      return json({ id: ids[name] ?? 999, username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    gitlab.on("GET", /^\/api\/v4\/projects\/group%2Fsub%2Fproject\/members\/all\?/, request => {
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
      "/api/v4/projects/group%2Fsub%2Fproject/members/all?user_ids%5B%5D=100&per_page=100",
    ]);
    // Re-verification (every workspace open) costs the membership read alone.
    await unwrap(await hooks().hasProjectAccess(id, "group/sub/project"));
    expect(gitlab.count("GET", /\/api\/v4\/user$/)).toBe(1);
    expect(gitlab.count("GET", /members\/all/)).toBe(2);
  });

  it("does not admit a reconnected user on the previous user's membership", async () => {
    // Reporter `alice` connects; her /user read is slow. While it is in flight the account is
    // reconnected as `bob`, a non-member. A probe that kept alice's id and used bob's token would
    // look up alice's Reporter row and admit bob. Instead the id is fenced to the grant that
    // answered it, and the probe re-reads under the new grant -- and denies bob.
    const gitlab = fakeMembers({ alice: { access_level: 20 }, bob: null });
    let released!: () => void;
    const holdAlice = new Promise<void>(resolve => { released = resolve; });
    gitlab.on("GET", /^\/api\/v4\/user$/, async request => {
      const name = request.headers.get("authorization")!.replace("Bearer ", "");
      if (name === "alice") await holdAlice;
      return json({ id: name === "alice" ? 100 : 101, username: name, name, web_url: `https://gitlab.example.com/${name}` });
    });
    gitlab.install();
    const id = await seedAccount({ accessToken: "alice" });
    const stub = env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(id));
    await runInDurableObject(stub, async (_i, state) => { state.storage.kv.put("grantId", "grant-alice"); });

    const probe = hooks().hasProjectAccess(id, "group/sub/project");
    // The reconnect lands mid-read: bob's tokens under a new grant id.
    for (let i = 0; i < 50 && gitlab.count("GET", /\/api\/v4\/user$/) === 0; i++) await new Promise(r => setTimeout(r, 5));
    await runInDurableObject(stub, async (_i, state) => {
      state.storage.kv.put("accessToken", "bob");
      state.storage.kv.put("grantId", "grant-bob");
      state.storage.kv.delete("userId");
    });
    released();
    expect(await unwrap(await probe)).toBe(false);
    // Alice's id was never stored against bob's grant.
    await runInDurableObject(stub, async (_i, state) => {
      expect(state.storage.kv.get("userId")).toBe(101);
    });
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
