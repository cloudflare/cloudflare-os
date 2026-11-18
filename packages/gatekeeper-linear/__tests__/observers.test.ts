// Observer verification: the subresources each binding's reads report, what verifyObserverAccess
// accepts, and how an observer's account answers and reuses access checks. These drive the real
// classes against a stubbed Linear GraphQL endpoint.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { LinearGatekeeperImpl, UserAccount } from "../src/linear";
import type { LinearIssue, LinearTeam, LinearWorkspace } from "../src/types";

vi.mock("cloudflare:workers", () => ({
  DurableObject: class { constructor(public ctx: unknown, public env: unknown) {} },
  RpcTarget: class {},
  RpcStub: class {},
  WorkerEntrypoint: class {},
}));
vi.mock("capnweb-validate", () => ({
  validateRpc: () => (target: unknown) => target,
  skipRpcValidation: () => (target: unknown) => target,
}));
vi.mock("../src/types.txt", () => ({ default: "" }));
vi.mock("../src/linear-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/linear-workspace-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-team-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/linear-issue-configurator-ui.txt", () => ({ default: "" }));

type Props = { resourceKind: "workspace" | "team" | "issue"; teamKeyOrId?: string; issueRef?: string };
type Variables = {
  after?: string; id?: string; filter?: { key?: { eqIgnoreCase?: string } }; input?: { parentId?: string | null };
};

function memoryKv() {
  const map = new Map<string, unknown>();
  const kv = {
    get: (key: string) => structuredClone(map.get(key)),
    put: (key: string, value: unknown) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: ({ prefix }: { prefix: string }) => [...map].filter(([key]) => key.startsWith(prefix)),
  };
  return { kv, map };
}

function gatekeeper(props: Props) {
  const { kv, map } = memoryKv();
  const account = { getAccessToken: async () => "token", noteCredentialsExpired: async () => {} };
  const ctx = {
    props: { userObjectId: "user", workspaceUrlKey: "acme", ...props },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => account } },
    storage: { kv },
  };
  return { gk: new LinearGatekeeperImpl(ctx as never, {} as never), map };
}

/** A session's approval queue, recording every observation it authorizes. */
function recordingQueue() {
  const observations: Record<string, unknown>[] = [];
  const queue = {
    dup: () => queue,
    authorizeObservation: async (observation: Record<string, unknown>) => void observations.push(observation),
    submitAction: async () => {},
  };
  return { queue: queue as never, observations };
}

