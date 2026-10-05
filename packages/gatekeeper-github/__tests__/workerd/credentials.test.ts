// The account's credential lifecycle against GitHub's token endpoint, faked at `fetch`: an
// expiring grant (GitHub's default for OAuth apps since August 2026) is refreshed before its
// eight hours run out, each refresh rotates both tokens, a dead refresh token reaches the Workshop
// as `credentialsExpired()` exactly once, and a non-expiring grant -- including one stored before
// refresh was supported -- is served as it always was.

import { env, runInDurableObject } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import { isCredentialsExpired } from "@gadgets/gatekeeper-kit/credentials";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectCallbackEvents } from "./worker";

const TOKEN_URL = "https://github.com/login/oauth/access_token";

/** Inside the 60s refresh skew, so the next read refreshes. */
const NEARLY_EXPIRED = 30;
const EIGHT_HOURS = 8 * 60 * 60;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json" },
  });
}

function tokens(n: number, expiresIn = EIGHT_HOURS): Record<string, unknown> {
  return {
    access_token: `gho_${n}`,
    refresh_token: `ghr_${n}`,
    expires_in: expiresIn,
    refresh_token_expires_in: 15_897_600,
    scope: "repo,read:user,user:email",
    token_type: "bearer",
  };
}

/** GitHub's token endpoint and REST API, answered by the test's handlers. */
class FakeGitHub {
  /** Form parameters of every token-endpoint request, in order. */
  readonly tokenRequests: Record<string, string>[] = [];
  /** Bearer tokens presented to REST API reads, in order. */
  readonly apiTokens: string[] = [];
  /** Paths of REST API POSTs, in order. */
  readonly posts: string[] = [];
  /** Access tokens revoked through `DELETE /applications/{client_id}/token`, in order. */
  readonly revoked: string[] = [];
  onRevoke: (token: string) => void | Promise<void> = () => {};
  respondToken: (params: Record<string, string>) => Response | Promise<Response> =
    () => json({ error: "unexpected_token_request" }, 500);
  respondApi: (token: string, path: string) => Response | Promise<Response> =
    () => json({ login: "octocat", name: "Octo Cat", avatar_url: "https://avatars.example/1" });
  respondPost: (path: string) => Response | Promise<Response> =
    () => json({ message: "unexpected POST" }, 500);

