// A binding's reads, through the facet the overseer would create: what each reports as its
// subresource, and how a Worker binding stays pinned to the Worker it was granted. The provider
// stand-in answers every query with every event, as a provider that ignored the scope filter would,
// so what the caller receives is exactly what the gatekeeper let through.

import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import { accountObservabilityUrl, workerObservabilityUrl } from "../../src/resources";
import type { CloudflareObservabilitySession } from "../../src/types";
import { ACCOUNT_ID, connectAccount, event, stubCloudflare, type Backend } from "./cloudflare-backend";

const API_ID = "a".repeat(32);
const OTHER_ID = "b".repeat(32);
const IMPOSTOR_ID = "c".repeat(32);
const ACCOUNT = `account/${ACCOUNT_ID}`;
const API_WORKER = `${ACCOUNT}/worker/${API_ID}`;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function harness() {
  const backend: Backend = stubCloudflare();
  backend.workers = [
    { id: API_ID, name: "api", versions: ["api-v1", "api-v2"] },
    { id: OTHER_ID, name: "other", versions: ["other-v1"] },
  ];
  // A fresh hooks object per test, so no facet outlives the case that made it.
  const hooks = env.TEST_HOOKS.getByName(`hooks-${crypto.randomUUID()}`);
  let queues = 0;
  return {
    backend,
    hooks,
    /** Binds `url` through a new owner account, as the overseer creates a connection. */
    bind: async (url: string) => hooks.bind("binding", await connectAccount("owner"), url),
    session: async () => {
      const queueId = `queue-${queues++}`;
      await hooks.openSession("binding", queueId);
      // Each call is made by the hooks object, which holds the session, and rethrown here.
      const session = new Proxy({}, {
        get: (_target, method) => async (...args: unknown[]) => {
          // The stub types an `unknown` result as unserializable; the hooks object returns it whole.
          const outcome = await hooks.read(queueId, method as keyof CloudflareObservabilitySession, args) as
            unknown as { ok: true; value: unknown } | { ok: false; error: string };
          if (!outcome.ok) throw new Error(outcome.error);
          return outcome.value;
        },
      }) as CloudflareObservabilitySession;
      return { session, observations: () => hooks.observations(queueId) };
    },
    /** The scope conditions the owner's last telemetry query sent. */
    lastScope: () => {
      const query = backend.requests.filter(request => request.call.endsWith("telemetry/query")).at(-1);
      if (!query) throw new Error("No telemetry query was sent.");
      const { parameters } = query.body as { parameters: { filters: Array<{ key: string; value?: unknown }> } };
      return parameters.filters.slice(0, 2).map(({ key, value }) => [key, value]);
    },
  };
}

/** Renames the bound Worker and lets a new Worker take its old name. */
function renameAndReuse(backend: Backend) {
  backend.workers[0].name = "api-renamed";
  backend.workers.push({ id: IMPOSTOR_ID, name: "api", versions: ["impostor-v1"] });
  backend.events = [
    event("own-before-rename", "api", "api-v1", { message: "own" }),
    event("impostor", "api", "impostor-v1", { message: "impostor secret" }),
    event("own-after-rename", "api-renamed", "api-v2", { message: "own" }),
  ];
}

describe("subresources", () => {
  it("reports the account on every account-wide read, an empty one included", async () => {
    const { backend, bind, session: open } = harness();
    backend.events = [event("e1", "api", "api-v1")];
    await bind(accountObservabilityUrl(ACCOUNT_ID));
    const { session, observations } = await open();

    await session.listKeys();
    await session.listValues("$metadata.level", "string");
    await session.listEvents();
    await session.listInvocations();
    await session.listTraces();
    await session.getTrace("trace-1");
    await session.calculate({ calculations: [{ operator: "count" }] });
    backend.events = [];
    await session.listEvents();

    expect((await observations()).map(observation => observation.subresources))
      .toEqual(Array.from({ length: 8 }, () => [ACCOUNT]));
  });

  it("reports the bound Worker, by its ID, on every Worker-scoped read", async () => {
    const { backend, bind, session: open } = harness();
    backend.events = [event("e1", "api", "api-v1")];
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    const { session, observations } = await open();

    await session.listKeys();
    await session.listValues("$metadata.level", "string");
    await session.listEvents();
    await session.listInvocations();
    await session.getTrace("trace-1");
    await session.calculate({ calculations: [{ operator: "count" }] });
    backend.events = [];
    await session.listEvents();
    // Trace summaries span services, so a Worker binding refuses them before reading anything.
    await expect(session.listTraces()).rejects.toThrow("account-scoped");

    expect((await observations()).map(observation => observation.subresources))
      .toEqual(Array.from({ length: 7 }, () => [API_WORKER]));
  });
});