/** Stubs Linear's GraphQL endpoint; `route` answers with `data`, or a Response sent as it is. */
function linearApi(route: (query: string, variables: Variables) => unknown) {
  const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
    const { query, variables } = JSON.parse(init.body as string) as { query: string; variables?: Variables };
    const answer = route(query, variables ?? {});
    return answer instanceof Response ? answer : Response.json({ data: answer });
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

const ENG = { id: "11111111-1111-4111-8111-111111111111", key: "ENG", name: "Engineering" };
const OPS = { id: "22222222-2222-4222-8222-222222222222", key: "OPS", name: "Operations" };
const lastPage = { hasNextPage: false, endCursor: null };
const issue = {
  id: "33333333-3333-4333-8333-333333333333", identifier: "ENG-1", title: "Fix it", url: "https://linear.app/acme/issue/ENG-1",
  priority: 0, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", team: ENG,
  labels: { nodes: [], pageInfo: lastPage },
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("subresources reported by reads", () => {
  it("reports the workspace and each listed team on a workspace binding, on every page", async () => {
    linearApi((query, variables) => {
      if (query.includes("organization")) return { organization: { id: "org", name: "Acme", urlKey: "acme" } };
      return { teams: variables.after === undefined
        ? { nodes: [ENG, OPS], pageInfo: { hasNextPage: true, endCursor: "c1" } }
        : { nodes: [], pageInfo: lastPage } };
    });
    const { gk, map } = gatekeeper({ resourceKind: "workspace" });
    const { queue, observations } = recordingQueue();
    const session = await gk.startSession(queue) as LinearWorkspace;
    await session.getMetadata();
    const teams = await session.listTeams();
    await teams.next();
    await teams.next();
    expect(observations.map(o => o.subresources)).toEqual([
      ["workspace/acme"],
      ["workspace/acme", `workspace/acme/team/${ENG.id}`, `workspace/acme/team/${OPS.id}`],
      ["workspace/acme"],
    ]);
    // Reads no longer feed the legacy tracker or exclude anyone.
    expect(observations.some(o => "excludeObservers" in o)).toBe(false);
    expect([...map.keys()].some(key => key.startsWith("observedTeam:"))).toBe(false);
  });

  it("reports only the bound team, as its URL named it, on a team binding", async () => {
    linearApi(query => query.includes("cycles(")
      ? { team: { cycles: { nodes: [], pageInfo: lastPage } } }
      : { teams: { nodes: [ENG], pageInfo: lastPage } });
    const { gk } = gatekeeper({ resourceKind: "team", teamKeyOrId: "eng" });
    const { queue, observations } = recordingQueue();
    const session = await gk.startSession(queue) as LinearTeam;
    await session.getMetadata();
    await (await session.listCycles()).next();
    expect(observations.map(o => o.subresources)).toEqual([["workspace/acme/team/eng"], ["workspace/acme/team/eng"]]);
  });

  it("reports only the bound issue on an issue binding, an empty comment page included", async () => {
    linearApi(query => query.includes("comments(")
      ? { issue: { comments: { nodes: [], pageInfo: lastPage } } }
      : { issue });
    const { gk } = gatekeeper({ resourceKind: "issue", issueRef: "ENG-1" });
    const { queue, observations } = recordingQueue();
    const session = await gk.startSession(queue) as LinearIssue;
    await session.getDetails();
    expect(await (await session.readComments()).next()).toEqual([]);
    expect(observations.map(o => o.subresources)).toEqual([["workspace/acme/issue/ENG-1"], ["workspace/acme/issue/ENG-1"]]);
  });

  it("reports a pending parent's team wherever the issue is read, not just where it was queued", async () => {
    const plan = { ...issue, id: "44444444-4444-4444-8444-444444444444", identifier: "OPS-1", title: "Private plan", team: OPS };
    linearApi((_query, variables) => ({ issue: variables.id === "OPS-1" ? plan : issue }));
    const { gk } = gatekeeper({ resourceKind: "workspace" });
    const chat = recordingQueue();
    await (await (await gk.startSession(chat.queue) as LinearWorkspace).getIssue("ENG-1")).setParent("OPS-1");

    const gadget = recordingQueue();
    const details = await (await (await gk.startSession(gadget.queue) as LinearWorkspace).getIssue("ENG-1")).getDetails();
    expect(details.parent?.title).toBe("Private plan");
    expect(gadget.observations.map(o => o.subresources))
      .toEqual([["workspace/acme", `workspace/acme/team/${ENG.id}`, `workspace/acme/team/${OPS.id}`]]);
  });

  describe("a parent Linear returns", () => {
    const plan = { ...issue, id: "44444444-4444-4444-8444-444444444444", identifier: "OPS-1", title: "Private plan", team: OPS };

    /** Linear holding ENG-1 under `parentId`, which an issueUpdate changes; it returns a parent's team when asked. */
    function linearWithParent(parentId: string | null) {
      linearApi((query, variables) => {
        if (query.includes("issueUpdate")) {
          parentId = variables.input?.parentId ?? null;
          return { issueUpdate: { success: true } };
        }
        if (variables.id === plan.identifier || variables.id === plan.id) return { issue: plan };
        const parent = parentId === plan.id
          ? { id: plan.id, identifier: plan.identifier, url: plan.url, title: plan.title,
              ...(/parent \{[^}]*team \{ id \}/.test(query) ? { team: { id: OPS.id } } : {}) }
          : null;
        return { issue: { ...issue, parent } };
      });
    }

    it("reports the parent's team once the setParent that put it there is applied", async () => {
      linearWithParent(null);
      const { gk } = gatekeeper({ resourceKind: "workspace" });
      const chat = recordingQueue();
      await (await (await gk.startSession(chat.queue) as LinearWorkspace).getIssue("ENG-1")).setParent("OPS-1");
      await gk.applyAction(1);

      const gadget = recordingQueue();
      const details = await (await (await gk.startSession(gadget.queue) as LinearWorkspace).getIssue("ENG-1")).getDetails();
      expect(details.parent?.title).toBe("Private plan");
      expect(gadget.observations.map(o => o.subresources))
        .toEqual([["workspace/acme", `workspace/acme/team/${ENG.id}`, `workspace/acme/team/${OPS.id}`]]);
    });

    it("reports the team of a parent set in Linear, outside this gatekeeper", async () => {
      linearWithParent(plan.id);
      const { gk } = gatekeeper({ resourceKind: "workspace" });
      const { queue, observations } = recordingQueue();
      await (await (await gk.startSession(queue) as LinearWorkspace).getIssue("ENG-1")).getDetails();
      expect(observations.map(o => o.subresources))
        .toEqual([["workspace/acme", `workspace/acme/team/${ENG.id}`, `workspace/acme/team/${OPS.id}`]]);
    });
  });
});

describe("getHistoricalSubresources", () => {
  it.each([
    [{ resourceKind: "workspace" }, {}, ["workspace/acme"]],
    [{ resourceKind: "workspace" }, { [`observedTeam:${ENG.id}`]: "observed", [`observedTeam:${OPS.id}`]: "pending" },
      ["workspace/acme", `workspace/acme/team/${ENG.id}`, `workspace/acme/team/${OPS.id}`]],
    [{ resourceKind: "team", teamKeyOrId: "eng" }, {}, ["workspace/acme/team/eng"]],
    [{ resourceKind: "issue", issueRef: "ENG-1" }, {}, ["workspace/acme/issue/ENG-1"]],
  ] as [Props, Record<string, unknown>, string[]][])(
    "exports what %o's addObserver required, given legacy records %o, as IDs it verifies",
    async (props, legacy, expected) => {
      const { gk, map } = gatekeeper(props);
      for (const [key, value] of Object.entries(legacy)) map.set(key, value);
      const stored = new Map(map);
      await expect(gk.getHistoricalSubresources()).resolves.toEqual(expected);
      await expect(gk.getHistoricalSubresources()).resolves.toEqual(expected);
      expect(map).toEqual(stored);

      const verifier = { checkSubresourceAccess: vi.fn(async (ids: string[]) => ids.map(() => true)) };
      await expect(gk.verifyObserverAccess([{ id: "o1", verifier }] as never, expected))
        .resolves.toEqual({ allowedObserverIds: ["o1"] });
      expect(verifier.checkSubresourceAccess).toHaveBeenCalledWith(expected);
    });
});

describe("verifyObserverAccess", () => {
  function observer() {
    const verifier = { checkSubresourceAccess: vi.fn(async (ids: string[]) => ids.map(id => !id.endsWith("OPS"))) };
    return { verifier, observers: [{ id: "o1", verifier }] as never };
  }

  it.each([
    [{ resourceKind: "workspace" }, "workspace/other"],
    [{ resourceKind: "workspace" }, "workspace/other/team/ENG"],
    [{ resourceKind: "workspace" }, "workspace/acme/issue/ENG-1"],
    [{ resourceKind: "team", teamKeyOrId: "ENG" }, "workspace/acme"],
    [{ resourceKind: "team", teamKeyOrId: "ENG" }, "workspace/acme/team/OTHER"],
    [{ resourceKind: "team", teamKeyOrId: "ENG" }, "workspace/other/team/ENG"],
    [{ resourceKind: "issue", issueRef: "ENG-1" }, "workspace/acme/issue/ENG-2"],
    [{ resourceKind: "issue", issueRef: "ENG-1" }, "workspace/acme/team/ENG"],
    [{ resourceKind: "workspace" }, "repo/1"],
  ] as [Props, string][])("refuses %o reading %s without asking anyone", async (props, foreign) => {
    const { gk } = gatekeeper(props);
    const { verifier, observers } = observer();
    await expect(gk.verifyObserverAccess(observers, [foreign])).rejects.toThrow();
    expect(verifier.checkSubresourceAccess).not.toHaveBeenCalled();
  });

  it("allows an observer only if their account can read every reported subresource", async () => {
    const { gk } = gatekeeper({ resourceKind: "workspace" });
    const { verifier, observers } = observer();
    await expect(gk.verifyObserverAccess(observers, ["workspace/acme", "workspace/acme/team/ENG"]))
      .resolves.toEqual({ allowedObserverIds: ["o1"] });
    await expect(gk.verifyObserverAccess(observers, ["workspace/acme", "workspace/acme/team/OPS"]))
      .resolves.toEqual({ allowedObserverIds: [] });
    expect(verifier.checkSubresourceAccess).toHaveBeenCalledWith(["workspace/acme", "workspace/acme/team/OPS"]);
  });
});

describe("UserAccount.checkSubresourceAccess", () => {
  const grant = (accessToken: string) => ({ accessToken, expiresAt: Date.now() + 10 * 3600_000, scopes: ["read"] });

  function account() {
    const { kv } = memoryKv();
    kv.put("grant", grant("token-1"));
    const ctx = { storage: { kv }, id: { toString: () => "account" }, exports: {} };
    return { account: new UserAccount(ctx as never, {} as never), kv };
  }

  /** Linear as seen by the token: workspace `acme`, which shows team ENG and issue ENG-1 only. */
  function visibleLinear() {
    return linearApi((query, variables) => {
      if (query.includes("organization")) return { organization: { id: "org", name: "Acme", urlKey: "acme" } };
      if (query.includes("teams(")) {
        return { teams: { nodes: variables.filter.key?.eqIgnoreCase === "ENG" ? [ENG] : [], pageInfo: lastPage } };
      }
      return { issue: variables.id === "ENG-1" ? issue : null };
    });
  }

  it("answers per resource, asking for the token's workspace once", async () => {
    const fetch = visibleLinear();
    const { account: acct } = account();
    await expect(acct.checkSubresourceAccess([
      "workspace/acme", "workspace/acme/team/ENG", "workspace/acme/team/OPS",
      "workspace/acme/issue/ENG-1", "workspace/acme/issue/OPS-1", "workspace/other/team/ENG",
    ])).resolves.toEqual([true, true, false, true, false, false]);
    expect(fetch.mock.calls.filter(([, init]) => (init.body as string).includes("organization"))).toHaveLength(1);
  });

  it("asks Linear about a few uncached resources at once, answering in order", async () => {
    const keys = ["ENG", "T1", "T2", "T3", "T4", "T5", "T6"];
    // Linear holds every team request until four are waiting, then answers the oldest, or answers
    // them all once every one has been asked.
    const waiting: (() => void)[] = [];
    let asked = 0;
    let mostWaiting = 0;
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query, variables } = JSON.parse(init.body as string) as { query: string; variables: Variables };
      if (query.includes("organization")) return Response.json({ data: { organization: { id: "org", name: "Acme", urlKey: "acme" } } });
      const { promise, resolve } = Promise.withResolvers<void>();
      waiting.push(resolve);
      mostWaiting = Math.max(mostWaiting, waiting.length);
      if (++asked === keys.length) waiting.splice(0).forEach(answer => answer());
      else if (waiting.length === 4) waiting.shift()!();
      await promise;
      const key = variables.filter?.key?.eqIgnoreCase;
      return Response.json({ data: { teams: { nodes: key === "ENG" || key === "T5" ? [ENG] : [], pageInfo: lastPage } } });
    }));
    const { account: acct } = account();
    await expect(acct.checkSubresourceAccess(keys.map(key => `workspace/acme/team/${key}`)))
      .resolves.toEqual([true, false, false, false, false, true, false]);
    expect(mostWaiting).toBe(4);
  });

  it("keeps an allowed answer for 15 minutes and a denial for 15 seconds", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const fetch = visibleLinear();
    const { account: acct } = account();
    const ids = ["workspace/acme/team/ENG", "workspace/acme/team/OPS"];
    await acct.checkSubresourceAccess(ids);
    expect(fetch).toHaveBeenCalledTimes(3);
    await acct.checkSubresourceAccess(ids);
    expect(fetch).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 15_000);
    await acct.checkSubresourceAccess(ids);
    expect(fetch).toHaveBeenCalledTimes(5); // workspace and OPS again
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await acct.checkSubresourceAccess(ids);
    expect(fetch).toHaveBeenCalledTimes(8); // workspace, ENG and OPS again
  });

  it("asks again once a reconnect installs new credentials", async () => {
    const fetch = visibleLinear();
    const { account: acct, kv } = account();
    await acct.checkSubresourceAccess(["workspace/acme"]);
    await acct.checkSubresourceAccess(["workspace/acme"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    await acct.commitReconnect(stageCredentials(kv as never, grant("token-2"), Date.now()));
    await acct.checkSubresourceAccess(["workspace/acme"]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("fails a check a reconnect lands in, keeping no answer the replaced grant decided", async () => {
    // token-1 belongs to workspace `other`; the reconnect installs token-2, which belongs to `acme`.
    const started = Promise.withResolvers<void>();
    const replacedOrganization = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init: RequestInit) => {
      const { query } = JSON.parse(init.body as string) as { query: string };
      if (!query.includes("organization")) return Response.json({ data: { teams: { nodes: [ENG], pageInfo: lastPage } } });
      if ((init.headers as Record<string, string>).Authorization === "Bearer token-1") {
        started.resolve();
        return replacedOrganization.promise;
      }
      return Response.json({ data: { organization: { id: "org", name: "Acme", urlKey: "acme" } } });
    }));
    const { account: acct, kv } = account();
    const checking = acct.checkSubresourceAccess(["workspace/acme", "workspace/acme/team/ENG"]);
    await started.promise;
    await acct.commitReconnect(stageCredentials(kv as never, grant("token-2"), Date.now()));
    replacedOrganization.resolve(Response.json({ data: { organization: { id: "org-2", name: "Other", urlKey: "other" } } }));

    // Nothing mixes the two grants' answers, and the team's answer was the new grant's own.
    await expect(checking).rejects.toThrow(/changed while their access was being checked/);
    await expect(acct.checkSubresourceAccess(["workspace/acme/team/ENG"])).resolves.toEqual([true]);
  });

  it("keeps a reconnected grant when a refresh of the replaced one finishes after it", async () => {
    const started = Promise.withResolvers<void>();
    const refreshed = Promise.withResolvers<Response>();
    vi.stubGlobal("fetch", vi.fn(async () => {
      started.resolve();
      return refreshed.promise;
    }));
    const { kv } = memoryKv();
    kv.put("grant", { accessToken: "token-1", refreshToken: "refresh-1", expiresAt: Date.now(), scopes: ["read"] });
    const ctx = { storage: { kv }, id: { toString: () => "account" }, exports: {} };
    const acct = new UserAccount(ctx as never, { CLIENT_ID: "client", CLIENT_SECRET: "secret" } as never);

    const token = acct.getAccessToken();
    await started.promise;
    await acct.commitReconnect(stageCredentials(kv as never, grant("token-2"), Date.now()));
    refreshed.resolve(Response.json({ access_token: "token-1b", refresh_token: "refresh-1b", expires_in: 3600, scope: "read" }));

    await expect(token).resolves.toBe("token-2");
    expect(kv.get("grant")).toMatchObject({ accessToken: "token-2" });
  });

  it.each([
    ["a rejected token", new Response("", { status: 401 })],
    ["a rate limit", new Response("", { status: 429 })],
  ])("throws on %s, and reuses nothing from it", async (_name, failure) => {
    let fail = true;
    linearApi(() => fail ? failure : { organization: { id: "org", name: "Acme", urlKey: "acme" } });
    const { account: acct } = account();
    await expect(acct.checkSubresourceAccess(["workspace/acme"])).rejects.toThrow();
    fail = false;
    await expect(acct.checkSubresourceAccess(["workspace/acme"])).resolves.toEqual([true]);
  });

  it("throws without credentials", async () => {
    const fetch = visibleLinear();
    const { account: acct, kv } = account();
    kv.delete("grant");
    await expect(acct.checkSubresourceAccess(["workspace/acme"])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses an ID it can't check before asking Linear anything", async () => {
    const fetch = visibleLinear();
    const { account: acct } = account();
    await expect(acct.checkSubresourceAccess(["workspace/acme", "workspace/acme/project/P"])).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});
