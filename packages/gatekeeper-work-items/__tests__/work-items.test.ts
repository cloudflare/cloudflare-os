import { lstatSync, readlinkSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  GatekeeperVendor,
  WorkItemsAccount,
  WorkItemsShellApi,
  WorkItemsUser,
  WorkItemsGatekeeper,
  describeWorkItemsAccount,
  normalizeCurrentUser,
  normalizeSavedView,
} from "../src/work-items";
import type { WorkItemSavedView } from "../src/types";

// Match Wrangler's Text module rule instead of Vite's asset URL import.
vi.mock("../src/agent-types.txt", async () => {
  const { readFileSync } = await import("node:fs");
  return { default: readFileSync("src/agent-types.txt", "utf8") };
});

const generatedAccountId = "5ac7c8dffbb54853a2c87f12a5b7e001";

type TestAccountNamespace = {
  newUniqueId(): { toString(): string };
  idFromString(id: string): string;
  get(id: string): AccountStub;
};

type AccountStub = Pick<WorkItemsAccount, "listSavedViews" | "saveSavedView" | "deleteSavedView" | "importSavedViews" | "revoke">;

function setCtx<T extends object>(target: T, ctx: unknown): T {
  Object.defineProperty(target, "ctx", { configurable: true, value: ctx });
  return target;
}

function createAccountNamespace(account: AccountStub, resolvedIds: string[] = []): TestAccountNamespace {
  return {
    newUniqueId: () => ({ toString: () => generatedAccountId }),
    idFromString: (id: string) => {
      if (id !== generatedAccountId) throw new Error(`Invalid Durable Object id: ${id}`);
      resolvedIds.push(id);
      return id;
    },
    get: (id: string) => {
      if (id !== generatedAccountId) throw new Error(`Unexpected account stub id: ${id}`);
      return account;
    },
  };
}

describe("Work Items shell", () => {
  it("exposes only the ping marker in agent-facing types", async () => {
    for (const target of [Object.create(GatekeeperVendor.prototype) as GatekeeperVendor, Object.create(WorkItemsGatekeeper.prototype) as WorkItemsGatekeeper]) {
      const types = await target.getTypeScriptTypes();
      expect(types).toContain("ping(): Promise<string>");
      expect(types).not.toContain("search(");
      expect(types).not.toContain("WorkItemsManagementApi");
    }
  });
  it("keeps the runtime types module as a symlink to the declaration file", () => {
    expect(lstatSync("src/types.txt").isSymbolicLink()).toBe(true);
    expect(readlinkSync("src/types.txt")).toBe("types.d.ts");
  });

  it("advertises provider-neutral composition metadata without a role", () => {
    expect(describeWorkItemsAccount({ displayName: "Ada", uniqueName: "ada@example.com" })).toMatchObject({
      displayName: "Ada",
      uniqueName: "ada@example.com",
      singleton: { tsType: "WorkItemsSession" },
      providesUi: { title: "Work Items", composition: { kind: "work-items" } },
    });
  });

  it("bounds current-user metadata stored by the shell", () => {
    expect(normalizeCurrentUser({ displayName: " A ", uniqueName: "u" })).toEqual({ displayName: "A", uniqueName: "u" });
    expect(normalizeCurrentUser({ displayName: "", uniqueName: "" })).toEqual({ displayName: undefined, uniqueName: undefined });
  });

  it("normalizes saved views and rejects reserved ids", () => {
    expect(normalizeSavedView({
      id: " triage ",
      name: " Triage ",
      query: "login",
      source: "both",
      filters: { status: "Open", priority: "", type: "Bug", person: "Ada" },
      view: "kanban",
      hiddenStatuses: ["Done", ""],
    })).toEqual({
      id: "triage",
      name: "Triage",
      query: "login",
      source: "both",
      filters: { status: "Open", priority: "", type: "Bug", person: "Ada" },
      view: "kanban",
      hiddenStatuses: ["Done"],
    });
    expect(() => normalizeSavedView({ id: "builtin:all", name: "All", query: "", source: "jira", filters: { status: "", priority: "", type: "", person: "" }, view: "list", hiddenStatuses: [] })).toThrow(/reserved|invalid/i);
  });

  it("durably replaces saved views through the bounded operational import", () => {
    const account = Object.create(WorkItemsAccount.prototype) as WorkItemsAccount;
    const store = new Map<string, unknown>();
    setCtx(account, { storage: { kv: { get: (key: string) => store.get(key), put: (key: string, value: unknown) => store.set(key, value), delete: (key: string) => store.delete(key) } } });

    account.saveSavedView({ id: "custom:first", name: "First", query: "old", source: "jira", assignedToMe: true, filters: { status: "", priority: "", type: "", person: "" }, view: "list", hiddenStatuses: [] });
    expect(account.listSavedViews()[0].assignedToMe).toBe(true);
    const imported = account.importSavedViews([
      { id: "custom:next", name: "Old Next", query: "old", source: "jira", filters: { status: "", priority: "", type: "", person: "" }, view: "list", hiddenStatuses: [] },
      { id: "custom:next", name: "Next", query: "new", source: "both", assignedToMe: true, filters: { status: "Open", priority: "", type: "", person: "Ada" }, view: "kanban", hiddenStatuses: ["Done"] },
    ]);

    expect(imported).toHaveLength(1);
    expect(account.listSavedViews()).toEqual(imported);
    expect(account.listSavedViews()[0]?.id).toBe("custom:next");
    expect(account.listSavedViews()[0]?.assignedToMe).toBe(true);
    expect(account.importSavedViews(imported)).toEqual(imported);
  });

  it("provisions an identity-free account with a Durable Object id and wires app UI saved views to that account", async () => {
    let provisionedProps: unknown;
    const resolvedIds: string[] = [];
    const savedViews: WorkItemSavedView[] = [];
    const account: AccountStub = {
      listSavedViews: () => savedViews,
      saveSavedView: (view) => {
        savedViews.unshift(view);
        return view;
      },
      deleteSavedView: (id) => {
        const index = savedViews.findIndex((view) => view.id === id);
        if (index >= 0) savedViews.splice(index, 1);
      },
      importSavedViews: (views) => {
        savedViews.splice(0, savedViews.length, ...views);
        return savedViews;
      },
      revoke: () => { savedViews.splice(0); },
    };
    const accountNamespace = createAccountNamespace(account, resolvedIds);
    const vendor = setCtx(new GatekeeperVendor(), {
      exports: {
        WorkItemsAccount: accountNamespace,
        WorkItemsUser: ({ props }: { props: unknown }) => {
          provisionedProps = props;
          return setCtx(new WorkItemsUser(), { exports: { WorkItemsAccount: accountNamespace }, props });
        },
      },
    });

    const user = await vendor.createAccount() as WorkItemsUser;
    expect(provisionedProps).toEqual({ accountId: generatedAccountId });
    expect(() => accountNamespace.idFromString((provisionedProps as { accountId: string }).accountId)).not.toThrow();
    expect(provisionedProps).not.toHaveProperty("userId");

    const frame = await user.startAppUi({ isAdmin: false });
    const shellApi = (frame.ui as unknown as { target?: WorkItemsShellApi }).target;
    const saved = await shellApi?.saveSavedView({ id: "custom:triage", name: "Triage", query: "login", source: "both", filters: { status: "", priority: "", type: "", person: "" }, view: "list", hiddenStatuses: [] });

    expect(frame.iframeHtml).toEqual(expect.any(String));
    expect(saved?.id).toBe("custom:triage");
    expect(await shellApi?.listSavedViews()).toEqual([saved]);
    expect(resolvedIds).toContain(generatedAccountId);
  });
});
