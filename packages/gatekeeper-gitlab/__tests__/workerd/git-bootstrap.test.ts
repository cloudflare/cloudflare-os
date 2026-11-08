import { buildGitFetchRequest, FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type { RpcStub } from "cloudflare:workers";
import type { GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ACCESS, API, FakeGitLab, hooks, json, projectProps, seedAccount, tokenResponse, unwrap } from "./fake-gitlab";
import type { GatekeeperProps } from "./worker";

afterEach(() => vi.unstubAllGlobals());

const COMMIT = "a".repeat(40);
const PROJECT = "group/sub/project";
const ENDPOINT = /^\/group\/sub\/project\.git\/git-upload-pack$/;
const HEADERS = { "Content-Type": "application/x-git-upload-pack-result" };
// Include non-text bytes so decoding/re-encoding the upload-pack response would fail the test.
const PACK = new Uint8Array([0, 255, 128, 80, 65, 67, 75, 13, 10]);

const OPTIONS = {type: "commit", commitHistory: {kind: "depth", depth: 1}} as const;
const request = () => buildGitFetchRequest([COMMIT], OPTIONS);
const sideband = (band: number, payload: Uint8Array) => new Uint8Array([
  ...new TextEncoder().encode((payload.length + 5).toString(16).padStart(4, "0")), band, ...payload,
]);
const packResponse = () => new Blob([
  encodePktLine("packfile"), sideband(1, PACK), FLUSH_PKT,
]);

async function setup(name: string, resourceKind: GatekeeperProps["resourceKind"] = "project") {
  const gitlab = new FakeGitLab().on("POST", ENDPOINT, () => new Response(packResponse(), { headers: HEADERS }));
  gitlab.install();
  const props = { ...projectProps(await seedAccount(), PROJECT), resourceKind };
  return { gitlab, props, name };
}

describe("unified GitLab pack stream", () => {
  it.each(["project", "issue", "mergeRequest"] as const)("streams through the %s binding's own project", async kind => {
    const { gitlab, props, name } = await setup(`bootstrap-${kind}`, kind);
    const body = request();
    using transfer = await unwrap(await hooks().gitPull(
      name, props, [COMMIT], OPTIONS)) as RpcStub<GitPullTransfer>;
    expect(new Uint8Array(await new Response(await transfer.stream()).arrayBuffer())).toEqual(PACK);
    expect(await transfer.status()).toEqual({state: "complete"});
    expect(gitlab.requests).toHaveLength(1);
    const upstream = gitlab.requests[0];
    expect(upstream.url.href).toBe(`${API}/${PROJECT}.git/git-upload-pack`);
    expect(upstream.bytes).toEqual(body);
    expect(upstream.headers.get("git-protocol")).toBe("version=2");
    expect(upstream.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:test-token")}`);
    expect(upstream.headers.get("cf-access-client-id")).toBe(ACCESS.id);
    expect(upstream.headers.get("cf-access-client-secret")).toBe(ACCESS.secret);
    // No REST reads, reference discovery, or GitCache capability is needed by this path.
  });

  it.each(["refs/heads/main", "a".repeat(39), "a".repeat(40) + "\\ncommand=ls-refs"])(
    "rejects invalid object id %s before contacting GitLab", async oid => {
      const {gitlab, props, name} = await setup("invalid-oid");
      expect(await hooks().gitPull(name, props, [oid], OPTIONS)).toHaveProperty("error");
      expect(gitlab.requests).toHaveLength(0);
    });

  it.each([
    {
      name: "ERR",
      body: () => new Blob([encodePktLine("ERR not our ref")]),
      message: "git fetch failed: not our ref",
    },
    {
      name: "sideband fatal",
      body: () => new Blob([
        encodePktLine("packfile"), sideband(1, PACK),
        sideband(3, new TextEncoder().encode("fatal: the remote end hung up")),
      ]),
      message: "git fetch failed: fatal: the remote end hung up",
    },
    {
      name: "truncated response",
      body: () => new Blob([encodePktLine("packfile"), sideband(1, PACK)]),
      message: "truncated git fetch response: missing final flush",
    },
  ])("retains a $name error across Workers RPC", async ({name: label, body, message}) => {
    const {gitlab, props, name} = await setup(`bootstrap-error-${label}`);
    gitlab.on("POST", ENDPOINT, () => new Response(body(), {headers: HEADERS}));
    using transfer = await unwrap(await hooks().gitPull(
      name, props, [COMMIT], OPTIONS)) as RpcStub<GitPullTransfer>;
    await expect(new Response(await transfer.stream()).arrayBuffer()).rejects.toThrow();
    expect(await transfer.status()).toEqual({state: "failed", message});
  });

  it("returns an unfinished binary stream without collecting the entire pack", async () => {
    const { gitlab, props, name } = await setup("bootstrap-streaming");
    gitlab.on("POST", ENDPOINT, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encodePktLine("packfile"));
        controller.enqueue(sideband(1, PACK));
      },
      // Never finish the upstream response. A buffering implementation cannot return its first
      // chunk; cancellation must close it without touching a controller from another DO.
      pull() { return new Promise<void>(() => {}); },
    }), { headers: HEADERS }));
    using transfer = await unwrap(await hooks().gitPull(
      name, props, [COMMIT], OPTIONS)) as RpcStub<GitPullTransfer>;
    const reader = (await transfer.stream()).getReader();
    try {
      await expect((async () => { await transfer.stream(); })()).rejects.toThrow("already claimed");
      expect(await reader.read()).toEqual({ done: false, value: PACK });
      expect(await transfer.status()).toEqual({state: "streaming"});
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it("uses refreshed credentials rather than exporting them to the caller", async () => {
    const gitlab = new FakeGitLab()
      .on("POST", /^\/oauth\/token$/, () => json(tokenResponse(1)))
      .on("POST", ENDPOINT, () => new Response(packResponse(), { headers: HEADERS }));
    gitlab.install();
    const props = projectProps(await seedAccount({ expiresInMs: -1 }), PROJECT);
    using transfer = await unwrap(await hooks().gitPull(
      "bootstrap-refresh", props, [COMMIT], OPTIONS)) as RpcStub<GitPullTransfer>;
    expect(new Uint8Array(await new Response(await transfer.stream()).arrayBuffer())).toEqual(PACK);
    expect(gitlab.count("POST", /^\/oauth\/token$/)).toBe(1);
    const upstream = gitlab.requests.find(call => ENDPOINT.test(call.url.pathname))!;
    expect(upstream.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:access-1")}`);
  });

  it("rechecks account credentials after a prior successful bootstrap", async () => {
    const { gitlab, props, name } = await setup("bootstrap-revoked");
    using transfer = await unwrap(await hooks().gitPull(
      name, props, [COMMIT], OPTIONS)) as RpcStub<GitPullTransfer>;
    await new Response(await transfer.stream()).arrayBuffer();
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(props.userObjectId)),
      async (_instance, state) => { await state.storage.deleteAll(); });
    expect(await hooks().gitPull(name, props, [COMMIT], OPTIONS)).toHaveProperty("error");
    expect(gitlab.requests).toHaveLength(1);
  });

  it.each<[string, () => Response]>([
    ["redirect", () => new Response(null, { status: 302, headers: { location: "https://login.example.com" } })],
    ["login page", () => new Response("login", { headers: { "Content-Type": "text/html" } })],
    ["missing body", () => new Response(null, { headers: HEADERS })],
    ["permission denied", () => new Response(null, { status: 403 })],
  ])("fails closed on an upstream %s", async (label, response) => {
    const { gitlab, props, name } = await setup(`bootstrap-upstream-${label}`);
    gitlab.on("POST", ENDPOINT, response);
    expect(await hooks().gitPull(name, props, [COMMIT], OPTIONS)).toHaveProperty("error");
    expect(gitlab.requests).toHaveLength(1);
  });
});
