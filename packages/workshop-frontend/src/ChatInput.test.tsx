// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentHandle, Overseer } from "@gadgets/workshop-shared/api";
import { ChatInput } from "./ChatInput";
import { readComposerDraft, writeComposerDraft } from "./composerDraft";

const mocks = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  formatIcon: vi.fn<() => Promise<string | undefined>>(async () => undefined),
}));

// Keep menu items inline: these tests cover composer callbacks, not portal positioning.
vi.mock("@cloudflare/kumo", () => {
  const childrenOnly = ({ children }: { children?: ReactNode }) => children;
  return {
    Tooltip: childrenOnly,
    useKumoToastManager: () => ({ add: mocks.addToast }),
    Button: ({ variant: _variant, shape: _shape, ...props }: ComponentProps<"button"> & {
      variant?: string; shape?: string;
    }) => <button {...props} />,
    DropdownMenu: Object.assign(childrenOnly, {
      Trigger: ({ render }: { render: ReactNode }) => render,
      Content: childrenOnly,
      Item: (props: ComponentProps<"button">) => <button {...props} />,
    }),
  };
});
vi.mock("./AuthContext", () => ({ useAuthenticatedApi: () => ({ authenticatedApi: {} }) }));
vi.mock("./useVendorBranding", () => ({ useVendorBranding: () => new Map() }));
vi.mock("./errorReporting", () => ({ reportIssue: vi.fn<() => void>() }));
vi.mock("./CapsuleOverlay", () => ({ default: () => null, CAPSULE_OVERLAY_GAP: 8 }));
vi.mock("./components/chat/SlashCommandPicker", () => ({
  useSlashCommandPicker: () => ({ open: false, popup: null, status: "" }),
}));
vi.mock("./components/format/formatIconImage", () => ({ formatIconDataUrl: mocks.formatIcon }));
vi.mock("./components/format/ComposerFormatMenuItems", () => ({
  default: ({ onSelect }: ComponentProps<typeof import("./components/format/ComposerFormatMenuItems").default>) => (
    <button onClick={() => onSelect({
      blueprintId: "test-document", description: "A test document", requiresSetup: false,
      output: { id: "document", noun: "Document", plural: "Documents", icon: "fileText" },
    })}>Document</button>
  ),
}));
vi.mock("./GatekeeperModal", () => ({
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) => open
    ? <dialog open aria-label="Resources"><button onClick={onClose}>Close resources</button></dialog>
    : null,
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type Props = ComponentProps<typeof ChatInput>;

describe("extracted ChatInput runtime", () => {
  let container: HTMLDivElement;
  let root: Root | undefined;
  let props: Props;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("ResizeObserver", class {
      observe() {}
      disconnect() {}
    });
    vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Unexpected network request"); }));
    container = document.createElement("div");
    document.body.append(container);
    props = {
      createCapsuleGatekeeper: vi.fn<Props["createCapsuleGatekeeper"]>(async () => null),
      getOverseer: vi.fn<Props["getOverseer"]>(() => { throw new Error("Unexpected overseer access"); }),
      onSend: vi.fn<Props["onSend"]>(),
      isAgentActive: false,
      models: [{ type: "agent", id: "model-a", name: "Model A" }],
      selectedModel: "model-a",
      onModelChange: vi.fn<Props["onModelChange"]>(),
      draftStorageKey: "test:composer",
    };
  });

  afterEach(async () => {
    await act(async () => root?.unmount());
    root = undefined;
    container.remove();
    sessionStorage.clear();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  async function render() {
    root ??= createRoot(container);
    await act(async () => root!.render(<ChatInput {...props} />));
  }

  async function frame() {
    await act(async () => { await vi.advanceTimersByTimeAsync(20); });
  }

  const textarea = () => container.querySelector("textarea")!;
  const send = () => container.querySelector<HTMLButtonElement>('[aria-label="Send message"]')!;
  const button = (text: string) => Array.from(container.querySelectorAll("button"))
    .find((element) => !element.hasAttribute("aria-label") && element.textContent === text)!;

  async function edit(value: string) {
    await act(async () => {
      // Bypass React's value tracker so the native input event reaches onChange.
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(textarea(), value);
      textarea().setSelectionRange(value.length, value.length);
      textarea().dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  it("restores a structured draft, persists edits across remount, and clears it after send", async () => {
    writeComposerDraft(props.draftStorageKey, {
      version: 1, text: "Create a Document",
      formats: [{ position: 9, length: 8, noun: "Document", icon: "fileText" }],
    });
    await render();
    await frame();
    expect(textarea().value).toBe("Create a Document");
    expect(textarea().selectionStart).toBe(17);
    expect(container.querySelector("[data-token-start='9']")?.textContent).toBe("Document");

    await edit("Create a Document for Q3");
    expect(readComposerDraft(props.draftStorageKey)?.text).toBe("Create a Document for Q3");
    await act(async () => root!.unmount());
    root = undefined;
    await render();
    await frame();
    expect(textarea().value).toBe("Create a Document for Q3");
    expect(container.querySelector("[data-token-start='9']")?.textContent).toBe("Document");

    await act(async () => send().click());
    expect(props.onSend).toHaveBeenCalledWith("Create a Document for Q3", "model-a", undefined,
      undefined, [{ position: 9, length: 8, noun: "Document", icon: "fileText" }]);
    expect(textarea().value).toBe("");
    expect(readComposerDraft(props.draftStorageKey)).toBeUndefined();
  });

  it("preserves local edits when the authenticated draft key arrives", async () => {
    writeComposerDraft("test:composer", { version: 1, text: "Older draft", formats: [] });
    props.draftStorageKey = undefined;
    await render();
    await edit("Typed before authentication");
    props.draftStorageKey = "test:composer";
    await render();
    await frame();
    expect(textarea().value).toBe("Typed before authentication");
    expect(readComposerDraft(props.draftStorageKey)?.text).toBe("Typed before authentication");
  });

  it("blocks sending during upload and passes the same attachment handle without deleting it", async () => {
    let finishUpload!: (handle: ChatAttachmentHandle) => void;
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(() => new Promise<ChatAttachmentHandle>((resolve) => {
      finishUpload = resolve;
    }));
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>();
    props.getOverseer = vi.fn<Props["getOverseer"]>(() => ({ uploadChatAttachment, deleteChatAttachment }) as unknown as
      Awaited<ReturnType<Props["getOverseer"]>>);
    await render();
    const file = new File(["hello"], "notes.txt", { type: "text/plain" });
    // jsdom's File lacks arrayBuffer; supply bytes locally without changing upload logic.
    Object.defineProperty(file, "arrayBuffer", { value: async () => new TextEncoder().encode("hello").buffer });
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
      Object.defineProperty(input, "files", { value: [file] });
      input.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(uploadChatAttachment).toHaveBeenCalledOnce();
    const [upload, model] = uploadChatAttachment.mock.calls[0];
    expect(upload).toMatchObject({ mimeType: "text/plain", name: "notes.txt" });
    expect(Array.from(upload.content)).toEqual([104, 101, 108, 108, 111]);
    expect(model).toBe("model-a");
    expect(container.textContent).toContain("Uploading");
    expect(send().disabled).toBe(true);
    await act(async () => send().click());
    expect(props.onSend).not.toHaveBeenCalled();

    const handle = { id: "opaque-upload-handle" };
    await act(async () => finishUpload(handle));
    expect(send().disabled).toBe(false);
    await act(async () => send().click());
    expect(props.onSend).toHaveBeenCalledWith("", "model-a", undefined, [handle], undefined);
    expect(vi.mocked(props.onSend).mock.calls[0][3]?.[0]).toBe(handle);
    expect(container.querySelector('[aria-label="Remove attachment"]')).toBeNull();
    await act(async () => root!.unmount());
    root = undefined;
    expect(deleteChatAttachment).not.toHaveBeenCalled();
  });

  it("wires model, format, and resource affordances to the composer", async () => {
    props.offerFormats = true;
    await render();
    expect(container.querySelector('[aria-label="Select model"]')?.textContent).toBe("Model A");
    await act(async () => button("No agent").click());
    expect(props.onModelChange).toHaveBeenCalledWith(null);
    await act(async () => button("Model A").click());
    expect(props.onModelChange).toHaveBeenLastCalledWith("model-a");
    await act(async () => button("Add resource").click());
    expect(container.querySelector("dialog[open]")).not.toBeNull();
    await act(async () => button("Close resources").click());
    expect(container.querySelector("dialog")).toBeNull();
    await act(async () => button("Document").click());
    await frame();
    expect(textarea().value.trim()).toBe("Document");
    expect(container.querySelector("[data-token-start='0']")?.textContent).toBe("Document");
    await act(async () => send().click());
    expect(props.onSend).toHaveBeenCalledWith("Document", "model-a", undefined, undefined,
      [{ position: 0, length: 8, noun: "Document", icon: "fileText" }]);
    expect(props.getOverseer).not.toHaveBeenCalled();
    expect(mocks.addToast).not.toHaveBeenCalled();
  });
});
