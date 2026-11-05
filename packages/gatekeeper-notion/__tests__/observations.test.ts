// Observer behaviour that needs the gatekeeper and account Durable Objects themselves: what a read
// through a shared session reports, and how an account's access check survives a reconnect. These
// drive the real classes over in-memory storage against a stubbed Notion API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { NotionWorkspaceGatekeeperImpl, UserAccount } from "../src/notion";
import { itemSubresourceId, workspaceSubresourceId } from "../src/notion-subresources";
import type { NotionWorkspace } from "../src/types";

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
vi.mock("../src/notion-logo.svg", () => ({ default: "" }));
vi.mock("../src/generated/notion-item-configurator-ui.txt", () => ({ default: "" }));
vi.mock("../src/generated/notion-workspace-configurator-ui.txt", () => ({ default: "" }));

const WORKSPACE = "7c1d6a52-0f3b-4e8a-9d4e-1b2c3d4e5f60";
const DATABASE = "0123456789abcdef0123456789abcdef";
const OTHER_DATABASE = "fedcba9876543210fedcba9876543210";

function memoryKv() {
  const map = new Map<string, unknown>();
  return {
    get: <T>(key: string) => structuredClone(map.get(key)) as T | undefined,
    put: (key: string, value: unknown) => void map.set(key, structuredClone(value)),
    delete: (key: string) => map.delete(key),
    list: <T>({ prefix }: { prefix: string }) =>
      [...map].filter(([key]) => key.startsWith(prefix)) as [string, T][],
  };
}

/** Answers Notion's API by path, ids undashed; a function route is asked on every request. */
function notionApi(routes: Record<string, () => Response | Promise<Response>>) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const route = routes[new URL(url).pathname.replaceAll("-", "")];
    return route ? await route() : Response.json({ code: "object_not_found", message: "Not found" }, { status: 404 });
  }));
}

function recordingQueue() {
  const observations: { subresources?: string[] }[] = [];
  const queue = {
    dup: () => queue,
    authorizeObservation: async (observation: { subresources?: string[] }) => void observations.push(observation),
    submitAction: async () => {},
  };
  return { queue: queue as never, observations };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reads through a workspace binding", () => {
  it("reports the database whose columns a pending row's properties show, in any session", async () => {
    const database = { object: "database", id: DATABASE, title: [], data_sources: [{ id: "ds1", name: "Main" }] };
    notionApi({
      [`/v1/databases/${DATABASE}`]: () => Response.json(database),
      "/v1/data_sources/ds1": () => Response.json({
        object: "data_source", id: "ds1",
        properties: {
          Name: { id: "title", name: "Name", type: "title", title: {} },
          Salary: { id: "s", name: "Salary", type: "number", number: { format: "dollar" } },
        },
      }),
    });
    const owner = {
      getAccessToken: async () => "owner-token",
      refreshCredentials: async () => "owner-token",
      getAccountInfo: async () => ({ workspaceId: WORKSPACE }),
    };
    const ctx = {
      props: { userObjectId: "owner" },
      storage: { kv: memoryKv() },
      exports: { UserAccount: { idFromString: (id: string) => id, get: () => owner } },
    };
    const gk = new NotionWorkspaceGatekeeperImpl(ctx as never, {} as never);

    // A chat only the owner can see queues a row in the database...
    const chat = recordingQueue();
    const db = await (await gk.startSession(chat.queue) as NotionWorkspace).getDatabase(DATABASE);
    await db.createPage({ title: "Row" });

    // ...and a shared gadget opens the pending row by its handle and reads its properties.
    const gadget = recordingQueue();
    const row = await (await gk.startSession(gadget.queue) as NotionWorkspace).getPage("~1");
    expect(Object.keys(await row.getProperties())).toContain("Salary");
    expect(gadget.observations.at(-1)?.subresources)
      .toEqual([workspaceSubresourceId(WORKSPACE), itemSubresourceId(WORKSPACE, DATABASE)]);
  });
});

describe("UserAccount.checkSubresourceAccess", () => {
  it("fails a check a reconnect lands in rather than combining two accounts' answers", async () => {
    const started = Promise.withResolvers<void>();
    const otherDatabase = Promise.withResolvers<Response>();
    notionApi({
      [`/v1/databases/${DATABASE}`]: () => Response.json({ object: "database", id: DATABASE }),
      [`/v1/databases/${OTHER_DATABASE}`]: () => {
        started.resolve();
        return otherDatabase.promise;
      },
    });
    const kv = memoryKv();
    kv.put("accessToken", "token-1");
    kv.put("accountInfo", { workspaceId: WORKSPACE });
    const ctx = { storage: { kv, deleteAll: () => {}, deleteAlarm: () => {} }, id: { toString: () => "account" }, exports: {} };
    const account = new UserAccount(ctx as never, { CLIENT_ID: "client", CLIENT_SECRET: "secret" } as never);
    const database = itemSubresourceId(WORKSPACE, DATABASE);
    await expect(account.checkSubresourceAccess([database])).resolves.toEqual([true]);

    const checking = account.checkSubresourceAccess([database, itemSubresourceId(WORKSPACE, OTHER_DATABASE)]);
    await started.promise;
    await account.commitReconnect(stageCredentials(kv as never, { accessToken: "token-2", workspaceId: WORKSPACE }, Date.now()));
    otherDatabase.resolve(Response.json({ object: "database", id: OTHER_DATABASE }));

    await expect(checking).rejects.toThrow(/changed while their access was being checked/);
  });
});
