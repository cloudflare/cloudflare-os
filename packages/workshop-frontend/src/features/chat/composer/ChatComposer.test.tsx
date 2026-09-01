// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
  gatekeeperModalProps: undefined as undefined | {
    open: boolean;
    onCreated: (gatekeeper: unknown) => Promise<void>;
  },
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("../../../AuthContext", () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: {} }),
}));

vi.mock("../../../useVendorBranding", () => ({
  useVendorBranding: () => new Map(),
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

describe("ChatComposer", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    testState.addToast.mockClear();
    testState.gatekeeperModalProps = undefined;
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
        selectedModel="model-a"
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
        selectedModel="model-a"
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
        selectedModel="model-a"
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

  it("requires explicit slash-picker confirmation before sending an exact skill", async () => {
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
        selectedModel="model-a"
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
    });
    await act(async () => vi.waitFor(() => expect(
      document.querySelectorAll('[role="option"]'),
    ).toHaveLength(1)));

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await new Promise(requestAnimationFrame);
    });
    expect(onSend).not.toHaveBeenCalled();

    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      await Promise.resolve();
    });
    expect(onSend).toHaveBeenCalledWith(
      { id: skill.selection, args: "production" },
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
        selectedModel="model-a"
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
});
