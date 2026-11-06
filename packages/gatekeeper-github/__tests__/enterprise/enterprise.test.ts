import { env, runInDurableObject, SELF } from "cloudflare:test";
import { RpcStub, RpcTarget } from "cloudflare:workers";
import type { GatekeeperConnectCallback } from "@gadgets/workshop-shared/gatekeeper";
import { afterEach, expect, it, vi } from "vitest";
import { repoSubresourceId } from "../../src/repo-subresources";

const hooks = () => env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("enterprise"));

afterEach(() => vi.unstubAllGlobals());

it("connects through Enterprise OAuth and reads a repository on the worker-facing origin", async () => {
  const requests: Request[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    expect(new URL(request.url).origin).toBe("https://api.example.com");
    if (request.url.endsWith("/login/oauth/access_token")) {
      return Response.json({ access_token: "enterprise-token", token_type: "bearer", scope: "repo,read:user,user:email" });
    }
    if (request.url.endsWith("/api/v3/user")) return Response.json({ login: "ada", name: "Ada", avatar_url: "" });
    if (/\/api\/v3\/(repos\/acme\/app|repositories\/42)$/.test(request.url)) {
      return Response.json({ id: 42, name: "app", owner: { login: "acme" }, description: null,
        visibility: "private", private: true, default_branch: "main" });
    }
    throw new Error(`Unexpected request ${request.url}`);
  });
  const id = env.USER_ACCOUNT.newUniqueId();
  const account = env.USER_ACCOUNT.get(id);
  const initiationNonce = "a".repeat(64);
  await runInDurableObject(account, async (instance, state) => {
    const exports = state.exports as unknown as {
      TestConnectCallback(options: { props: { name: string } }): Fetcher<GatekeeperConnectCallback>;
    };
    await instance.setCallback(exports.TestConnectCallback({ props: { name: "enterprise" } }), initiationNonce);
  });
  const response = await SELF.fetch(`http://localhost:8787/gatekeeper/github/${id}/${initiationNonce}`, { redirect: "manual" });
  const authorization = new URL(response.headers.get("location")!);
  expect(authorization.origin).toBe("https://git.example.com");
  expect(authorization.pathname).toBe("/login/oauth/authorize");
  const nonce = authorization.searchParams.get("state")!.split(":")[1];
  expect(await account.acceptAuthCode("code", nonce)).not.toBeNull();
  expect(await hooks().describeAccount(id.toString())).toMatchObject({ ok: { uniqueName: "ada" } });
  expect(await hooks().resourcePatternFor("https://git.example.com/acme/app/issues/7"))
    .toEqual({ ok: "https://git.example.com/:owner/:repo/issues/:number" });
  expect(await hooks().resourcePatternFor("https://github.com/acme/app")).toHaveProperty("error");
  const props = { userObjectId: id.toString(), instance: "https://git.example.com", resourceKind: "repo" as const,
    owner: "acme", repo: "app" };
  expect(await hooks().repoMetadata("repo", props)).toMatchObject({ ok: { url: "https://git.example.com/acme/app" } });
  expect(requests.map(request => new URL(request.url).pathname)).toEqual([
    "/login/oauth/access_token", "/api/v3/user", "/api/v3/repos/acme/app", "/api/v3/repositories/42",
  ]);
  expect(requests[1].headers.get("authorization")).toBe("Bearer enterprise-token");
  const observations: string[][] = [];
  class Queue extends RpcTarget {
    async authorizeObservation(description: { subresources: string[] }): Promise<void> {
      observations.push(description.subresources);
    }
  }
  using queue = new RpcStub(new Queue());
  expect(await hooks().sessionRead("repo", props, queue as never, [{ method: "getMetadata" }]))
    .toMatchObject({ ok: { url: "https://git.example.com/acme/app" } });
  const requirement = repoSubresourceId(42, "https://git.example.com");
  expect(observations).toEqual([[requirement]]);
  expect(await hooks().verifyObservers("repo", props, [{ id: "observer", userObjectId: id.toString() }], [requirement]))
    .toEqual({ ok: { allowedObserverIds: ["observer"] } });
  expect(await hooks().verifyObservers("repo", props, [{ id: "observer", userObjectId: id.toString() }], ["repo/42"]))
    .toHaveProperty("error");
});

it("refuses GitHub.com accounts and bindings after changing the configured instance", async () => {
  const account = env.USER_ACCOUNT.get(env.USER_ACCOUNT.newUniqueId());
  await runInDurableObject(account, async (_instance, state) => {
    state.storage.kv.put("accessToken", "old-token");
    state.storage.kv.put("scopes", ["repo"]);
  });
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  expect(await hooks().describeAccount(account.id.toString())).toMatchObject({ error: expect.stringContaining("different GitHub instance") });
  expect(await hooks().repoMetadata("old-binding", { userObjectId: account.id.toString(), resourceKind: "repo",
    owner: "acme", repo: "app" })).toMatchObject({ error: expect.stringContaining("different GitHub instance") });
  expect(fetch).not.toHaveBeenCalled();
});
