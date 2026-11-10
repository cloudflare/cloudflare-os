// Observer behaviour that needs the gatekeeper and account Durable Objects themselves: what a read
// through a shared session reports, and how an account's access check survives a reconnect. These
// drive the real classes over in-memory storage against a stubbed Notion API.
import { afterEach, describe, expect, it, vi } from "vitest";
import { stageCredentials } from "@gadgets/gatekeeper-kit/credential-stage";
import { NotionItemGatekeeperImpl, NotionWorkspaceGatekeeperImpl, UserAccount } from "../src/notion";
import { MISSING_WORKSPACE_ID_MESSAGE, itemSubresourceId, workspaceSubresourceId } from "../src/notion-subresources";
import type { NotionPage, NotionWorkspace } from "../src/types";

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
const OTHER_WORKSPACE = "0d6e5c1a-0000-4000-8000-000000000000";
const PAGE = "1a2b3c4d5e6f4a7b8c9d0e1f2a3b4c5d";

const page = {
  object: "page", id: PAGE, url: `https://www.notion.so/${PAGE}`, properties: {},
  parent: { type: "workspace", workspace: true },
  created_time: "2026-01-01T00:00:00.000Z", last_edited_time: "2026-01-01T00:00:00.000Z",
};

/** Notion's users/me answer for a connection's bot, naming `workspaceId` if given. */
function botUser(workspaceId?: string) {
  return {
    object: "user", id: "bot", type: "bot", name: "Gadgets", avatar_url: null,
    bot: { workspace_name: "Acme", ...(workspaceId ? { workspace_id: workspaceId } : {}) },
  };
}

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

/** A real account holding `info` as its stored account info, as a connection made then left it. */
function userAccount(info: Record<string, unknown>) {
  const kv = memoryKv();
  kv.put("accessToken", "token-1");
  kv.put("accountInfo", info);
  const ctx = { storage: { kv, deleteAll: () => {}, deleteAlarm: () => {} }, id: { toString: () => "account" }, exports: {} };
  return { kv, account: new UserAccount(ctx as never, { CLIENT_ID: "client", CLIENT_SECRET: "secret" } as never) };
}

/** A binding's context, owned by `owner` (a UserAccount or a fake of one). */
function bindingCtx(owner: unknown, props: Record<string, unknown> = {}) {
  return {
    props: { userObjectId: "owner", ...props },
    storage: { kv: memoryKv() },
    exports: { UserAccount: { idFromString: (id: string) => id, get: () => owner } },
  };
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
      getWorkspaceId: async () => WORKSPACE,
    };
    const gk = new NotionWorkspaceGatekeeperImpl(bindingCtx(owner) as never, {} as never);

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

  it("authorizes each chunk of a page's children with that chunk alone, even on a retry", async () => {
    const children = [1, 2, 3, 4, 5].map(i => `${"c".repeat(31)}${i}`);
    const blockTree = vi.fn(() => Response.json({
      results: children.map(id => ({ object: "block", id, type: "child_page", child_page: { title: id } })),
      has_more: false, next_cursor: null,
    }));
    notionApi({ [`/v1/pages/${PAGE}`]: () => Response.json(page), [`/v1/blocks/${PAGE}/children`]: blockTree });
    const owner = {
      getAccessToken: async () => "owner-token",
      refreshCredentials: async () => "owner-token",
      getAccountInfo: async () => ({ workspaceId: WORKSPACE }),
      getWorkspaceId: async () => WORKSPACE,
    };
    const gk = new NotionWorkspaceGatekeeperImpl(bindingCtx(owner) as never, {} as never);
    const listed: string[][] = [];
    let refuse = false;
    const queue = {
      dup: () => queue,
      authorizeObservation: async (observation: { title: string; subresources: string[] }) => {
        if (observation.title === "List Notion child pages") listed.push(observation.subresources);
        if (refuse) {
          refuse = false;
          throw new Error("Refused.");
        }
      },
    };
    const parent = await (await gk.startSession(queue as never) as NotionWorkspace).getPage(PAGE);
    const cursor = await parent.listChildPages({ pageSize: 2 });

    const ids = async () => (await cursor.next())?.map(child => child.id);
    expect(await ids()).toEqual(children.slice(0, 2));
    refuse = true;
    await expect(cursor.next()).rejects.toThrow("Refused.");
    expect(await ids()).toEqual(children.slice(2, 4));
    expect(await ids()).toEqual(children.slice(4));
    expect(await cursor.next()).toBeNull();

    const chunk = (...ids: string[]) => [workspaceSubresourceId(WORKSPACE), ...[PAGE, ...ids].map(id => itemSubresourceId(WORKSPACE, id))];
    expect(listed).toEqual([
      chunk(...children.slice(0, 2)),
      chunk(...children.slice(2, 4)),
      chunk(...children.slice(2, 4)),
      chunk(...children.slice(4)),
    ]);
    expect(blockTree).toHaveBeenCalledTimes(1);
  });
});

