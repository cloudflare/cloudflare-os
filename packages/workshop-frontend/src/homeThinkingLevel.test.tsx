// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

// Exercises the Home page composer's (routes/index.tsx) new-chat path: that a thinking level
// picked before the first message is forwarded to newChat(), and that it's handed off (via
// pendingChatThinkingLevel) so the workspace page this navigates to can pick it up for the
// chat's second message. See ChatInterface.tsx's own consumer of the handoff and
// promoteThinkingLevelSelection() for the sibling continuity path (new chat started from within
// an already-mounted ChatInterface, which doesn't need storage since nothing unmounts).
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ThinkingLevel } from "@gadgets/workshop-shared/api";
import { takePendingChatThinkingLevel } from "./pendingChatThinkingLevel";

type CapturedOnSend = (
  message: string,
  modelId: string | null,
  capsules?: unknown,
  attachments?: unknown,
  formats?: unknown,
  thinkingLevel?: ThinkingLevel,
) => Promise<void> | void;

const testState = vi.hoisted(() => {
  const newChat = vi.fn<(...args: unknown[]) => Promise<number>>(async () => 42);
  const getMetadata = vi.fn<() => Promise<{ id: string }>>(async () => ({ id: "gadget-1" }));
  const dispose = vi.fn();
  const stub = { newChat, getMetadata, [Symbol.dispose]: dispose };
  const newGadget = vi.fn(() => stub);
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newGadget },
    dispose,
    getMetadata,
    navigate: vi.fn<(options: unknown) => void>(),
    newChat,
    newGadget,
    onSend: undefined as CapturedOnSend | undefined,
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
  }),
}));

vi.mock("./ChatInterface", () => ({
  ChatInput: ({ onSend }: { onSend: CapturedOnSend }) => {
    testState.onSend = onSend;
    return null;
  },
}));

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("Home page composer: thinking level on the new-chat path", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    testState.onSend = undefined;
    vi.clearAllMocks();
    // Defensive: each test consumes what it stashes, but don't let a failed assertion mid-test
    // leak a pending level into another test. Not `sessionStorage.clear()` -- jsdom's Storage
    // implementation here doesn't expose it (see the known-failing homePromptFlow.test.tsx).
    sessionStorage.removeItem("pendingChatThinkingLevel:42");
  });

  it("forwards the picked level to newChat() and hands it off for the created chat", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    expect(testState.onSend).toBeDefined();
    await act(async () => {
      await testState.onSend!("Create a daily brief.", "claude-opus-5", undefined, undefined,
                               undefined, "max");
    });

    // The level reaches the backend on the chat's first turn.
    expect(testState.newChat).toHaveBeenCalledWith(
      "Create a daily brief.", "claude-opus-5", undefined, undefined, undefined, "max");

    // It navigates to the chat newChat() reported (mocked to resolve to 42)...
    expect(testState.navigate).toHaveBeenCalledWith({
      to: "/workspace/$id", params: { id: "gadget-1" }, search: { chat: 42 },
    });

    // ...and stashes the same level for that exact chat id, so the workspace page's ChatInterface
    // (a separate mount with no memory of this component) can pick it up for the chat's second
    // message. Consuming it here proves both the key and the value are right, and that the
    // consume-once contract leaves nothing behind.
    expect(takePendingChatThinkingLevel(42)).toBe("max");
    expect(takePendingChatThinkingLevel(42)).toBeUndefined();
  });

  it("doesn't stash anything when no level was picked (ChatInput always sends one in practice)", async () => {
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent />));

    await act(async () => {
      await testState.onSend!("Create a daily brief.", "claude-opus-5");
    });

    expect(testState.newChat).toHaveBeenCalledWith(
      "Create a daily brief.", "claude-opus-5", undefined, undefined, undefined, undefined);
    expect(takePendingChatThinkingLevel(42)).toBeUndefined();
  });
});