describe("Worker identity", () => {
  it("stays with the Worker it was granted through a rename and the reuse of its name", async () => {
    const { backend, bind, session: open, lastScope } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    renameAndReuse(backend);
    const { session, observations } = await open();

    const page = await session.listEvents();

    expect(page.events.map(returned => returned.$metadata.id)).toEqual(["own-before-rename", "own-after-rename"]);
    expect(JSON.stringify(page)).not.toContain("impostor secret");
    // The provider evidently ignored the scope, so its count would be the whole account's.
    expect(page.count).toBeUndefined();
    expect(lastScope()).toEqual([
      ["$metadata.service", "api-renamed"],
      ["$workers.scriptVersion.id", "api-v1,api-v2"],
    ]);
    expect((await observations()).at(-1)?.subresources).toEqual([API_WORKER]);
  });

  it("keeps another Worker out of invocations, discovery, traces and pagination", async () => {
    const { backend, bind, session: open } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    renameAndReuse(backend);
    const { session } = await open();

    const invocations = await session.listInvocations();
    const values = await session.listValues("message", "string");
    const trace = await session.getTrace("trace-1");

    for (const result of [invocations, values, trace]) {
      expect(JSON.stringify(result)).not.toContain("impostor");
    }
    expect(values.map(value => value.value)).toEqual(["own"]);
    expect(trace.events).toHaveLength(2);

    // A page that held only the other Worker's events still continues from the provider's
    // position, so the bound Worker's older events stay reachable.
    backend.events = [event("impostor-only", "api", "impostor-v1")];
    const foreignPage = await session.listEvents();
    expect(foreignPage.events).toEqual([]);
    expect(foreignPage.nextCursor).toBe("impostor-only");
  });

  it("scopes an aggregate to the bound Worker's own versions", async () => {
    const { backend, bind, session: open, lastScope } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    renameAndReuse(backend);
    const { session } = await open();

    await session.calculate({ calculations: [{ operator: "count" }] });

    expect(lastScope()).toEqual([
      ["$metadata.service", "api-renamed"],
      ["$workers.scriptVersion.id", "api-v1,api-v2"],
    ]);
  });

  it("reads nothing once the Worker is deleted, even after another takes its name", async () => {
    const { backend, bind, session: open } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.workers = [{ id: IMPOSTOR_ID, name: "api", versions: ["impostor-v1"] }];
    backend.events = [event("impostor", "api", "impostor-v1")];
    const { session, observations } = await open();

    await expect(session.listEvents()).rejects.toThrow("no longer exists");
    await expect(session.calculate({ calculations: [{ operator: "count" }] }))
      .rejects.toThrow("no longer exists");
    expect(await observations()).toEqual([]);
  });

  it("refuses a Worker named like the bound Worker's ID once the bound one is gone", async () => {
    // The Workers API resolves a path segment by ID or by name, so after the deletion the bound
    // ID names this Worker instead.
    const { backend, bind, session: open } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    backend.workers = [{ id: IMPOSTOR_ID, name: API_ID, versions: ["impostor-v1"] }];
    backend.events = [event("impostor", API_ID, "impostor-v1")];
    const { session } = await open();

    await expect(session.listEvents()).rejects.toThrow("no longer exists");
  });

  it("refuses to bind a name no Worker in the account has", async () => {
    const { bind } = harness();

    await expect(bind(workerObservabilityUrl(ACCOUNT_ID, "missing"))).rejects.toThrow("no Worker named missing");
  });

  it("reads nothing through a Worker binding that recorded only a name", async () => {
    // What an earlier version stored: a name, but no ID to tell its Worker from the next one.
    const { backend, hooks } = harness();
    backend.events = [event("e1", "api", "api-v1")];
    await hooks.bindProps("binding", {
      userObjectId: await connectAccount("owner"), accountId: ACCOUNT_ID, workerName: "api",
    });

    expect(await hooks.openSessionError("binding")).toMatch(/predates Worker IDs/);
    expect(backend.requests).toEqual([]);
    expect((await hooks.describeResource("binding")).title).toBe("api observability");
  });
});

describe("Worker resolution", () => {
  it("reuses a resolved Worker for a minute, and a failed lookup not at all", async () => {
    const { backend, bind, session: open, lastScope } = harness();
    await bind(workerObservabilityUrl(ACCOUNT_ID, "api"));
    const { session } = await open();
    const walks = () => backend.requests.filter(request => request.call.endsWith("/versions")).length;
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();

    // Concurrent reads share one lookup.
    await Promise.all([session.listEvents(), session.listEvents()]);
    expect(walks()).toBe(1);

    // A version deployed within the minute is not yet seen...
    backend.workers[0].versions.push("api-v3");
    vi.setSystemTime(start + 59_999);
    await session.listEvents();
    expect(walks()).toBe(1);
    expect(lastScope()[1]).toEqual(["$workers.scriptVersion.id", "api-v1,api-v2"]);

    // ...and is once the minute is up.
    vi.setSystemTime(start + 60_000);
    await session.listEvents();
    expect(walks()).toBe(2);
    expect(lastScope()[1]).toEqual(["$workers.scriptVersion.id", "api-v1,api-v2,api-v3"]);

    // A lookup that failed is asked again by the next read, not replayed for the minute.
    vi.setSystemTime(start + 120_000);
    backend.sees.owner = () => false;
    await expect(session.listEvents()).rejects.toThrow("no longer exists");
    delete backend.sees.owner;
    await session.listEvents();
    expect(walks()).toBe(4);
  });
});
