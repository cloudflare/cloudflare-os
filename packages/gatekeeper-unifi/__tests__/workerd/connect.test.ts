// The connect and reconnect flows, end to end through the Worker's HTTP handler and the account:
// the page, the checks before anything reaches UniFi, proving the key, the single-use link, the
// Workshop handoff, and staged reconnects that can't repoint an account at someone else's consoles.

import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  account, CLOUD_KEY, CONSOLE_URL, connectCloud, connectDirect, hooks, installFake, LOCAL_KEY, postForm,
  request, startConnect, unwrap,
} from "./helpers.js";
import { HOME, homeConsole } from "../fake-unifi.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the connect page", () => {
  it("shows both forms for a live link, served so its POST carries an Origin", async () => {
    installFake();
    const { path } = await startConnect();
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("Referrer-Policy")).toBe("same-origin");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const html = await response.text();
    expect(html).toContain('name="cloudApiKey"');
    expect(html).toContain('name="consoleUrl"');
    expect(html).toContain(`action="/gatekeeper/unifi${path}"`);
  });

  it("refuses a wrong nonce, a malformed link, and other methods", async () => {
    installFake();
    const { accountId } = await startConnect();
    expect((await request(`/${accountId}/${"f".repeat(64)}`)).status).toBe(400);
    expect((await request("/not-a-link")).status).toBe(404);
    expect((await request(`/${"0".repeat(64)}/${"0".repeat(64)}`)).status).toBe(400);
    const { path } = await startConnect();
    expect((await request(path, { method: "PUT" })).status).toBe(405);
  });
});

