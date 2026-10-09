// Where a binding can reach: a malformed issue or PR URL never widens to the whole repo, and the
// gatekeeper follows GitHub's redirects only within the repository id it pinned, so a renamed repo
// keeps working while a transferred issue never leaks another repository's content.

import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps } from "./worker";

const SHA = "a".repeat(40);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getGatekeeperClassFor", () => {
  const hooks = () => env.TEST_HOOKS.getByName("resources");

  it.each([
    ["https://github.com/octo/repo/issues/new"],
    ["https://github.com/octo/repo/issues"],
    ["https://github.com/octo/repo/pull/12abc"],
  ])("refuses the malformed issue or PR URL %s", async url => {
    expect(await hooks().resourcePatternFor(url))
      .toEqual({ error: `Unsupported GitHub URL: ${url}` });
  });

  it.each([
    ["https://github.com/octo/repo/issues/12", "https://github.com/:owner/:repo/issues/:number"],
    ["https://github.com/octo/repo/pull/7/files", "https://github.com/:owner/:repo/pull/:number"],
    ["https://github.com/octo/repo", "https://github.com/:owner/:repo"],
  ])("resolves %s", async (url, pattern) => {
    expect(await hooks().resourcePatternFor(url)).toEqual({ ok: pattern });
  });
});

/** Fakes GitHub's REST API by path, recording each path requested. */
function fakeGitHub(routes: Record<string, () => Response>): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input));
    requested.push(pathname);
    const route = routes[pathname];
    if (!route) throw new Error(`test: unexpected fetch to ${pathname}`);
    return route();
  });
  return requested;
}

const movedTo = (path: string) => () =>
  new Response(null, { status: 301, headers: { location: `https://api.github.com${path}` } });

const sha = () => new Response(SHA, { headers: { "content-type": "application/vnd.github.sha" } });

let scenarios = 0;

/** `resolveRef` on a fresh repo-scoped gatekeeper for `octo/repo`, as plain data. */
async function repoGatekeeper() {
  const scenario = `redirects-${++scenarios}`;
  const accountId = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(accountId), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  const props: GatekeeperProps = {
    userObjectId: accountId.toString(), resourceKind: "repo", owner: "octo", repo: "repo",
  };
  const hooks = env.TEST_HOOKS.getByName(scenario);
  return { resolveRef: (ref: string) => hooks.resolveRef(scenario, props, ref) };
}

describe("GitHubGatekeeperImpl redirects", () => {
  it("follows a rename within its pinned repository id and refuses any other", async () => {
    const requested = fakeGitHub({
      "/repos/octo/repo": () => Response.json({ id: 42 }),
      "/repos/octo/repo/commits/main": movedTo("/repositories/42/commits/main"),
      "/repositories/42/commits/main": sha,
      "/repos/octo/repo/commits/other": movedTo("/repositories/43/commits/other"),
    });
    const gk = await repoGatekeeper();

    expect(await gk.resolveRef("main")).toEqual({ ok: { id: SHA, fromCache: false } });
    const refused = await gk.resolveRef("other");
    expect(refused).toEqual({ error: expect.stringContaining("out of the bound repository") });
    expect(JSON.stringify(refused)).not.toContain("43");
    // The id is probed once, and the other repository is never requested.
    expect(requested).toEqual([
      "/repos/octo/repo",
      "/repos/octo/repo/commits/main",
      "/repositories/42/commits/main",
      "/repos/octo/repo/commits/other",
    ]);
  });

  it("pins a repository renamed before its id was pinned from the root's redirect", async () => {
    const requested = fakeGitHub({
      "/repos/octo/repo": movedTo("/repositories/42"),
      "/repositories/42": () => Response.json({ id: 42 }),
      "/repos/octo/repo/commits/main": movedTo("/repositories/42/commits/main"),
      "/repositories/42/commits/main": sha,
    });
    const gk = await repoGatekeeper();

    expect(await gk.resolveRef("main")).toEqual({ ok: { id: SHA, fromCache: false } });
    expect(requested).toEqual([
      "/repos/octo/repo", "/repositories/42",
      "/repos/octo/repo/commits/main", "/repositories/42/commits/main",
    ]);
  });

  it("trusts no redirect when the root's redirect names no repository id", async () => {
    const requested = fakeGitHub({
      "/repos/octo/repo": movedTo("/repos/octo/elsewhere"),
      "/repos/octo/repo/commits/main": movedTo("/repositories/42/commits/main"),
    });
    const gk = await repoGatekeeper();

    expect(await gk.resolveRef("main"))
      .toEqual({ error: expect.stringContaining("out of the bound repository") });
    expect(await gk.resolveRef("main"))
      .toEqual({ error: expect.stringContaining("out of the bound repository") });
    // The failed probe is not repeated by the second read.
    expect(requested).toEqual([
      "/repos/octo/repo", "/repos/octo/repo/commits/main", "/repos/octo/repo/commits/main",
    ]);
  });
});
