// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { Activity, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RpcStub } from "capnweb";
import type { Overseer, SlashCommandRequest } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const updateProvisionalWorkspaceOrigin = vi.fn<(id: string, hub: string) => Promise<void>>(
    async () => {},
  );
  const overseer = {
    getMetadata: vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "workspace-1" })),
    newChat: vi.fn<() => Promise<number>>(async () => 7),
    [Symbol.dispose]: vi.fn<() => void>(),
  };
  const newGadget = vi.fn<(hub?: string) => RpcStub<Overseer>>(
    () => overseer as unknown as RpcStub<Overseer>,
  );
  const newGadgetFromBlueprint = vi.fn<() => RpcStub<Overseer>>(
    () => overseer as unknown as RpcStub<Overseer>,
  );
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget, newGadgetFromBlueprint, updateProvisionalWorkspaceOrigin },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    navigate: vi.fn<(options: unknown) => void>(),
    newGadget,
    newGadgetFromBlueprint,
    overseer,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    draftStorageKeys: [] as Array<string | undefined>,
    sendingStatusLabels: [] as Array<string | undefined>,
    sendResults: [] as Array<void | false>,
    callbacks: null as null | {
      onSend?: (message: string | SlashCommandRequest, modelId: string | null) => Promise<void | false>;
      getOverseer: () => RpcStub<Overseer>;
    },
    updateProvisionalWorkspaceOrigin,
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./ChatInput", () => ({
  ChatInput: ({ seedText, seedNonce, draftStorageKey, onSend, onInputIntent, sendingStatusLabel, getOverseer }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
    onSend?: (message: string | SlashCommandRequest, modelId: string | null) => Promise<void | false>;
    onInputIntent?: () => void;
    sendingStatusLabel?: string;
    getOverseer: () => RpcStub<Overseer>;
  }) => {
    testState.callbacks = { onSend, getOverseer };
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.draftStorageKeys.push(draftStorageKey);
    testState.sendingStatusLabels.push(sendingStatusLabel);
    return <>
      <textarea aria-label="Prompt" readOnly value={seedText ?? ""} onFocus={onInputIntent} />
      <button onClick={() => onSend?.("Ship it", null).then(result => { testState.sendResults.push(result); })}>Send</button>
    </>;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";
import { HubProvider, useHub } from "./HubContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const initialApi = testState.authenticatedApi;

describe("Home prompt route flow", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    localStorage.clear();
    testState.seeds.length = 0;
    testState.draftStorageKeys.length = 0;
    testState.sendingStatusLabels.length = 0;
    testState.sendResults.length = 0;
    testState.authenticatedApi = initialApi;
    vi.clearAllMocks();
  });

  it("seeds the composer once, clears route state, and does not create a workspace", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent prompt="Create a daily brief." />));

    expect(container.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')?.value).toBe(
      "Create a daily brief.",
    );
    expect(Math.max(...testState.seeds.map(({ nonce }) => nonce ?? 0))).toBe(1);
    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home:ops");
    expect(testState.sendingStatusLabels).toContain("Starting workspace…");
  });

  it("pre-creates the selected hub on composer intent and skips restamping that same hub", async () => {
    localStorage.setItem("odie:selected-hub", "support");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <HubProvider enabledHubs={["ops", "support"]}>
        <HomePageContent />
      </HubProvider>,
    ));
    await act(async () => container!.querySelector("textarea")!.focus());
    expect(testState.newGadget).toHaveBeenCalledWith("support");
    expect(testState.updateProvisionalWorkspaceOrigin).not.toHaveBeenCalled();

    await act(async () => container!.querySelector("button")!.click());

    expect(testState.newGadget).toHaveBeenCalledTimes(1);
    expect(testState.updateProvisionalWorkspaceOrigin).not.toHaveBeenCalled();
    expect(testState.overseer.newChat).toHaveBeenCalledWith("Ship it", null, undefined, undefined, undefined);
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id",
      params: { id: "workspace-1" },
      search: { chat: 7 },
    });
  });

  it("stamps a pre-created provisional workspace after a last-second hub switch", async () => {
    function SwitchableHome() {
      const { selectHub } = useHub();
      return <>
        <button onClick={() => selectHub("support")}>Switch to support</button>
        <HomePageContent />
      </>;
    }

    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <HubProvider enabledHubs={["ops", "support"]}>
        <SwitchableHome />
      </HubProvider>,
    ));
    await act(async () => container!.querySelector("textarea")!.focus());
    expect(testState.newGadget).toHaveBeenCalledWith("ops");

    await act(async () => Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Switch to support")!.click());
    await act(async () => Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Send")!.click());

    expect(testState.updateProvisionalWorkspaceOrigin).toHaveBeenCalledWith("workspace-1", "support");
    expect(testState.overseer.newChat).toHaveBeenCalledOnce();
  });

  it("ignores duplicate Home sends while workspace start is pending", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(<HomePageContent />));
    const sendButton = container.querySelector("button")!;
    await act(async () => {
      sendButton.click();
      sendButton.click();
    });

    expect(testState.overseer.newChat).toHaveBeenCalledOnce();
  });

  it.each(['metadata', 'chat'] as const)("does not navigate or continue an abandoned Home send after %s resolves", async (stage) => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    if (stage === 'metadata') testState.overseer.getMetadata.mockImplementationOnce(async () => { await pending; return { id: 'abandoned' }; });
    else testState.overseer.newChat.mockImplementationOnce(async () => { await pending; return 9; });
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector('button')!.click());
    await act(async () => root!.render(<div>Another page</div>));
    await act(async () => finish());
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.overseer.newChat).toHaveBeenCalledTimes(stage === 'metadata' ? 0 : 1);
    expect(testState.sendResults).toEqual([false]);
  });

  it("does not let a pre-recovery send navigate or dispose a new provisional workspace", async () => {
    let finish!: (chat: number) => void;
    testState.overseer.newChat.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = async (mode: 'hidden' | 'visible') => {
      await act(async () => root!.render(<Activity mode={mode}><HomePageContent /></Activity>));
    };
    await render('visible');
    await act(async () => container!.querySelector('button')!.click());
    await render('hidden');
    await render('visible');
    await act(async () => container!.querySelector('textarea')!.focus());
    const disposals = testState.overseer[Symbol.dispose].mock.calls.length;
    await act(async () => finish(9));
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.overseer[Symbol.dispose]).toHaveBeenCalledTimes(disposals);
    await act(async () => container!.querySelector('button')!.click());
    expect(testState.navigate).toHaveBeenCalledOnce();
  });

  it("does not navigate when Finance creation completes after leaving Home", async () => {
    let finish!: (metadata: { id: string }) => void;
    testState.overseer.getMetadata.mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    localStorage.setItem('odie:selected-hub', 'finance');
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <HubProvider enabledHubs={['ops']} financeStatus={{ authorized: true, canCreate: true }}>
        <HomePageContent />
      </HubProvider>,
    ));
    await act(async () => container!.querySelector('button')!.click());
    await act(async () => root!.render(<div>Another page</div>));
    await act(async () => finish({ id: 'abandoned-finance' }));
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.overseer[Symbol.dispose]).toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)("ignores an old send's %s after API replacement without unlocking the new send", async (outcome) => {
    let resolveOld!: (chat: number) => void;
    let rejectOld!: (error: Error) => void;
    let resolveNew!: (chat: number) => void;
    testState.overseer.newChat
      .mockReturnValueOnce(new Promise((resolve, reject) => { resolveOld = resolve; rejectOld = reject; }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve; }));
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector('button')!.click());
    testState.authenticatedApi = { ...initialApi };
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => container!.querySelector('button')!.click());
    expect(testState.newGadget).toHaveBeenCalledTimes(2);
    const disposals = testState.overseer[Symbol.dispose].mock.calls.length;
    await act(async () => {
      if (outcome === 'resolve') resolveOld(8);
      else rejectOld(new Error('Old connection failed'));
    });
    expect(testState.navigate).not.toHaveBeenCalled();
    expect(testState.addToast).not.toHaveBeenCalled();
    expect(testState.overseer[Symbol.dispose]).toHaveBeenCalledTimes(disposals);
    await act(async () => container!.querySelector('button')!.click());
    expect(testState.overseer.newChat).toHaveBeenCalledTimes(2);
    await act(async () => resolveNew(10));
    expect(testState.navigate).toHaveBeenCalledOnce();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: '/workspace/$id', params: { id: 'workspace-1' }, search: { chat: 10 },
    });
  });

  it.each(['exit', 'reveal', 'api'] as const)('rejects retained Home capability factories and send callbacks after %s', async (change) => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const render = async (mode: 'visible' | 'hidden') => {
      await act(async () => root!.render(<Activity mode={mode}><HomePageContent /></Activity>));
    };
    await render('visible');
    const old = testState.callbacks!;
    if (change === 'exit') await act(async () => root!.render(<div>Another route</div>));
    else if (change === 'api') {
      testState.authenticatedApi = { ...initialApi };
      await render('visible');
    } else {
      await render('hidden');
      await render('visible');
    }
    await act(async () => { expect(await old.onSend!('Late send', null)).toBe(false); });
    expect(old.getOverseer).toThrow('Home is no longer active');
    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.navigate).not.toHaveBeenCalled();
  });

  it("opens the entitled shared Finance workspace without creating another", async () => {
    localStorage.setItem("odie:selected-hub", "finance");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <HubProvider
        enabledHubs={["ops", "support"]}
        financeStatus={{ authorized: true, workspaceId: "finance-shared", canCreate: false }}
      >
        <HomePageContent />
      </HubProvider>,
    ));

    await act(async () => container!.querySelector("button")!.click());
    expect(testState.newGadgetFromBlueprint).not.toHaveBeenCalled();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id", params: { id: "finance-shared" }, search: {},
    });
  });

  it("bootstraps Finance through the protected blueprint and disposes the pipelined stub", async () => {
    localStorage.setItem("odie:selected-hub", "finance");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <HubProvider
        enabledHubs={["ops", "support"]}
        financeStatus={{ authorized: true, canCreate: true }}
      >
        <HomePageContent />
      </HubProvider>,
    ));

    await act(async () => container!.querySelector("button")!.click());
    expect(testState.newGadgetFromBlueprint).toHaveBeenCalledWith(
      "starter.finance-operations-workbench", {}, "finance",
    );
    expect(testState.overseer.getMetadata).toHaveBeenCalled();
    expect(testState.overseer[Symbol.dispose]).toHaveBeenCalled();
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id", params: { id: "workspace-1" }, search: {},
    });
  });
});
