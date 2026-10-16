import { buildGitFetchRequest, FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import type { RpcStub } from "cloudflare:workers";
import type { GitPullTransfer } from "@gadgets/workshop-shared/gatekeeper";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps } from "./worker";

afterEach(() => vi.unstubAllGlobals());

const COMMIT = "a".repeat(40);
const PACK = new Uint8Array([0, 128, 255, 80, 65, 67, 75]);

const OPTIONS = {type: "commit", commitHistory: {kind: "depth", depth: 1}} as const;
const request = () => buildGitFetchRequest([COMMIT], OPTIONS);
const sideband = (band: number, payload: Uint8Array) => new Uint8Array([
  ...new TextEncoder().encode((payload.length + 5).toString(16).padStart(4, "0")), band, ...payload,
]);
const response = () => new Blob([
  encodePktLine("packfile"), sideband(1, PACK), FLUSH_PKT,
]);

async function propsFor(resourceKind: GatekeeperProps["resourceKind"]): Promise<GatekeeperProps> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  return { userObjectId: id.toString(), resourceKind, owner: "acme", repo: "widgets", issueNumber: 1 };
}

describe("unified GitHub pack stream", () => {
  it.each(["repo", "issue", "pull"] as const)("preserves streaming through a %s binding", async kind => {
    const props = await propsFor(kind);
    const body = request();
    const calls: Request[] = [];
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
      const upstream = new Request(input, init);
      calls.push(upstream);
      if (upstream.url === "https://api.github.com/repos/acme/widgets") return Response.json({ id: 1 });
      expect(upstream.url).toBe("https://github.com/acme/widgets.git/git-upload-pack");
      expect(upstream.method).toBe("POST");
      expect(upstream.headers.get("git-protocol")).toBe("version=2");
      expect(upstream.headers.get("authorization")).toBe(`Basic ${btoa("x-access-token:test-token")}`);
      expect(new Uint8Array(await upstream.arrayBuffer())).toEqual(body);
      return new Response(response(), { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    });
    const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
    const outcome = await hooks.gitPull(`bootstrap-${kind}`, props, [COMMIT], OPTIONS);
    if ("error" in outcome) throw new Error(outcome.error);
    using transfer = outcome.ok as RpcStub<GitPullTransfer>;
    expect(new Uint8Array(await new Response(await transfer.stream()).arrayBuffer())).toEqual(PACK);
    expect(await transfer.status()).toEqual({state: "complete"});
    expect(calls).toHaveLength(2);
  });

  it("rejects an invalid object id without sending an upload-pack request", async () => {
    const props = await propsFor("repo");
    const fetch = vi.fn(async (input: string | URL | Request) => {
      expect(String(input)).not.toContain("git-upload-pack");
      return Response.json({id: 1});
    });
    vi.stubGlobal("fetch", fetch);
    const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
    expect(await hooks.gitPull("bootstrap-invalid", props, ["refs/heads/main"], OPTIONS))
      .toHaveProperty("error");
    expect(fetch.mock.calls.every(([input]) => !String(input).includes("git-upload-pack"))).toBe(true);
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
  ])("retains a $name error across Workers RPC", async ({name, body, message}) => {
    const props = await propsFor("repo");
    vi.stubGlobal("fetch", async (input: string | URL | Request) => {
      if (String(input).includes("git-upload-pack")) {
        return new Response(body());
      }
      return Response.json({id: 1});
    });
    const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
    const outcome = await hooks.gitPull(`bootstrap-error-${name}`, props, [COMMIT], OPTIONS);
    if ("error" in outcome) throw new Error(outcome.error);
    using transfer = outcome.ok as RpcStub<GitPullTransfer>;
    await expect(new Response(await transfer.stream()).arrayBuffer()).rejects.toThrow();
    expect(await transfer.status()).toEqual({state: "failed", message});
  });
});
