// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
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
  ChatInput: ({ seedText, seedNonce, draftStorageKey, onSend, onInputIntent, sendingStatusLabel }: {
    seedText?: string;
    seedNonce?: number;
    draftStorageKey?: string;
    onSend?: (message: string | SlashCommandRequest, modelId: string | null) => Promise<void>;
    onInputIntent?: () => void;
    sendingStatusLabel?: string;
  }) => {
    testState.seeds.push({ text: seedText, nonce: seedNonce });
    testState.draftStorageKeys.push(draftStorageKey);
    testState.sendingStatusLabels.push(sendingStatusLabel);
    return <>
      <textarea aria-label="Prompt" readOnly value={seedText ?? ""} onFocus={onInputIntent} />
      <button onClick={() => onSend?.("Ship it", null)}>Send</button>
    </>;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";
import { HubProvider, useHub } from "./HubContext";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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
