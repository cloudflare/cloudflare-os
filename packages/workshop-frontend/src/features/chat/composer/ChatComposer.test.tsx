// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";

type TestToast = {
  title: string;
  description?: string;
  variant: string;
  timeout?: number;
  actions?: { children: string; onClick: () => void }[];
};

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: TestToast) => string>(() => "toast-1"),
  closeToast: vi.fn<(toastId?: string) => void>(),
  gatekeeperModalProps: undefined as undefined | {
    open: boolean;
    onCreated: (gatekeeper: unknown) => Promise<void>;
    initialVendorId?: string;
    initialResourceUrl?: string;
    initialResourceUrlPattern?: string;
    initialAccountId?: number;
  },
  capsuleOverlayProps: undefined as undefined | {
    url: string;
    onSelectAccount: (accountId: number, vendorId: string, resource: { urlPattern: string }) => void;
  },
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast, close: testState.closeToast }),
}));

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));

vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
}));

vi.mock("../../../CapsuleOverlay", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../CapsuleOverlay")>()),
  default: (props: typeof testState.capsuleOverlayProps) => {
    testState.capsuleOverlayProps = props;
    return null;
  },
}));

vi.mock("../../../GatekeeperModal", () => ({
  default: (props: typeof testState.gatekeeperModalProps) => {
    testState.gatekeeperModalProps = props;
    return null;
  },
}));

import { ChatComposer } from "./ChatComposer";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
Element.prototype.scrollIntoView ??= () => {};

class TestResizeObserver {
  observe() {}
  disconnect() {}
}

vi.stubGlobal("ResizeObserver", TestResizeObserver);

const typeText = async (textarea: HTMLTextAreaElement, text: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
      textarea,
      text,
    );
    textarea.setSelectionRange(text.length, text.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
    await new Promise(requestAnimationFrame);
  });
};

