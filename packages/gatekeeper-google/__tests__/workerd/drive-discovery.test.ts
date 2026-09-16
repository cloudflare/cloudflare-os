import { env } from "cloudflare:workers";
import { runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UserAccount } from "../../src/google";
import {
  BIGQUERY_RESOURCE,
  GOOGLE_DOC_RESOURCE,
  IDENTITY_SCOPES,
} from "../../src/resources";

type TestUserAccount = UserAccount & {
  setTestCallback(
    id: string,
    initiationNonce: string,
    requestedResources: string[],
    mode: "connect" | "auth" | "reconnect",
  ): Promise<void>;
  readTestConnectNotifications(id: string): string[];
};

type TestEnv = {
  UserAccount: DurableObjectNamespace<TestUserAccount>;
};

const testEnv = env as unknown as TestEnv;
const REDIRECT_URI = "http://localhost:8787/gatekeeper/google/oauth";

function runAccount<T>(
    account: DurableObjectStub<TestUserAccount>,
    callback: (instance: TestUserAccount, state: DurableObjectState) => T | Promise<T>,
): Promise<T> {
  return runInDurableObject(account, callback);
}

async function initializedAccount(scopes: string[], resources: string[]) {
  const name = `drive-discovery-${crypto.randomUUID()}`;
  const account = testEnv.UserAccount.getByName(name);
  await runAccount(account, async (instance, state) => {
    state.storage.kv.put("refreshToken", "old-refresh-token");
    state.storage.kv.put("accessToken", {
      token: "old-access-token",
      expires: new Date(Date.now() + 3600_000),
    });
    state.storage.kv.put("grantedScopes", scopes);
    state.storage.kv.put("grantedResources", resources);
    await instance.setTestCallback(name, "initial", resources, "reconnect");
  });
  return { account, name };
}

async function beginDiscovery(account: DurableObjectStub<TestUserAccount>): Promise<string> {
  const prepared = await runAccount(account, instance => instance.requestSharedDriveDiscovery());
  if (!prepared.url) throw new Error("Expected a discovery authorization URL.");
  const response = await SELF.fetch(prepared.url, { redirect: "manual" });
  expect(response.status).toBe(302);
  const location = response.headers.get("location");
  if (!location) throw new Error("Expected a Google authorization redirect.");
  const authorizationUrl = new URL(location);
  expect(authorizationUrl.searchParams.get("scope")?.split(" "))
    .toContain("https://www.googleapis.com/auth/drive.readonly");
  const state = authorizationUrl.searchParams.get("state");
  if (!state) throw new Error("Expected an OAuth state.");
  return state;
}

async function finishDiscovery(state: string, query: string): Promise<Response> {
  return SELF.fetch(`http://localhost/gatekeeper/google/oauth?${query}&state=${encodeURIComponent(state)}`);
}

afterEach(() => vi.unstubAllGlobals());

describe("shared-drive discovery authorization", () => {
  it.each([
    "https://www.googleapis.com/auth/drive.readonly",
    "https://www.googleapis.com/auth/drive",
  ])("preserves discovery during a normal reconnect from %s", async coveringScope => {
    const { account } = await initializedAccount(
      [...IDENTITY_SCOPES, coveringScope],
      [GOOGLE_DOC_RESOURCE.urlPattern],
    );

    const begun = await runAccount(account, async instance => {
      await instance.prepareReconnect("reconnect", [GOOGLE_DOC_RESOURCE.urlPattern]);
      return instance.beginOAuthFlow("reconnect", REDIRECT_URI);
    });

    expect(begun?.scopes).toContain("https://www.googleapis.com/auth/drive.readonly");
    expect(begun?.scopes).not.toContain("https://www.googleapis.com/auth/drive");
  });

  it("leaves credentials and resource intent unchanged when consent is denied", async () => {
    const scopes = [...IDENTITY_SCOPES, "https://www.googleapis.com/auth/documents"];
    const resources = [GOOGLE_DOC_RESOURCE.urlPattern];
    const { account, name } = await initializedAccount(scopes, resources);
    const state = await beginDiscovery(account);

    const response = await finishDiscovery(state, "error=access_denied");

    expect(response.status).toBe(400);
    await expect(runAccount(account, instance => instance.readTestConnectNotifications(name)))
      .resolves.toEqual([]);
    await expect(runAccount(account, (_instance, durableState) => ({
      refreshToken: durableState.storage.kv.get("refreshToken"),
      scopes: durableState.storage.kv.get("grantedScopes"),
      resources: durableState.storage.kv.get("grantedResources"),
    }))).resolves.toEqual({
      refreshToken: "old-refresh-token",
      scopes,
      resources,
    });
  });

  it.each([
    { granted: true, optionalScopes: ["https://www.googleapis.com/auth/drive.readonly"] },
    { granted: false, optionalScopes: [] },
  ])("records actual returned scopes when optional discovery is $granted", async ({
    granted,
    optionalScopes,
  }) => {
    const resources = [GOOGLE_DOC_RESOURCE.urlPattern, BIGQUERY_RESOURCE.urlPattern];
    const { account, name } = await initializedAccount(IDENTITY_SCOPES, resources);
    const state = await beginDiscovery(account);
    const returnedScopes = [
      ...IDENTITY_SCOPES,
      "https://www.googleapis.com/auth/documents",
      "https://www.googleapis.com/auth/drive.metadata.readonly",
      "https://www.googleapis.com/auth/bigquery",
      ...optionalScopes,
    ];
    const exchange = vi.fn(async () => Response.json({
      access_token: "new-access-token",
      refresh_token: "new-refresh-token",
      expires_in: 3600,
      scope: returnedScopes.join(" "),
    }));
    vi.stubGlobal("fetch", exchange);

    const response = await finishDiscovery(state, "code=authorization-code");

    expect(response.status).toBe(200);
    const notifications = await runAccount(account,
      instance => instance.readTestConnectNotifications(name));
    expect(notifications).toEqual([expect.stringMatching(/^reconnect:/)]);

    // The reconnect URL is a bearer capability, so the widened grant waits for the Workshop to
    // confirm the finishing browser is the owner's.
    await expect(runAccount(account, instance => instance.hasSharedDriveDiscovery()))
      .resolves.toBe(false);

    const stageId = notifications[0].slice("reconnect:".length);
    await runAccount(account, instance => instance.commitReconnect(stageId));

    await expect(runAccount(account, instance => instance.hasSharedDriveDiscovery()))
      .resolves.toBe(granted);
    await expect(runAccount(account, (_instance, durableState) => ({
      refreshToken: durableState.storage.kv.get("refreshToken"),
      scopes: durableState.storage.kv.get("grantedScopes"),
      resources: durableState.storage.kv.get("grantedResources"),
    }))).resolves.toEqual({
      refreshToken: "new-refresh-token",
      scopes: returnedScopes,
      resources,
    });

    const replay = await finishDiscovery(state, "code=replayed-code");
    expect(replay.status).toBe(200);
    expect(exchange).toHaveBeenCalledOnce();
    await expect(runAccount(account, instance => instance.readTestConnectNotifications(name)))
      .resolves.toEqual(notifications);
  });
});