describe("a connection made before workspace ids were stored", () => {
  it("asks Notion for its workspace once, stores it, and reads and checks with it", async () => {
    const me = vi.fn(() => Response.json(botUser(WORKSPACE)));
    notionApi({ "/v1/users/me": me, [`/v1/pages/${PAGE}`]: () => Response.json(page) });
    const owner = userAccount({ ownerName: "Ada" });
    const gk = new NotionItemGatekeeperImpl(bindingCtx(owner.account, { itemId: PAGE }) as never, {} as never);
    const { queue, observations } = recordingQueue();

    await (await gk.startSession(queue) as NotionPage).getMetadata();
    await (await gk.startSession(queue) as NotionPage).getMetadata();
    expect(observations.map(observation => observation.subresources))
      .toEqual([[itemSubresourceId(WORKSPACE, PAGE)], [itemSubresourceId(WORKSPACE, PAGE)]]);
    expect(owner.kv.get("accountInfo")).toEqual({ ownerName: "Ada", workspaceId: WORKSPACE });
    expect(me).toHaveBeenCalledTimes(1);
    expect(await gk.getHistoricalSubresources()).toEqual([itemSubresourceId(WORKSPACE, PAGE)]);

    // An observer whose connection predates them too is a member once Notion names its workspace.
    const observer = userAccount({});
    expect(await observer.account.checkSubresourceAccess([workspaceSubresourceId(WORKSPACE)])).toEqual([true]);
    expect(observer.kv.get("accountInfo")).toEqual({ workspaceId: WORKSPACE });
  });

  it("still fails closed when Notion's answer names no workspace", async () => {
    notionApi({ "/v1/users/me": () => Response.json(botUser()), [`/v1/pages/${PAGE}`]: () => Response.json(page) });
    const owner = userAccount({ ownerName: "Ada" });
    const gk = new NotionItemGatekeeperImpl(bindingCtx(owner.account, { itemId: PAGE }) as never, {} as never);
    const { queue, observations } = recordingQueue();

    await expect((await gk.startSession(queue) as NotionPage).getMetadata()).rejects.toThrow(MISSING_WORKSPACE_ID_MESSAGE);
    expect(observations).toEqual([]);
    expect(owner.kv.get("accountInfo")).toEqual({ ownerName: "Ada" });
    await expect(gk.getHistoricalSubresources()).rejects.toThrow();

    const observer = userAccount({});
    expect(await observer.account.checkSubresourceAccess([workspaceSubresourceId(WORKSPACE)])).toEqual([false]);
  });

  it("doesn't store a replaced connection's workspace into the installed one's info", async () => {
    const started = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<Response>();
    notionApi({
      "/v1/users/me": () => {
        started.resolve();
        return answer.promise;
      },
    });
    const { kv, account } = userAccount({});

    const asking = account.getWorkspaceId();
    await started.promise;
    await account.commitReconnect(stageCredentials(kv as never, { accessToken: "token-2", workspaceId: OTHER_WORKSPACE }, Date.now()));
    answer.resolve(Response.json(botUser(WORKSPACE)));

    expect(await asking).toBe(OTHER_WORKSPACE);
    expect(kv.get<{ workspaceId?: string }>("accountInfo")?.workspaceId).toBe(OTHER_WORKSPACE);
  });
});

describe("getHistoricalSubresources", () => {
  it("exports a workspace binding's membership and every item its legacy tracker recorded, all checkable", async () => {
    const owner = { getAccountInfo: async () => ({ workspaceId: WORKSPACE }) };
    const ctx = bindingCtx(owner);
    ctx.storage.kv.put(`observedItem:${DATABASE}`, "observed");
    ctx.storage.kv.put(`observedItem:${OTHER_DATABASE}`, "pending");
    ctx.storage.kv.put(`observedItem:${PAGE}`, true);
    const gk = new NotionWorkspaceGatekeeperImpl(ctx as never, {} as never);

    const history = await gk.getHistoricalSubresources();
    expect(new Set(history)).toEqual(new Set([
      workspaceSubresourceId(WORKSPACE),
      itemSubresourceId(WORKSPACE, DATABASE),
      itemSubresourceId(WORKSPACE, OTHER_DATABASE),
      itemSubresourceId(WORKSPACE, PAGE),
    ]));
    expect(history).toHaveLength(4);
    expect(await gk.getHistoricalSubresources()).toEqual(history);

    const asked: string[][] = [];
    const verifier = {
      checkSubresourceAccess: async (ids: string[]) => {
        asked.push(ids);
        return ids.map(() => true);
      },
    };
    expect(await gk.verifyObserverAccess([{ id: "observer", verifier: verifier as never }], history))
      .toEqual({ allowedObserverIds: ["observer"] });
    expect(asked).toEqual([history]);
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