describe("ChatComposer", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    testState.addToast.mockClear();
    testState.closeToast.mockClear();
    testState.gatekeeperModalProps = undefined;
    testState.capsuleOverlayProps = undefined;
  });

  it("sends on Enter without clearing document changes made while sending", async () => {
    let finishSend: (() => void) | undefined;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(
      () => new Promise<void>((resolve) => { finishSend = resolve; }),
    );
    const overseer = {} as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "  Build a dashboard  ",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(onSend).toHaveBeenCalledWith(
      "Build a dashboard",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
    expect(textarea.disabled).toBe(false);

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Next question",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => finishSend!());
    expect(textarea.value).toBe("Next question");
    expect(textarea.disabled).toBe(false);
    expect(testState.addToast).not.toHaveBeenCalled();
  });

  it.each([
    { error: new Error("Peer closed WebSocket"), transient: true },
    { error: new Error("send rejected"), transient: false },
  ])("preserves the draft after a failed send", async ({ error, transient }) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>(async () => {
      throw error;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        chatKey={7}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "Keep this draft",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    expect(textarea.value).toBe("Keep this draft");
    expect(container.textContent?.includes("Connection hiccup")).toBe(transient);
    expect(consoleError).toHaveBeenCalledTimes(transient ? 0 : 1);
    consoleError.mockRestore();
  });

  describe("while the agent works", () => {
    type ComposerProps = Parameters<typeof ChatComposer>[0];

    const mountRoot = () => {
      container = document.createElement("div");
      document.body.append(container);
      root = createRoot(container);
    };
    const render = (props: Partial<ComposerProps>) => act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        chatKey={7}
        draftStorageKey="draft:chat-7"
        {...props}
      />,
    ));
    const textarea = () => container!.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const button = (label: string) =>
      container!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    const pressEnter = () => act(async () => {
      textarea().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });

    it("steers on Enter, and keeps Stop disabled while the steer sends", async () => {
      let finishSend: (() => void) | undefined;
      const onSend = vi.fn<ComposerProps["onSend"]>(
        () => new Promise<void>((resolve) => { finishSend = resolve; }),
      );
      mountRoot();
      await render({ onSend, onStop: async () => {} });

      await typeText(textarea(), "Make it dark.");
      await pressEnter();
      expect(onSend).toHaveBeenCalledWith("Make it dark.", "model-a", undefined, undefined, undefined);
      expect(button("Stop agent")!.disabled).toBe(true);
      await act(async () => finishSend!());
      expect(textarea().value).toBe("");
      expect(button("Stop agent")!.disabled).toBe(false);
    });

    it("puts the dropped steers after the draft, and steers nothing until the agent is idle",
        async () => {
      const onSend = vi.fn<ComposerProps["onSend"]>();
      const onStop = vi.fn<() => Promise<void>>(async () => {});
      mountRoot();
      await render({ onSend, onStop, queuedSteers: ["A"] });

      await typeText(textarea(), "Half a thought  ");
      expect(button("Send message")).not.toBeNull();
      await act(async () => button("Stop agent")!.click());
      expect(onStop).toHaveBeenCalledOnce();
      expect(textarea().value).toBe("Half a thought\n\nA");
      expect(button("Stop agent")!.disabled).toBe(true);
      expect(button("Send message")).toBeNull();
      await pressEnter();
      expect(onSend).not.toHaveBeenCalled();

      await render({ onSend, onStop, queuedSteers: [], isAgentActive: false });
      await pressEnter();
      expect(onSend).toHaveBeenCalledWith("Half a thought\n\nA", "model-a", undefined, undefined, undefined);
    });

    it("keeps the dropped steers in the draft when Stop fails", async () => {
      let failStop: ((err: Error) => void) | undefined;
      const onStop = vi.fn<() => Promise<void>>(
        () => new Promise<void>((_, reject) => { failStop = reject; }),
      );
      mountRoot();
      await render({ onStop, queuedSteers: ["A"] });
      await typeText(textarea(), "Draft");

      await act(async () => button("Stop agent")!.click());
      expect(button("Stop agent")!.disabled).toBe(true);
      await act(async () => failStop!(new Error("Peer closed WebSocket")));
      expect(textarea().value).toBe("Draft\n\nA");
      expect(button("Stop agent")!.disabled).toBe(false);
    });
  });

  it("keeps add-menu actions enabled after inserting a skill and removes the legacy button", async () => {
    const skill = {
      selection: { gatekeeperId: 42, commandId: "review" },
      name: "review",
      description: "Review the current project.",
      providerLabel: "Projects",
    };
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
        attachLabel="Legacy resource"
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "before after",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    textarea.setSelectionRange(7, 7);
    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(
      Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
        .some((option) => option.textContent?.includes("review")),
    ).toBe(true)));
    const skillOption = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("review"))!;
    await act(async () => {
      skillOption.click();
      await new Promise(requestAnimationFrame);
    });

    expect(textarea.value).toBe("before /review after");
    expect(document.body.textContent)
      .toContain("Slash command /review from Projects is ready to send");
    expect(document.activeElement).toBe(textarea);

    await act(async () => add.click());
    const actions = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
    expect(actions).toHaveLength(2);
    expect(actions.every((action) => !action.disabled)).toBe(true);
    expect(document.querySelector('[aria-label="Search skills"]')).toBeNull();
    expect(container.textContent).not.toContain("Add resource");
    expect(container.textContent).not.toContain("Legacy resource");
    const connection = actions.find((action) => action.textContent?.includes("Add a new connection"))!;
    await act(async () => connection.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);
    expect(listSlashCommands).toHaveBeenCalledTimes(1);
  });

  it("sends unconfirmed slash text as plain text", async () => {
    const skill: SlashCommandChoice = {
      selection: { gatekeeperId: 42, commandId: "deploy" },
      name: "deploy",
      description: "Deploy the current project.",
      providerLabel: "Projects",
    };
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => [skill]),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "/deploy production",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      "/deploy production",
      "model-a",
      undefined,
      undefined,
      undefined,
    );
  });

  it("sends double slash as literal text without opening the skill picker", async () => {
    const overseer = {
      listSlashCommands: vi.fn<() => Promise<SlashCommandChoice[]>>(async () => []),
    } as unknown as RpcStub<Overseer>;
    const onSend = vi.fn<Parameters<typeof ChatComposer>[0]["onSend"]>();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={onSend}
        isAgentActive={false}
        models={[]}
        selectedModel={null}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(
        textarea,
        "//deploy literally",
      );
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    expect(overseer.listSlashCommands).not.toHaveBeenCalled();
    expect(onSend).toHaveBeenCalledWith(
      "//deploy literally", null, undefined, undefined, undefined,
    );
  });

  it("invalidates and refetches skills after adding a connection", async () => {
    const firstSkill = {
      selection: { gatekeeperId: 1, commandId: "first" },
      name: "first skill",
      description: "Initially connected.",
      providerLabel: "Tools",
    };
    const nextSkill = {
      ...firstSkill,
      selection: { gatekeeperId: 2, commandId: "next" },
      name: "new connection skill",
    };
    let catalog = [firstSkill];
    const listSlashCommands = vi.fn<() => Promise<SlashCommandChoice[]>>(async () => catalog);
    const overseer = { listSlashCommands } as unknown as RpcStub<Overseer>;
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={async () => null}
        getOverseer={() => overseer}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const add = container.querySelector<HTMLButtonElement>('[aria-label="Add to conversation"]')!;
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent).toContain("first skill")));
    const connect = Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'))
      .find((option) => option.textContent?.includes("Add a new connection"))!;
    await act(async () => connect.click());
    expect(testState.gatekeeperModalProps?.open).toBe(true);

    catalog = [firstSkill, nextSkill];
    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Project", url: "https://example.com/project" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "example" }),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const resourceEnd = textarea.value.indexOf("Project") + "Project".length;
    textarea.setSelectionRange(resourceEnd, resourceEnd);
    await act(async () => textarea.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Backspace", bubbles: true }),
    ));
    await act(async () => add.click());
    await act(async () => vi.waitFor(() => expect(document.body.textContent)
      .toContain("new connection skill")));
    expect(listSlashCommands).toHaveBeenCalledTimes(2);
  });

  const url = "https://docs.google.com/spreadsheets/d/abc123/edit";
  const reason = "This file is an Office file rather than a Google Sheets file.";

  // Pastes `url` after "Summarize ", picks account 4 for it, and has the connection fail.
  const pasteFailingUrl = async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    // jsdom has no Range layout; the URL panel measures the line its URL sits on.
    Range.prototype.getBoundingClientRect = () => new DOMRect();
    onTestFinished(() => {
      delete (Range.prototype as Partial<Range>).getBoundingClientRect;
    });
    const createCapsuleGatekeeper = vi.fn<
      Parameters<typeof ChatComposer>[0]["createCapsuleGatekeeper"]
    >(async () => {
      throw new Error(reason);
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(
      <ChatComposer
        createCapsuleGatekeeper={createCapsuleGatekeeper}
        getOverseer={() => ({} as RpcStub<Overseer>)}
        onSend={() => {}}
        isAgentActive={false}
        models={[]}
        selectedModel={{ id: "model-a" }}
        onModelChange={() => {}}
      />,
    ));

    const textarea = container.querySelector<HTMLTextAreaElement>('[role="combobox"]')!;
    const text = `Summarize ${url}`;
    await typeText(textarea, text);
    expect(testState.capsuleOverlayProps?.url).toBe(url);

    await act(async () => testState.capsuleOverlayProps!.onSelectAccount(
      4,
      "google",
      { urlPattern: "https://docs.google.com/spreadsheets/d/*" },
    ));
    await act(async () => vi.waitFor(() => expect(testState.addToast).toHaveBeenCalledOnce()));
    consoleError.mockRestore();

    expect(createCapsuleGatekeeper).toHaveBeenCalledWith(4, url);
    return { textarea, toast: testState.addToast.mock.calls[0][0] };
  };

  it("offers to configure a pasted URL that could not be connected, then replaces it", async () => {
    const { textarea, toast } = await pasteFailingUrl();

    expect(toast).toMatchObject({
      title: "Failed to add resource",
      description: reason,
      variant: "error",
      timeout: 0,
    });
    expect(toast.actions?.map((action) => action.children)).toEqual(["Configure…"]);
    expect(testState.gatekeeperModalProps?.open).toBe(false);

    act(() => toast.actions![0].onClick());

    expect(testState.closeToast).toHaveBeenCalledWith("toast-1");
    expect(testState.gatekeeperModalProps).toMatchObject({
      open: true,
      initialVendorId: "google",
      initialResourceUrl: url,
      initialResourceUrlPattern: "https://docs.google.com/spreadsheets/d/*",
      initialAccountId: 4,
    });

    const gatekeeper = {
      getId: async () => 9,
      describe: async () => ({ title: "Budget", url: "https://docs.google.com/spreadsheets/d/copy" }),
      getCreationSpec: async () => ({ type: "gatekeeper", vendorId: "google" }),
      remove: vi.fn<() => Promise<void>>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    };
    await act(async () => {
      await testState.gatekeeperModalProps!.onCreated(gatekeeper);
      await new Promise(requestAnimationFrame);
    });

    expect(textarea.value).toBe("Summarize Budget ");
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(testState.gatekeeperModalProps?.open).toBe(false);
    expect(testState.gatekeeperModalProps?.initialResourceUrl).toBeUndefined();
  });

  it("closes its Configure… toast when the composer unmounts", async () => {
    const { toast } = await pasteFailingUrl();
    expect(toast.actions?.map((action) => action.children)).toEqual(["Configure…"]);
    expect(testState.closeToast).not.toHaveBeenCalled();

    act(() => root!.unmount());
    root = undefined;

    expect(testState.closeToast).toHaveBeenCalledExactlyOnceWith("toast-1");
  });

  it("reports a URL gone before Configure with a toast that times out as usual", async () => {
    const { textarea, toast } = await pasteFailingUrl();
    await typeText(textarea, "Summarize nothing");

    act(() => toast.actions![0].onClick());

    expect(testState.gatekeeperModalProps?.open).toBe(false);
    expect(testState.addToast).toHaveBeenCalledTimes(2);
    const changed = testState.addToast.mock.calls[1][0];
    expect(changed).toMatchObject({
      title: "The prompt changed before the resource could be added",
      variant: "error",
    });
    expect(changed.timeout).toBeUndefined();
    expect(changed.actions).toBeUndefined();
  });
});