describe("submitting the form", () => {
  it("refuses a cross-site or scripted post before reading it", async () => {
    const { unifi } = installFake();
    const { path } = await startConnect();
    expect((await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY }, { Origin: "https://evil.example" })).status).toBe(403);
    expect((await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY }, { Origin: "null" })).status).toBe(403);
    expect((await request(path, { method: "POST", headers: { Origin: "https://gadgets.example", "Content-Type": "application/json" }, body: "{}" })).status).toBe(415);
    const huge = "x".repeat(20 * 1024);
    expect((await postForm(path, { mode: "cloud", cloudApiKey: huge })).status).toBe(413);
    expect(unifi.calls).toHaveLength(0);
    // The link still works after all that.
    expect((await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY })).status).toBe(200);
  });

  it("connects a cloud key: proves it, records who it is, and hands off to the Workshop", async () => {
    const { unifi } = installFake();
    const { accountId, path } = await startConnect();
    const response = await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('"https://gadgets.example"');
    expect(html).toContain('"ticket-1"');
    expect(unifi.calls.map(c => new URL(c.url).pathname)).toEqual(["/v1/hosts"]);

    // The Workshop described the account while completing, from what was stored.
    const log = await hooks().callbackLog(accountId);
    expect(log.completed).toBe(1);
    expect(log.describedAs[0]).toMatchObject({ displayName: "Dan Carter", uniqueName: "dan@example.com" });
    expect(await account(accountId).identity()).toEqual({
      mode: "cloud", email: "dan@example.com", fullName: "Dan Carter", consoleIds: [HOME.hostId],
    });

    // The link is single-use.
    expect((await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY })).status).toBe(400);
    expect(log.completed).toBe(1);
  });

  it("lets the user retry after a key UniFi rejects, without consuming the link", async () => {
    installFake();
    const { accountId, path } = await startConnect();
    const refused = await postForm(path, { mode: "cloud", cloudApiKey: "not-the-right-key-0123456789" });
    expect(refused.status).toBe(400);
    const html = await refused.text();
    expect(html).toContain("UniFi didn&#39;t accept that API key");
    expect(html).not.toContain("not-the-right-key");
    expect(await account(accountId).identity()).toBeNull();

    expect((await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY })).status).toBe(200);
  });

  it("completes only once when two submissions race", async () => {
    const { unifi } = installFake();
    const { accountId, path } = await startConnect();
    // Hold the first submission's check open until the second has been answered.
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const original = unifi.fetch;
    let first = true;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (first) { first = false; await held; }
      return original(input, init);
    });
    const slow = postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY });
    await new Promise(resolve => setTimeout(resolve, 10));
    const fast = await postForm(path, { mode: "cloud", cloudApiKey: CLOUD_KEY });
    expect(fast.status).toBe(400);
    release();
    expect((await slow).status).toBe(200);
    expect((await hooks().callbackLog(accountId)).completed).toBe(1);
  });

  it("connects directly to a console, learning its name and MACs, through Cloudflare Access", async () => {
    const { unifi } = installFake();
    unifi.direct.get(CONSOLE_URL)!.access = { clientId: "id.access", clientSecret: "access-secret" };
    const accountId = await connectDirect({ accessClientId: "id.access", accessClientSecret: "access-secret" });
    const identity = await account(accountId).identity();
    expect(identity).toMatchObject({
      mode: "direct", consoleName: "Dream Machine Pro", macs: ["70:a7:41:97:83:ed"], apps: { network: true, protect: true },
    });
    expect(identity?.mode === "direct" && identity.consoleId).toMatch(/^local-[0-9a-f]{16}$/);
    expect(await account(accountId).summary()).toEqual({
      mode: "direct", displayName: "Dream Machine Pro", uniqueName: "Dream Machine Pro at unifi.home.example",
    });
  });

  it.each([
    ["an untrusted certificate", { untrustedCertificate: true }, /TLS certificate isn&#39;t trusted/],
    ["an unreachable console", { unreachable: true }, /Couldn&#39;t reach the console/],
    ["a key the console rejects", { wrongKey: true }, /The console didn&#39;t accept that API key/],
    ["an Access login in the way", { access: true }, /Cloudflare Access/],
  ])("explains %s", async (_what, problem, message) => {
    const { unifi } = installFake();
    const direct = unifi.direct.get(CONSOLE_URL)!;
    if ("untrustedCertificate" in problem) direct.untrustedCertificate = true;
    if ("access" in problem) direct.access = { clientId: "id", clientSecret: "secret" };
    const { path } = await startConnect();
    const response = await postForm(path, {
      mode: "direct", consoleUrl: "unreachable" in problem ? "https://elsewhere.example" : CONSOLE_URL,
      localApiKey: "wrongKey" in problem ? "some-other-key-0123456789" : LOCAL_KEY,
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toMatch(message);
  });

  it("deletes an account whose flow was never finished", async () => {
    installFake();
    const { accountId } = await startConnect();
    const stub = account(accountId);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await stub.connectPage("0".repeat(64))).toBeNull();
  });
});

describe("reconnecting", () => {
  it("stages a new key from the same account until the Workshop commits it", async () => {
    const { unifi } = installFake();
    const accountId = await connectCloud();
    const newKey = "rotated-cloud-key-0123456789abcd";
    unifi.cloud.set(newKey, unifi.cloud.get(CLOUD_KEY)!);

    const { url } = unwrap(await hooks().user(accountId, "reconnect")) as { url: string };
    const path = new URL(url).pathname.replace("/gatekeeper/unifi", "");
    const page = await (await request(path)).text();
    expect(page).toContain("Reconnect UniFi");
    expect(page).not.toContain('name="consoleUrl"');

    const response = await postForm(path, { mode: "cloud", cloudApiKey: newKey });
    expect(response.status).toBe(200);
    const [stageId] = (await hooks().callbackLog(accountId)).stages;
    expect(stageId).toMatch(/^[0-9a-f]{64}$/);

    // Still the old key until committed.
    unifi.calls.length = 0;
    await account(accountId).request({ target: { kind: "app", app: "network", consoleId: HOME.hostId }, method: "GET", path: "/v1/info" });
    expect(unifi.calls.at(-1)!.headers["x-api-key"]).toBe(CLOUD_KEY);

    await account(accountId).commitReconnect(stageId!);
    await account(accountId).request({ target: { kind: "app", app: "network", consoleId: HOME.hostId }, method: "GET", path: "/v1/info" });
    expect(unifi.calls.at(-1)!.headers["x-api-key"]).toBe(newKey);
    expect(await hooks().accountCall(accountId, "commitReconnect", [stageId!]))
      .toEqual({ error: "No reconnect is awaiting confirmation. Please try again." });
  });

  it("refuses a key that belongs to a different UniFi account", async () => {
    const { unifi } = installFake();
    const accountId = await connectCloud();
    const stranger = homeConsole();
    stranger.hostId = "AABBCCDDEEFF00000000000000000000000000000000000000000000000000AA:9";
    unifi.addCloudKey("someone-elses-key-0123456789abcd", { email: "eve@example.com", fullName: "Eve", owned: [stranger] });
    const { url } = unwrap(await hooks().user(accountId, "reconnect")) as { url: string };
    const response = await postForm(new URL(url).pathname.replace("/gatekeeper/unifi", ""),
      { mode: "cloud", cloudApiKey: "someone-elses-key-0123456789abcd" });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("belongs to a different UniFi account");
    expect((await hooks().callbackLog(accountId)).stages).toEqual([]);
  });

  it("keeps a direct connection's URL, and refuses a different console behind it", async () => {
    const { unifi } = installFake();
    const accountId = await connectDirect();
    const before = await account(accountId).identity();
    const { url } = unwrap(await hooks().user(accountId, "reconnect")) as { url: string };
    const path = new URL(url).pathname.replace("/gatekeeper/unifi", "");

    // The posted URL is ignored: the stored one is kept.
    const replaced = homeConsole();
    replaced.mac = "001122334455";
    replaced.protect!.nvr.mac = "001122334455";
    replaced.network!.sites[0]!.devices[0]!.overview.macAddress = "00:11:22:33:44:55";
    unifi.addDirectConsole(CONSOLE_URL, replaced, "new-local-key-0123456789abcdef");
    const refused = await postForm(path, { mode: "direct", consoleUrl: "https://evil.example", localApiKey: "new-local-key-0123456789abcdef" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("reaches a different console");
    expect(unifi.calls.some(c => c.url.startsWith("https://evil.example"))).toBe(false);

    unifi.addDirectConsole(CONSOLE_URL, homeConsole(), "new-local-key-0123456789abcdef");
    expect((await postForm(path, { mode: "direct", localApiKey: "new-local-key-0123456789abcdef" })).status).toBe(200);
    const [stageId] = (await hooks().callbackLog(accountId)).stages;
    await account(accountId).commitReconnect(stageId!);
    // Same console ID, so existing bindings keep working.
    expect(await account(accountId).identity()).toEqual(before);
  });
});

describe("credential expiry", () => {
  it("tells the Workshop once when UniFi starts rejecting the key", async () => {
    const { unifi } = installFake();
    const accountId = await connectCloud();
    unifi.cloud.delete(CLOUD_KEY);
    const target = { kind: "app" as const, app: "network" as const, consoleId: HOME.hostId };
    expect(await account(accountId).request({ target, method: "GET", path: "/v1/info" }))
      .toMatchObject({ ok: false, failure: { kind: "auth" } });
    await account(accountId).request({ target, method: "GET", path: "/v1/sites" });
    expect((await hooks().callbackLog(accountId)).expired).toBe(1);
    expect(env).toBeDefined();
  });
});
