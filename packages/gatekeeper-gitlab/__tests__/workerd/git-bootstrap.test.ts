import { DELIM_PKT, FLUSH_PKT, encodePktLine } from "@gadgets/gatekeeper-kit/git-transport";
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

function request(lines = [`want ${COMMIT}`, "deepen 1", "done"]): Uint8Array {
  const parts = [encodePktLine("command=fetch"), encodePktLine("agent=git/2.39.5"), DELIM_PKT,
    ...lines.map(encodePktLine), FLUSH_PKT];
  const body = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) { body.set(part, offset); offset += part.length; }
  return body;
}

async function setup(name: string, resourceKind: GatekeeperProps["resourceKind"] = "project") {
  const gitlab = new FakeGitLab().on("POST", ENDPOINT, () => new Response(PACK, { headers: HEADERS }));
  gitlab.install();
  const props = { ...projectProps(await seedAccount(), PROJECT), resourceKind };
  return { gitlab, props, name };
}

describe("native GitLab bootstrap", () => {
  it.each(["project", "issue", "mergeRequest"] as const)("streams through the %s binding's own project", async kind => {
    const { gitlab, props, name } = await setup(`bootstrap-${kind}`, kind);
    const body = request();
    const stream = await unwrap(await hooks().gitReadPack(name, props, COMMIT, body));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(PACK);
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

  it.each<[string, Uint8Array]>([
    ["different commit", request([`want ${"b".repeat(40)}`, "deepen 1", "done"])],
    ["second want", request([`want ${COMMIT}`, `want ${"b".repeat(40)}`, "deepen 1", "done"])],
    ["unbounded history", request([`want ${COMMIT}`, "done"])],
    ["ref discovery", encodePktLine("command=ls-refs")],
    ["malformed framing", new Uint8Array([255, 0, 128])],
    ["oversized request", new Uint8Array(65537)],
  ])("rejects %s before contacting GitLab", async (label, body) => {
    const { gitlab, props, name } = await setup(`bootstrap-invalid-${label}`);
    const outcome = await hooks().gitReadPack(name, props, COMMIT, body);
    expect(outcome).toHaveProperty("error");
    expect(gitlab.requests).toHaveLength(0);
  });

  it("returns an unfinished binary stream without collecting the entire pack", async () => {
    const { gitlab, props, name } = await setup("bootstrap-streaming");
    gitlab.on("POST", ENDPOINT, () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(PACK); },
      // Never finish the upstream response. A buffering implementation cannot return its first
      // chunk; cancellation must close it without touching a controller from another DO.
      pull() { return new Promise<void>(() => {}); },
    }), { headers: HEADERS }));
    const stream = await unwrap(await hooks().gitReadPack(name, props, COMMIT, request()));
    const reader = stream.getReader();
    try {
      expect(await reader.read()).toEqual({ done: false, value: PACK });
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  });

  it("uses refreshed credentials rather than exporting them to the caller", async () => {
    const gitlab = new FakeGitLab()
      .on("POST", /^\/oauth\/token$/, () => json(tokenResponse(1)))
      .on("POST", ENDPOINT, () => new Response(PACK, { headers: HEADERS }));
    gitlab.install();
    const props = projectProps(await seedAccount({ expiresInMs: -1 }), PROJECT);
    const stream = await unwrap(await hooks().gitReadPack("bootstrap-refresh", props, COMMIT, request()));
    expect(new Uint8Array(await new Response(stream).arrayBuffer())).toEqual(PACK);
    expect(gitlab.count("POST", /^\/oauth\/token$/)).toBe(1);
    const upstream = gitlab.requests.find(call => ENDPOINT.test(call.url.pathname))!;
    expect(upstream.headers.get("authorization")).toBe(`Basic ${btoa("oauth2:access-1")}`);
  });

  it("rechecks account credentials after a prior successful bootstrap", async () => {
    const { gitlab, props, name } = await setup("bootstrap-revoked");
    const stream = await unwrap(await hooks().gitReadPack(name, props, COMMIT, request()));
    await new Response(stream).arrayBuffer();
    await runInDurableObject(env.USER_ACCOUNT.get(env.USER_ACCOUNT.idFromString(props.userObjectId)),
      async (_instance, state) => { await state.storage.deleteAll(); });
    expect(await hooks().gitReadPack(name, props, COMMIT, request())).toHaveProperty("error");
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
    expect(await hooks().gitReadPack(name, props, COMMIT, request())).toHaveProperty("error");
    expect(gitlab.requests).toHaveLength(1);
  });
});