  constructor() {
    vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) =>
      this.#handle(new Request(input, init)));
  }

  /** Token-endpoint requests that redeemed a refresh token. */
  refreshes(): string[] {
    return this.tokenRequests
      .filter(params => params.grant_type === "refresh_token")
      .map(params => params.refresh_token);
  }

  async #handle(request: Request): Promise<Response> {
    if (request.url === TOKEN_URL) {
      const form = await request.formData();
      const params = Object.fromEntries([...form].map(([key, value]) => [key, String(value)]));
      this.tokenRequests.push(params);
      return await this.respondToken(params);
    }
    const url = new URL(request.url);
    if (url.hostname === "api.github.com" && request.method === "GET") {
      const token = request.headers.get("Authorization")?.replace(/^Bearer /, "") ?? "";
      this.apiTokens.push(token);
      return await this.respondApi(token, url.pathname);
    }
    if (url.hostname === "api.github.com" && request.method === "POST") {
      this.posts.push(url.pathname);
      return await this.respondPost(url.pathname);
    }
    if (url.pathname === "/applications/test-client/token" && request.method === "DELETE") {
      const token = (await request.json<{ access_token: string }>()).access_token;
      this.revoked.push(token);
      await this.onRevoke(token);
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${request.method} ${request.url}`);
  }
}

type TestExports = {
  TestConnectCallback(options: { props: { name: string } }): Fetcher<GatekeeperConnectCallback>;
};

const exportsOf = (state: DurableObjectState) => state.exports as unknown as TestExports;

let connections = 0;

/** Connects a fresh account through the OAuth flow, with GitHub answering the code exchange. */
async function connect(github: FakeGitHub, exchange: Record<string, unknown>) {
  const name = `account-${++connections}`;
  const id = env.USER_ACCOUNT.newUniqueId();
  const account = env.USER_ACCOUNT.get(id);
  await runInDurableObject(account, async (instance, state) => {
    await instance.setCallback(
      exportsOf(state).TestConnectCallback({ props: { name } }), "initiation-nonce");
  });
  github.respondToken = () => json(exchange);
  const begun = await account.beginOAuthFlow("initiation-nonce");
  expect(await account.acceptAuthCode("code", begun!.oauthNonce)).not.toBeNull();
  github.tokenRequests.length = 0;
  return { account, id, events: () => connectCallbackEvents.get(name) ?? [] };
}

/** `GatekeeperUser.describe()`, the account's own GitHub call, as plain data. */
async function describeAccount(userObjectId: string) {
  return await env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("credentials"))
    .describeAccount(userObjectId);
}

/** `GitHubVerifier.hasRepoAccess()` as the account, as plain data. */
async function hasRepoAccess(userObjectId: string, owner: string, repo: string) {
  return await env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("credentials"))
    .hasRepoAccess(userObjectId, owner, repo);
}

/** Stands in for the overseer's approval queue, which a submit must reach. */
class TestApprovalQueue extends RpcTarget {
  async submitAction(): Promise<void> {}
}

/** The git cache an apply is handed; a review's apply never calls it. */
class UnusedGitCache extends RpcTarget {}

/**
 * Queues a one-comment review of pull request #7 as the account.
 * @returns Its apply, as plain data.
 */
async function queueReview(userObjectId: string) {
  const facet = `review-${++connections}`;
  const props = { userObjectId, resourceKind: "repo", owner: "octo", repo: "repo" } as const;
  const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("credentials"));
  // The caller keeps ownership of a stub it passes as a param (see capnweb's README).
  using queue = new RpcStub(new TestApprovalQueue());
  const submitted = await hooks.submitReview(facet, props, queue, {
    type: "postReview", approvalId: 1, submittedAt: 0, owner: "octo", repo: "repo",
    pullId: "7", provisionalReviewId: "~r1",
    review: {
      revision: { baseSha: "a".repeat(40), headSha: "b".repeat(40) },
      decision: "comment",
      diffComments: [{
        provisionalCommentId: "~c1", bodyMarkdown: "nit", target: { path: "a.ts", line: 3, side: "new" },
      }],
    },
  }, { title: "review", description: "test review", implementsRevert: false });
  expect(submitted).not.toHaveProperty("error");
  return async () => {
    using cache = new RpcStub(new UnusedGitCache());
    return await hooks.applyAction(facet, props, 1, cache as never);
  };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("UserAccount with an expiring grant", () => {
  it("refreshes before expiry, redeeming each rotated refresh token once", async () => {
    const github = new FakeGitHub();
    const { account, events } = await connect(github, tokens(1, NEARLY_EXPIRED));
    const issued = [tokens(2, NEARLY_EXPIRED), tokens(3)];
    github.respondToken = () => json(issued.shift());

    expect(await account.getAccessToken()).toBe("gho_2");
    expect(await account.getAccessToken()).toBe("gho_3");
    expect(await account.getAccessToken()).toBe("gho_3");

    expect(github.refreshes()).toEqual(["ghr_1", "ghr_2"]);
    expect(github.tokenRequests[0]).toMatchObject({
      grant_type: "refresh_token", client_id: "test-client", client_secret: "test-secret",
    });
    expect(await account.getScopes()).toEqual(["repo", "read:user", "user:email"]);
    expect(events()).toEqual(["complete"]);
  });

  it("serves concurrent reads from a single refresh", async () => {
    const github = new FakeGitHub();
    const { account } = await connect(github, tokens(1, NEARLY_EXPIRED));
    const release = Promise.withResolvers<void>();
    github.respondToken = async () => {
      await release.promise;
      return json(tokens(2));
    };

    const reads = Array.from({ length: 5 }, () => account.getAccessToken());
    await vi.waitUntil(() => github.tokenRequests.length > 0);
    release.resolve();

    expect(await Promise.all(reads)).toEqual(Array(5).fill("gho_2"));
    expect(github.refreshes()).toEqual(["ghr_1"]);
  });

  it("reports a dead refresh token to the Workshop once and stops serving the grant", async () => {
    const github = new FakeGitHub();
    const { account, events } = await connect(github, tokens(1, NEARLY_EXPIRED));
    // GitHub's answer for an expired, revoked, or already-used refresh token.
    github.respondToken = () => json({
      error: "bad_refresh_token",
      error_description: "The refresh token passed is incorrect or expired.",
    });

    expect(isCredentialsExpired(await rejection(account.getAccessToken()))).toBe(true);
    expect(isCredentialsExpired(await rejection(account.getAccessToken()))).toBe(true);

    expect(github.refreshes()).toEqual(["ghr_1"]);
    expect(events()).toEqual(["complete", "credentialsExpired"]);
  });

  it("does not treat a token-endpoint outage as expiry", async () => {
    const github = new FakeGitHub();
    const { account, events } = await connect(github, tokens(1, NEARLY_EXPIRED));
    github.respondToken = () => new Response("unavailable", { status: 503 });

    expect(isCredentialsExpired(await rejection(account.getAccessToken()))).toBe(false);

    github.respondToken = () => json(tokens(2));
    expect(await account.getAccessToken()).toBe("gho_2");
    expect(github.refreshes()).toEqual(["ghr_1", "ghr_1"]);
    expect(events()).toEqual(["complete"]);
  });

  it("fails a request whose token a refresh replaced in flight as retryable, not expired",
    async () => {
      const github = new FakeGitHub();
      const { account, id, events } = await connect(github, tokens(1, NEARLY_EXPIRED));
      const issued = [tokens(2, NEARLY_EXPIRED), tokens(3)];
      github.respondToken = () => json(issued.shift());
      const release = Promise.withResolvers<void>();
      github.respondApi = async () => {
        await release.promise;
        return json({ message: "Bad credentials" }, 401);
      };

      const described = describeAccount(id.toString());
      await vi.waitUntil(() => github.apiTokens.length > 0);
      // A concurrent read refreshes while the request is in flight, which makes GitHub reject the
      // token the request presented.
      expect(await account.getAccessToken()).toBe("gho_3");
      release.resolve();

      expect(await described)
        .toEqual({ error: "GitHub credentials were renewed during this request. Please retry it." });
      expect(github.apiTokens).toEqual(["gho_2"]);
      expect(github.refreshes()).toEqual(["ghr_1", "ghr_2"]);
      expect(events()).toEqual(["complete"]);

      github.respondApi = () => json({ login: "octocat", avatar_url: "https://avatars.example/1" });
      expect(await describeAccount(id.toString())).toMatchObject({ ok: { uniqueName: "octocat" } });
    });

  it("replays an observer check whose token a refresh replaced in flight", async () => {
    const github = new FakeGitHub();
    const { account, id, events } = await connect(github, tokens(1, NEARLY_EXPIRED));
    const issued = [tokens(2, NEARLY_EXPIRED), tokens(3)];
    github.respondToken = () => json(issued.shift());
    const release = Promise.withResolvers<void>();
    github.respondApi = async token => {
      if (token === "gho_3") return json({ full_name: "octo/repo" });
      await release.promise;
      return json({ message: "Bad credentials" }, 401);
    };

    const checked = hasRepoAccess(id.toString(), "octo", "repo");
    await vi.waitUntil(() => github.apiTokens.length > 0);
    expect(await account.getAccessToken()).toBe("gho_3");
    release.resolve();

    expect(await checked).toEqual({ ok: true });
    expect(github.apiTokens).toEqual(["gho_2", "gho_3"]);
    expect(events()).toEqual(["complete"]);
  });

  it.each([403, 404])("still reads an observer check's %i as no access", async status => {
    const github = new FakeGitHub();
    const { id, events } = await connect(github, tokens(1));
    github.respondApi = () => json({ message: "Not Found" }, status);

    expect(await hasRepoAccess(id.toString(), "octo", "private")).toEqual({ ok: false });
    expect(events()).toEqual(["complete"]);
  });

  it("finishes applying a review whose follow-up read lost its token to a refresh", async () => {
    const github = new FakeGitHub();
    const { account, id, events } = await connect(github, tokens(1));
    github.respondToken = () => json(tokens(2));
    github.respondPost = () => json({ id: 99 });
    const release = Promise.withResolvers<void>();
    github.respondApi = async token => {
      if (token === "gho_2") return json([]);
      await release.promise;
      return json({ message: "Bad credentials" }, 401);
    };
    const apply = await queueReview(id.toString());

    const applied = apply();
    await vi.waitUntil(() => github.apiTokens.length > 0);
    // Another request saw the token rejected and refreshed past it while this read was in flight.
    expect(await account.reportTokenRejected("gho_1")).toBe("superseded");
    release.resolve();

    expect(await applied).not.toHaveProperty("error");
    expect(github.posts).toEqual(["/repos/octo/repo/pulls/7/reviews"]);
    expect(github.apiTokens).toEqual(["gho_1", "gho_2"]);
    expect(events()).toEqual(["complete"]);
    // Recorded as applied, so applying again cannot post a second review.
    expect(await apply()).toEqual({ error: expect.stringContaining("no longer pending") });
  });

  it("heals a rejection of the current token by refreshing past it", async () => {
    const github = new FakeGitHub();
    const { account, events } = await connect(github, tokens(1));
    github.respondToken = () => json(tokens(2));

    expect(await account.reportTokenRejected("gho_1")).toBe("superseded");
    expect(await account.getAccessToken()).toBe("gho_2");
    expect(events()).toEqual(["complete"]);
  });

  it("revokes a refresh that lands while a disconnect is revoking", async () => {
    const github = new FakeGitHub();
    const { account } = await connect(github, tokens(1, NEARLY_EXPIRED));
    const release = Promise.withResolvers<void>();
    github.respondToken = async () => {
      await release.promise;
      return json(tokens(2));
    };
    const read = rejection(account.getAccessToken());
    // The refresh lands while the disconnect waits on GitHub to revoke the old token.
    github.onRevoke = async token => {
      if (token !== "gho_1") return;
      release.resolve();
      await read.catch(() => undefined);
    };
    await vi.waitUntil(() => github.tokenRequests.length > 0);
    await account.revoke();

    expect(isCredentialsExpired(await read)).toBe(true);
    expect(github.revoked).toEqual(["gho_1", "gho_2"]);
    expect(isCredentialsExpired(await rejection(account.getAccessToken()))).toBe(true);
  });
});

describe("UserAccount with a non-expiring grant", () => {
  it("serves the token without refreshing", async () => {
    const github = new FakeGitHub();
    const { account } = await connect(github, {
      access_token: "gho_1", scope: "repo, read:user", token_type: "bearer",
    });

    expect(await account.getAccessToken()).toBe("gho_1");
    expect(await account.getScopes()).toEqual(["repo", "read:user"]);
    expect(github.tokenRequests).toEqual([]);
  });

  it("keeps serving a grant stored before refresh was supported", async () => {
    const github = new FakeGitHub();
    const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.newUniqueId());
    await runInDurableObject(account, async (_instance, state) => {
      state.storage.kv.put("accessToken", "gho_legacy");
      state.storage.kv.put("scopes", ["repo"]);
    });

    expect(await account.getAccessToken()).toBe("gho_legacy");
    expect(await account.getScopes()).toEqual(["repo"]);
    expect(github.tokenRequests).toEqual([]);
  });

  it("tells the Workshop of a death that a grant stored before refresh latched", async () => {
    // That layout set its expiry latch before delivering the notice, so a failed delivery left
    // the account showing as connected.
    const github = new FakeGitHub();
    const id = env.USER_ACCOUNT.newUniqueId();
    await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
      state.storage.kv.put("callback",
        exportsOf(state).TestConnectCallback({ props: { name: "latched-legacy" } }));
      state.storage.kv.put("accessToken", "gho_legacy");
      state.storage.kv.put("scopes", ["repo"]);
      state.storage.kv.put("expiredNotified", true);
    });
    github.respondApi = () => json({ message: "Bad credentials" }, 401);

    expect(await describeAccount(id.toString())).toEqual(
      { error: "GitHub credentials have expired or been revoked. Please reconnect the account." });
    expect(connectCallbackEvents.get("latched-legacy")).toEqual(["credentialsExpired"]);
  });

  it("reports a rejected token to the Workshop as expired, once", async () => {
    const github = new FakeGitHub();
    const { id, events } = await connect(github, {
      access_token: "gho_1", scope: "repo", token_type: "bearer",
    });
    github.respondApi = () => json({ message: "Bad credentials" }, 401);

    const expired =
      { error: "GitHub credentials have expired or been revoked. Please reconnect the account." };
    expect(await describeAccount(id.toString())).toEqual(expired);
    expect(await describeAccount(id.toString())).toEqual(expired);

    expect(github.apiTokens).toEqual(["gho_1"]);
    expect(github.tokenRequests).toEqual([]);
    expect(events()).toEqual(["complete", "credentialsExpired"]);
  });
});
