import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  sendFetch, snapshotAuthorizer, type FetchAuthorization, type FetchPolicy,
} from "../src/fetch-loopback.js";
import type { GatekeeperCaller } from "../src/storage-schema/overseer-storage.js";

const ALLOW: FetchAuthorization = { allowed: true, restricted: false, approved: false };

describe("FetchLoopback's sendFetch", () => {
  let sent: Request[];
  let routes: Record<string, () => Response>;

  beforeEach(() => {
    sent = [];
    routes = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const request = new Request(input, init);
      sent.push(request);
      const route = routes[request.url];
      if (!route) throw new Error(`unexpected fetch of ${request.url}`);
      return route();
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Sends `request` with `decision` as the workspace's answer, recording the URLs it was asked
  // about. It is agent-driven unless `agentDriven` says otherwise.
  async function send(request: Request, decision: FetchAuthorization = ALLOW, agentDriven = true) {
    const asked: string[] = [];
    const response = await sendFetch(request, async href => {
      asked.push(href);
      return decision;
    }, { agentDriven });
    return { response, asked };
  }

  // Sends `request` decided by `snapshot` for `caller`, with `decision` as the workspace's answer
  // to any URL the snapshot refers to it. A gatekeeper's fetcher, it is not agent-driven.
  async function sendBySnapshot(request: Request, snapshot: FetchPolicy, caller: GatekeeperCaller,
                                decision: FetchAuthorization = ALLOW) {
    const asked: string[] = [];
    const response = await sendFetch(request, snapshotAuthorizer(snapshot, caller, async href => {
      asked.push(href);
      return decision;
    }), { agentDriven: false });
    return { response, asked };
  }

  async function expectRefusal(response: Response, status: number, reason: string, message: RegExp) {
    expect(response.status).toBe(status);
    expect(response.headers.get("cloudflare-os-fetch-refused")).toBe(reason);
    expect(await response.text()).toMatch(message);
  }

  it("refuses any method but GET and HEAD without asking the workspace", async () => {
    for (const method of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const { response, asked } = await send(new Request("https://example.com/", { method }));
      await expectRefusal(response, 405, "denied", /Only GET and HEAD/);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(asked).toEqual([]);
    }
    expect(sent).toEqual([]);
  });

  it("refuses http: and embedded credentials without asking the workspace", async () => {
    for (const [url, message] of [
      ["http://example.com/", /Only https/],
      ["https://user:pass@example.com/", /credentials/],
    ] as const) {
      const { response, asked } = await send(new Request(url));
      await expectRefusal(response, 403, "denied", message);
      expect(asked).toEqual([]);
    }
    expect(sent).toEqual([]);
  });

  it("relays the workspace's refusal, marked as asking for approval where it did", async () => {
    let { response } = await send(new Request("https://example.com/"),
        { allowed: false, message: "Not that host." });
    await expectRefusal(response, 403, "denied", /^Not that host\.$/);

    ({ response } = await send(new Request("https://example.com/"),
        { allowed: false, message: "Ask first.", approvalRequested: true }));
    await expectRefusal(response, 403, "approval-requested", /^Ask first\.$/);
    expect(sent).toEqual([]);
  });

  it("sends HEAD, and forwards only the allowlisted headers with its own user-agent", async () => {
    routes["https://example.com/page"] = () => new Response(null, { status: 200 });
    const { response, asked } = await send(new Request("https://example.com/page", {
      method: "HEAD",
      headers: {
        "accept": "text/html", "accept-language": "en", "range": "bytes=0-9", "if-range": "\"e\"",
        "if-none-match": "\"e\"", "if-modified-since": "Tue, 01 Sep 2026 00:00:00 GMT",
        "authorization": "Bearer secret", "cookie": "a=b", "upgrade": "websocket",
        "user-agent": "custom", "x-custom": "data",
      },
    }));

    expect(response.status).toBe(200);
    expect(asked).toEqual(["https://example.com/page"]);
    expect(sent).toHaveLength(1);
    expect(sent[0].method).toBe("HEAD");
    expect(Object.fromEntries(sent[0].headers)).toEqual({
      "accept": "text/html", "accept-language": "en", "range": "bytes=0-9", "if-range": "\"e\"",
      "if-none-match": "\"e\"", "if-modified-since": "Tue, 01 Sep 2026 00:00:00 GMT",
      "user-agent": "Cloudflare-OS/1.0",
    });
  });

  it("forwards none of the caller's headers in a restricted workspace", async () => {
    routes["https://docs.example.com/"] = () => new Response("ok");
    for (const approved of [false, true]) {
      sent = [];
      await send(new Request("https://docs.example.com/", {
        headers: { "accept": "application/secret", "accept-language": "secret", "range": "bytes=0-1" },
      }), { allowed: true, restricted: true, approved });
      expect(Object.fromEntries(sent[0].headers)).toEqual({
        "accept": expect.stringMatching(/^text\/markdown,/),
        "user-agent": "Cloudflare-OS/1.0",
      });
    }
  });

  it("returns a redirect to the caller rather than following it", async () => {
    routes["https://example.com/old"] = () =>
      new Response(null, { status: 302, headers: { location: "https://other.example/new" } });
    const { response } = await send(new Request("https://example.com/old"));

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://other.example/new");
    expect(response.headers.has("cloudflare-os-fetch-url")).toBe(false);
    expect(sent.map(request => request.url)).toEqual(["https://example.com/old"]);
  });

  it("follows an approved URL's redirects itself and names the final URL", async () => {
    routes["https://example.com/approved"] = () =>
      new Response(null, { status: 301, headers: { location: "https://other.example/moved" } });
    routes["https://other.example/moved"] = () =>
      new Response(null, { status: 302, headers: { location: "/final" } });
    routes["https://other.example/final"] = () => new Response("the page");
    const { response, asked } = await send(new Request("https://example.com/approved"),
        { allowed: true, restricted: true, approved: true });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("the page");
    expect(response.headers.get("cloudflare-os-fetch-url")).toBe("https://other.example/final");
    expect(asked).toEqual(["https://example.com/approved"]);
    expect(sent.map(request => request.url)).toEqual([
      "https://example.com/approved", "https://other.example/moved", "https://other.example/final",
    ]);
  });

  it("refuses an approved URL's redirect to http:", async () => {
    routes["https://example.com/approved"] = () =>
      new Response(null, { status: 302, headers: { location: "http://other.example/" } });
    const { response } = await send(new Request("https://example.com/approved"),
        { allowed: true, restricted: true, approved: true });
    await expectRefusal(response, 403, "denied", /redirected to http:\/\/other\.example\/, which is not allowed/);
  });

  it("strips Cloudflare-OS-Fetch-* headers from the origin's response", async () => {
    routes["https://example.com/"] = () => new Response("page", { headers: {
      "content-type": "text/plain",
      "Cloudflare-OS-Fetch-Refused": "approval-requested",
      "Cloudflare-OS-Fetch-Url": "https://evil.test/",
      "Cloudflare-OS-Fetch-Anything": "x",
    } });
    const { response } = await send(new Request("https://example.com/"));

    expect(response.status).toBe(200);
    expect(Object.fromEntries(response.headers)).toEqual({ "content-type": "text/plain" });
    expect(await response.text()).toBe("page");
  });

  it("refuses an agent-driven request's response that sets Content-Signal: ai-input=no", async () => {
    routes["https://example.com/"] = () =>
      new Response("page", { headers: { "content-signal": "search=yes, AI-Input = no" } });
    const { response } = await send(new Request("https://example.com/"));
    await expectRefusal(response, 403, "denied",
        /^The site at https:\/\/example\.com\/ sets Content-Signal: ai-input=no/);

    const notAgentDriven = await send(new Request("https://example.com/"), ALLOW, false);
    expect(notAgentDriven.response.status).toBe(200);
    expect(await notAgentDriven.response.text()).toBe("page");

    routes["https://example.com/"] = () =>
      new Response("page", { headers: { "content-signal": "ai-train=no, ai-input=yes" } });
    expect((await send(new Request("https://example.com/"))).response.status).toBe(200);
  });

  it("returns a redirect that sets Content-Signal: ai-input=no, judging only its destination", async () => {
    routes["https://example.com/old"] = () => new Response(null, {
      status: 302, headers: { "location": "https://other.example/new", "content-signal": "ai-input=no" },
    });
    expect((await send(new Request("https://example.com/old"))).response.status).toBe(302);

    routes["https://example.com/approved"] = routes["https://example.com/old"];
    routes["https://other.example/new"] = () => new Response("the page");
    const { response } = await send(new Request("https://example.com/approved"),
        { allowed: true, restricted: false, approved: true });
    expect(await response.text()).toBe("the page");
  });

  describe("with a snapshot", () => {
    const GATEKEEPER_USER: GatekeeperCaller = { from: "user" };
    const AGENT: GatekeeperCaller = { from: "agent", chatId: 1 };
    const RESTRICTED: FetchPolicy = { allowedHosts: ["docs.example.com"], approvals: true };

    it("allows what it permits without asking the workspace", async () => {
      routes["https://example.com/?q=1"] = () => new Response("open");
      routes["https://docs.example.com/page"] = () => new Response("trusted");
      for (const [url, snapshot] of [
        ["https://example.com/?q=1", { approvals: false }],
        ["https://docs.example.com/page", RESTRICTED],
      ] as const) {
        const { response, asked } = await sendBySnapshot(new Request(url), snapshot, AGENT);
        expect(response.status).toBe(200);
        expect(asked).toEqual([]);
      }
      expect(sent.map(request => request.url))
          .toEqual(["https://example.com/?q=1", "https://docs.example.com/page"]);
    });

    it("forwards none of the caller's headers once restricted", async () => {
      routes["https://docs.example.com/"] = () => new Response("ok");
      await sendBySnapshot(new Request("https://docs.example.com/", {
        headers: { "accept": "application/secret", "accept-language": "secret" },
      }), RESTRICTED, GATEKEEPER_USER);
      expect(Object.fromEntries(sent[0].headers)).toEqual({
        "accept": expect.stringMatching(/^text\/markdown,/),
        "user-agent": "Cloudflare-OS/1.0",
      });
    });

    it("refuses what it does not permit without asking the workspace", async () => {
      for (const [snapshot, caller, message] of [
        [RESTRICTED, GATEKEEPER_USER, /may only fetch from docs\.example\.com/],
        [{ ...RESTRICTED, approvals: false }, AGENT, /may only fetch from docs\.example\.com/],
        [{ allowedHosts: [], approvals: false }, AGENT, /prohibited from fetching/],
      ] as const) {
        const { response, asked } =
            await sendBySnapshot(new Request("https://other.example/"), snapshot, caller);
        await expectRefusal(response, 403, "denied", message);
        expect(asked).toEqual([]);
      }
      const { response } = await sendBySnapshot(
          new Request("https://docs.example.com/?q=secret"), RESTRICTED, GATEKEEPER_USER);
      await expectRefusal(response, 403, "denied", /query string/);
      expect(sent).toEqual([]);
    });

    it("asks the workspace about what it refuses where an agent may ask the user", async () => {
      let { response, asked } = await sendBySnapshot(new Request("https://other.example/"),
          RESTRICTED, AGENT, { allowed: false, message: "Ask first.", approvalRequested: true });
      await expectRefusal(response, 403, "approval-requested", /^Ask first\.$/);
      expect(asked).toEqual(["https://other.example/"]);

      routes["https://other.example/"] = () => new Response("approved");
      ({ response, asked } = await sendBySnapshot(new Request("https://other.example/"),
          RESTRICTED, AGENT, { allowed: true, restricted: true, approved: true }));
      expect(await response.text()).toBe("approved");
      expect(asked).toEqual(["https://other.example/"]);
    });
  });
});
