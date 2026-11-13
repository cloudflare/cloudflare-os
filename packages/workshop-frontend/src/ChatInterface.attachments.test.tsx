// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import {act} from "react";
import {afterEach, beforeEach, expect, it, vi} from "vitest";
import type {AiChatMessage, AiChatSubscriber, ChatAttachmentRef} from "@gadgets/workshop-shared/api";
import {flushFrames, makeOverseer, makeTestRoot} from "./action-test-harness";
import ChatInterface from "./ChatInterface";

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({currentUser: null}), useOptionalAuthenticatedApi: () => null,
}));
vi.mock("./features/notifications/UnreadStateBridge", async importOriginal => ({
  ...await importOriginal<typeof import("./features/notifications/UnreadStateBridge")>(),
  useUnreadState: () => null,
}));
vi.mock("@cloudflare/kumo", async importOriginal => ({
  ...await importOriginal<typeof import("@cloudflare/kumo")>(),
  useKumoToastManager: () => ({add: () => {}}),
}));

const root = makeTestRoot();
Element.prototype.scrollTo = () => {};
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", class {observe() {} disconnect() {}});
  let nextUrl = 0;
  vi.stubGlobal("URL", class extends URL {
    static createObjectURL = vi.fn<typeof URL.createObjectURL>(() => `blob:attachment-${++nextUrl}`);
    static revokeObjectURL = vi.fn<typeof URL.revokeObjectURL>();
  });
});
afterEach(() => {root.cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals();});

const image = (id: string): ChatAttachmentRef => ({
  id, name: `${id}.png`, mimeType: "image/png", size: 4, content: Uint8Array.of(137, 80, 78, 71),
});

async function setup() {
  const server = makeOverseer();
  let subscriber: AiChatSubscriber;
  const download = vi.fn<(chatId: number, id: string) => Promise<Uint8Array>>(
    async () => Uint8Array.of(0, 255, 128));
  Object.assign(server.overseer, {
    listChats: async () => [{id: 1, title: "Generated files", started: new Date(), lastActive: new Date()}],
    listModels: async () => [], getChatHistory: async () => ({messages: []}),
    getChatAttachmentContent: download, onRpcBroken: () => {},
    viewChat: () => ({[Symbol.dispose]: () => {}}),
    subscribeToChat: (next: AiChatSubscriber) => {subscriber = next; return {[Symbol.dispose]: () => {}};},
  });
  await root.render(<ChatInterface workspaceId="workspace" overseer={server.overseer}
    selectedChatId={1} onNavigateToChat={() => {}} pendingConsoleLogCount={0}
    consoleLogPreview="" consoleLogSeverity="info" onConsumeConsoleLogs={() => ""}
    onDiscardConsoleLogs={() => {}} onOpenGadget={() => {}} outputOfWorkpiece={() => undefined} />);
  return {
    download,
    message: async (sequence: number, attachments: ChatAttachmentRef[]) => {
      const msg: AiChatMessage = {type: "message", chatId: 1, sequence, timestamp: new Date(),
        author: {type: "agent", id: "model", name: "Model"}, message: "", attachments,
        toolCalls: [{toolCallId: `attach-${sequence}`, toolName: "attachFile",
          input: {worktree: "SCRATCH", path: attachments[0].name!}, output: attachments[0]}]};
      await act(async () => {subscriber.message(msg); flushFrames();});
    },
  };
}

it("shows attachment-only assistant messages inline instead of hiding them in tool rows", async () => {
  const view = await setup();
  await view.message(0, [image("original")]);
  const first = document.querySelector('[aria-label="Preview original.png"]')!.parentElement!.querySelector("img")!;
  expect(first.getAttribute("src")).toBe("blob:attachment-1");
  await view.message(1, [image("cyan")]);
  expect(document.querySelectorAll('[aria-label^="Preview "]')).toHaveLength(2);
  expect(document.querySelector('[aria-label="Preview original.png"]')!.parentElement!.querySelector("img")).toBe(first);
  expect(document.querySelector('[aria-label="Preview cyan.png"]')!.parentElement!.querySelector("img")!.getAttribute("src")).toBe("blob:attachment-2");
  expect(view.download).not.toHaveBeenCalled();
  root.unmount();
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:attachment-1");
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:attachment-2");
});

it("downloads assistant binary files through the authenticated chat attachment API", async () => {
  const view = await setup();
  await view.message(0, [{id: "binary", name: "result.bin", mimeType: "application/octet-stream", size: 3}]);
  await act(async () => {document.querySelector<HTMLButtonElement>('[aria-label="Preview result.bin"]')!.click();});
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function(this: HTMLAnchorElement) {
    expect(this.download).toBe("result.bin");
    expect(this.href).toBe("blob:attachment-1");
  });
  await act(async () => {
    document.querySelector<HTMLButtonElement>('[aria-label="Download"]')!.click();
  });
  expect(view.download).toHaveBeenCalledExactlyOnceWith(1, "binary");
  expect(click).toHaveBeenCalledTimes(1);
});
