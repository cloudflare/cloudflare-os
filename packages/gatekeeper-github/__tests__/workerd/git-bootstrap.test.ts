import { DELIM_PKT, FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
import { env, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GatekeeperProps } from "./worker";

afterEach(() => vi.unstubAllGlobals());

const COMMIT = "a".repeat(40);
const PACK = new Uint8Array([0, 128, 255, 80, 65, 67, 75]);

function request(commit = COMMIT): Uint8Array {
  const parts = [encodePktLine("command=fetch"), DELIM_PKT, encodePktLine(`want ${commit}`),
    encodePktLine("deepen 1"), encodePktLine("done"), FLUSH_PKT];
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

async function propsFor(resourceKind: GatekeeperProps["resourceKind"]): Promise<GatekeeperProps> {
  const id = env.USER_ACCOUNT.newUniqueId();
  await runInDurableObject(env.USER_ACCOUNT.get(id), async (_instance, state) => {
    state.storage.kv.put("accessToken", "test-token");
  });
  return { userObjectId: id.toString(), resourceKind, owner: "acme", repo: "widgets", issueNumber: 1 };
}

describe("shared native GitHub bootstrap validation", () => {
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
      return new Response(PACK, { headers: { "Content-Type": "application/x-git-upload-pack-result" } });
    });
    const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
    const outcome = await hooks.gitReadPack(`bootstrap-${kind}`, props, COMMIT, body);
    if ("error" in outcome) throw new Error(outcome.error);
    expect(new Uint8Array(await new Response(outcome.ok).arrayBuffer())).toEqual(PACK);
    expect(calls).toHaveLength(2);
  });

  it("rejects another commit before contacting any upstream endpoint", async () => {
    const props = await propsFor("repo");
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const hooks = env.TEST_HOOKS.get(env.TEST_HOOKS.idFromName("hooks"));
    expect(await hooks.gitReadPack("bootstrap-invalid", props, COMMIT, request("b".repeat(40))))
      .toHaveProperty("error");
    expect(fetch).not.toHaveBeenCalled();
  });
});
