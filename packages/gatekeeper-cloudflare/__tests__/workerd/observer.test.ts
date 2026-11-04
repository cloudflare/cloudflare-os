// The collaborator checks: what verifyObserverAccess() answers for the subresources reads report,
// what addObserver() still enforces itself, and how an observer's own account reuses its answers.
// Every verifier here is a real CloudflareVerifier minted for the observer's own connected account,
// as the overseer would hand one over.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { accountObservabilityUrl, workerObservabilityUrl } from "../../src/resources";
import {
  ACCOUNT_ID, ACCOUNT_ONLY_SCOPES, connectAccount, inAccount, reconnect, stubCloudflare,
  type Backend,
} from "./cloudflare-backend";
import { BILLING_SCOPES } from "../../src/oauth";

const API_ID = "a".repeat(32);
const IMPOSTOR_ID = "c".repeat(32);
const ACCOUNT = `account/${ACCOUNT_ID}`;
const API_WORKER = `${ACCOUNT}/worker/${API_ID}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness() {
  const backend: Backend = stubCloudflare();
  backend.workers = [{ id: API_ID, name: "api", versions: ["api-v1"] }];
  const hooks = env.TEST_HOOKS.getByName(`hooks-${crypto.randomUUID()}`);
  // Each token's account is connected once and then reused, as an observer's account is.
  const accounts = new Map<string, Promise<string>>();
  const account = (token: string, scopes?: string[]) => {
    let connected = accounts.get(token);
    if (!connected) {
      connected = connectAccount(token, scopes);
      accounts.set(token, connected);
    }
    return connected;
  };
  return {
    backend,
    hooks,
    account,
    bind: async (url: string, facetName = "binding") =>
      hooks.bind(facetName, await account("owner"), url),
    /** verifyObserverAccess() for observers named by the token their account holds. */
    verify: async (tokens: string[], subresources: string[], facetName = "binding") =>
      (await hooks.verifyObserverAccess(facetName,
        await Promise.all(tokens.map(async token => ({ id: token, userObjectId: await account(token) }))),
        subresources)).allowedObserverIds,
    addObserver: async (token: string, facetName = "binding") =>
      hooks.addObserver(facetName, await account(token)),
    /** What the observer holding `token` asked Cloudflare, as `METHOD path` calls. */
    asked: (token: string) => backend.requests.filter(request => request.token === token).map(request => request.call),
  };
}

describe("verifyObserverAccess", () => {
  it("allows only observers whose own account can read the account's telemetry", async () => {
    const { backend, bind, verify } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    backend.telemetryStatus.denied = 403;

    expect(await verify(["allowed", "denied"], [ACCOUNT])).toEqual(["allowed"]);
  });

  it("checks a Worker by the ID reads recorded, not the Worker that has its name now", async () => {
    const { backend, bind, verify } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.workers[0].name = "api-renamed";
    backend.workers.push({ id: IMPOSTOR_ID, name: "api", versions: ["impostor-v1"] });
    // Sees the Worker now called `api`, but not the one the binding was granted.
    backend.sees.namesake = worker => worker.id === IMPOSTOR_ID;
    backend.sees.bound = worker => worker.id === API_ID;

    expect(await verify(["namesake", "bound"], [API_WORKER])).toEqual(["bound"]);
  });

  it("denies a Worker whose account telemetry the observer can't read, without looking it up", async () => {
    const { backend, bind, verify, asked } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.telemetryStatus.denied = 403;

    expect(await verify(["denied"], [API_WORKER])).toEqual([]);
    expect(asked("denied")).toEqual([`POST workers/observability/telemetry/keys`]);
  });

  it("denies a billing-only connection without asking Cloudflare", async () => {
    const { bind, verify, account, asked } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    await account("billing", BILLING_SCOPES);

    expect(await verify(["billing"], [ACCOUNT])).toEqual([]);
    expect(await verify(["billing"], [API_WORKER])).toEqual([]);
    expect(asked("billing")).toEqual([]);
  });

  it("allows a connection granted only account telemetry the account, but no Worker", async () => {
    // A connection made before Worker bindings needed Worker metadata.
    const { bind, verify, account, asked } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    await account("account-only", ACCOUNT_ONLY_SCOPES);

    // Refused on its scopes alone, before the account's own question is asked.
    expect(await verify(["account-only"], [API_WORKER])).toEqual([]);
    expect(asked("account-only")).toEqual([]);
    expect(await verify(["account-only"], [ACCOUNT])).toEqual(["account-only"]);
    expect(asked("account-only")).toEqual([`POST workers/observability/telemetry/keys`]);
  });

  it("throws rather than denying when Cloudflare fails, and asks again next time", async () => {
    const { backend, bind, verify, asked } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    // Neither a denial nor a status the client retries.
    backend.telemetryStatus.flaky = 500;

    await expect(verify(["flaky"], [ACCOUNT])).rejects.toThrow(/500/);
    delete backend.telemetryStatus.flaky;
    expect(await verify(["flaky"], [ACCOUNT])).toEqual(["flaky"]);
    expect(asked("flaky")).toHaveLength(2);
  });

  it("throws for an observer whose grant can no longer be refreshed", async () => {
    const { bind, verify, account } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    await inAccount(await account("expired"), (_account, state) => {
      state.storage.kv.put("accessToken", { token: "expired", expires: 0 });
    });

    await expect(verify(["expired"], [ACCOUNT])).rejects.toThrow(/no usable credentials/);
  });

  it.each([
    ["an uppercase account ID", `account/${ACCOUNT_ID.toUpperCase()}`],
    ["a namespace", `cloudflare/account/${ACCOUNT_ID}`],
    ["a Worker name for its ID", `${ACCOUNT}/worker/api`],
    ["another kind of resource", `${ACCOUNT}/script/${API_ID}`],
    ["a resource within a Worker", `${API_WORKER}/version/api-v1`],
  ])("denies everyone for an ID with %s", async (_, subresource) => {
    const { bind, verify } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));

    await expect(verify(["allowed"], [ACCOUNT, subresource])).rejects.toThrow(/subresource/);
  });
});

describe("access cache", () => {
  it("reuses an observer's answers across bindings in different workspaces", async () => {
    const first = harness();
    await first.bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    const otherWorkspace = env.TEST_HOOKS.getByName(`hooks-${crypto.randomUUID()}`);
    await otherWorkspace.bind("binding", await connectAccount("other-owner"),
      workerObservabilityUrl(ACCOUNT_ID, "api"));

    expect(await first.verify(["observer"], [API_WORKER])).toEqual(["observer"]);
    const { allowedObserverIds } = await otherWorkspace.verifyObserverAccess("binding",
      [{ id: "observer", userObjectId: await first.account("observer") }], [API_WORKER]);

    expect(allowedObserverIds).toEqual(["observer"]);
    expect(first.asked("observer")).toEqual([
      `POST workers/observability/telemetry/keys`,
      `GET workers/workers/${API_ID}`,
    ]);
  });

  it("asks again about a denial after 15 seconds, and about an allowed answer after 15 minutes", async () => {
    const { backend, bind, verify, asked } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.sees.observer = () => false;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    expect(await verify(["observer"], [API_WORKER])).toEqual([]);

    const askedAt = async (offset: number) => {
      vi.setSystemTime(start + offset);
      const before = asked("observer").length;
      await verify(["observer"], [API_WORKER]);
      return asked("observer").slice(before);
    };
    expect(await askedAt(14_999)).toEqual([]);
    expect(await askedAt(15_000)).toEqual([`GET workers/workers/${API_ID}`]);
    // The account's own answer is still recent; the Worker's denial is not.
    expect(await askedAt(15 * 60_000 - 1)).toEqual([`GET workers/workers/${API_ID}`]);
    // Now the account's has expired, while the Worker's was asked a moment ago.
    expect(await askedAt(15 * 60_000)).toEqual([`POST workers/observability/telemetry/keys`]);
  });

  it("asks again after a reconnect, which may sign in as someone else", async () => {
    const { backend, bind, verify, account } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    backend.telemetryStatus.bob = 403;
    expect(await verify(["alice"], [ACCOUNT])).toEqual(["alice"]);

    await reconnect(await account("alice"), "bob");

    expect(await verify(["alice"], [ACCOUNT])).toEqual([]);
    expect(backend.requests.map(request => request.token)).toEqual(["alice", "bob"]);
  });

  it("refuses to pair two grants' answers when a reconnect lands mid-check", async () => {
    const { backend, bind, verify, account } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    // Alice can read the account's telemetry but not see the Worker; Bob the reverse. Neither can
    // read the Worker's telemetry, so no mix of their answers may admit the observer.
    backend.sees.alice = () => false;
    backend.telemetryStatus.bob = 403;
    const held = Promise.withResolvers<void>();
    backend.hold.alice = held.promise;
    const observer = await account("alice");

    const verifying = verify(["alice"], [API_WORKER]);
    await vi.waitUntil(() => backend.requests.some(request => request.token === "alice"));
    await reconnect(observer, "bob");
    // Released from inside the account, whose request is the one waiting on it.
    await inAccount(observer, () => held.resolve());

    await expect(verifying).rejects.toThrow(/reconnected while its access was being checked/);
  });

  it("keeps each connection's answers to itself", async () => {
    const { backend, bind, verify } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    backend.telemetryStatus.denied = 403;

    expect(await verify(["allowed"], [ACCOUNT])).toEqual(["allowed"]);
    expect(await verify(["denied"], [ACCOUNT])).toEqual([]);
  });

  it("applies a narrowed grant at once, whatever it has reused", async () => {
    const { bind, verify, account } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    expect(await verify(["observer"], [ACCOUNT])).toEqual(["observer"]);

    await inAccount(await account("observer"), (_account, state) => {
      state.storage.kv.put("grantedScopes", BILLING_SCOPES);
    });

    expect(await verify(["observer"], [ACCOUNT])).toEqual([]);
  });
});

describe("addObserver", () => {
  it("requires the bound Worker on a Worker binding", async () => {
    const { backend, bind, addObserver } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.sees.blind = () => false;

    expect(await addObserver("sighted")).toBeNull();
    expect(await addObserver("blind")).toMatch(/does not have access to the bound Workers telemetry/);
  });

  it("requires the account's telemetry on an account binding", async () => {
    const { backend, bind, addObserver } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    backend.telemetryStatus.denied = 403;

    expect(await addObserver("allowed")).toBeNull();
    expect(await addObserver("denied")).toMatch(/does not have access/);
  });

  it("requires the whole account's telemetry on a Worker binding that recorded only a name", async () => {
    // Its reads, made before bindings recorded Worker IDs, went to whichever Worker had the name
    // then, so seeing today's Worker by that name proves nothing about them.
    const { backend, hooks, account, addObserver, asked } = harness();
    await hooks.bindProps("binding", {
      userObjectId: await account("owner"), accountId: ACCOUNT_ID, workerName: "api",
    });
    backend.sees.allowed = () => false;
    backend.telemetryStatus.denied = 403;

    expect(await addObserver("allowed")).toBeNull();
    expect(await addObserver("denied")).toMatch(/does not have access/);
    expect(asked("allowed")).toEqual([`POST workers/observability/telemetry/keys`]);
  });

  it("refuses rather than admits when the check itself fails", async () => {
    const { backend, bind, addObserver } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    backend.telemetryStatus.flaky = 500;

    const message = await addObserver("flaky");

    expect(message).toMatch(/500/);
    expect(message).not.toMatch(/does not have access/);
  });
});

describe("resource description", () => {
  it("describes a Worker binding with its Worker-scoped dashboard URL", async () => {
    const { bind, hooks } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));

    const described = await hooks.describeResource("binding");

    expect(described.url).toBe(
      `https://dash.cloudflare.com/${ACCOUNT_ID}/workers/services/view/api/production/observability`);
    expect(described.title).toBe("api observability");
    expect(described.suggestedBindingName).toBe("WORKER_OBSERVABILITY");
  });

  it("describes an account binding with the account-wide URL", async () => {
    const { bind, hooks } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));

    const described = await hooks.describeResource("binding");

    expect(described.url).toBe(accountObservabilityUrl(ACCOUNT_ID));
    expect(described.title).toBe("Workers Observability");
    expect(described.suggestedBindingName).toBe("CLOUDFLARE_OBSERVABILITY");
  });
});

describe("read-only enforcement", () => {
  it("refuses to apply an action", async () => {
    const { bind, hooks } = harness();
    await bind(accountObservabilityUrl(ACCOUNT_ID));

    expect(await hooks.applyActionMessage("binding")).toContain("read-only");
  });
});
