// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentHandle, SpaceInfo } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const newWorkspace = vi.fn<(spaceKey?: string) => unknown>();
  const listSpaces = vi.fn<() => Promise<unknown[]>>(async () => []);
  return {
    addToast: vi.fn<(toast: unknown) => void>(),
    authenticatedApi: { listModels, newWorkspace, listSpaces },
    currentUser: { id: "user-a", name: "User A" },
    listModels,
    listSpaces,
    navigate: vi.fn<(options: unknown) => void>(),
    newWorkspace,
    seeds: [] as Array<{ text?: string; nonce?: number }>,
    draftStorageKeys: [] as Array<string | undefined>,
    spacesFlag: false,
    // The flags have not been answered yet, so every flag reads as off.
    flagsLoading: false,
    // The composers mounted so far, and what the one on screen was last rendered with.
    composerMounts: 0,
    composer: null as null | {
      autoFocus?: boolean;
      getOverseer: () => unknown;
      onSend: (
        message: string,
        modelId: string | null,
        capsules?: unknown[],
        attachments?: unknown[],
      ) => Promise<void> | void;
    },
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useNavigate: () => testState.navigate,
}));

vi.mock("@cloudflare/kumo", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@cloudflare/kumo")>()),
  useKumoToastManager: () => ({ add: testState.addToast }),
}));

vi.mock("./AuthContext", () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: testState.authenticatedApi,
    currentUser: testState.currentUser,
  }),
}));

vi.mock("./FeatureFlagsContext", () => ({
  useUiFeatureFlag: () => ({
    enabled: testState.spacesFlag && !testState.flagsLoading,
    loading: testState.flagsLoading,
  }),
}));

vi.mock("./features/chat/composer/ChatComposer", async () => {
  const { useState } = await import("react");
  return {
    ChatComposer: (props: NonNullable<typeof testState.composer> & {
      seedText?: string;
      seedNonce?: number;
      draftStorageKey?: string;
    }) => {
      useState(() => testState.composerMounts++);
      testState.composer = props;
      testState.seeds.push({ text: props.seedText, nonce: props.seedNonce });
      testState.draftStorageKeys.push(props.draftStorageKey);
      return <textarea aria-label="Prompt" readOnly value={props.seedText ?? ""} />;
    },
  };
});

vi.mock("./components/MeshBackground", () => ({ default: () => null }));
vi.mock("./components/AppShell/HomeTaskSuggestions", () => ({ default: () => null }));
vi.mock("./features/deployment-updates/UpdateAvailableNotice", () => ({ UpdateAvailableNotice: () => null }));
vi.mock("./useDocumentTitle", () => ({ useDocumentTitle: () => {} }));

import { HomePageContent } from "./routes/index";
import {
  loadSlashCommandCatalog,
  type OverseerSource,
} from "./components/chat/slash-command-catalog";
import {
  button,
  chooseOption,
  deferred,
  hasButton,
  person,
  personalSpace,
  selectOptions,
  settle,
  teamSpace,
} from "./features/spaces/spacesTestUtils";

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
    testState.composerMounts = 0;
    testState.composer = null;
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
    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(testState.draftStorageKeys).toContain("gadgets:composer-draft:v1:user-a:home");
  });
});

const promptField = () => document.body.querySelector<HTMLTextAreaElement>('[aria-label="Prompt"]')!;

// What the composer does when the user first reaches for the workspace, e.g. to attach a file.
const reachForWorkspace = () => act(async () => { testState.composer!.getOverseer(); });

// What the composer does when its slash command picker opens.
const loadCatalog = () => act(async () => {
  await loadSlashCommandCatalog(testState.composer!.getOverseer as OverseerSource);
});

describe("Home space selector", () => {
  const PERSONAL: SpaceInfo = {
    key: "~user-a",
    name: "User A",
    kind: "personal",
    owner: { type: "user", id: "user-a", name: "User A" },
    role: "admin",
  };
  // Another person's personal space the user is a member of: only its owner adds workspaces to it.
  const ADAS = personalSpace(person("ada@example.com", "Ada"), "build");
  const DESIGN = teamSpace("design", "Design", "use");
  const PLATFORM = teamSpace("platform", "Platform");

  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    document.body.innerHTML = "";
    localStorage.clear();
    testState.seeds.length = 0;
    testState.draftStorageKeys.length = 0;
    testState.spacesFlag = false;
    testState.flagsLoading = false;
    testState.composerMounts = 0;
    testState.composer = null;
    vi.resetAllMocks();
    testState.listModels.mockImplementation(async () => []);
    testState.listSpaces.mockImplementation(async () => []);
  });

  // The home page for a user with these spaces. `created` holds every workspace `newGadget`
  // makes, in order.
  const renderHome = async (
    { spaces = [PERSONAL, DESIGN, PLATFORM], spacesFlag = true, space, prompt }: {
      spaces?: SpaceInfo[] | Promise<SpaceInfo[]>;
      spacesFlag?: boolean;
      space?: string;
      prompt?: string;
    } = {},
  ) => {
    testState.spacesFlag = spacesFlag;
    // A session of its own: the list of spaces is kept per session.
    testState.authenticatedApi = { ...testState.authenticatedApi };
    testState.listSpaces.mockImplementation(async () => spaces);
    const created: Array<{
      newChat: ReturnType<typeof vi.fn<() => Promise<number>>>;
      getMetadata: () => Promise<{ id: string }>;
      listSlashCommands: ReturnType<typeof vi.fn<() => Promise<never[]>>>;
      dispose: ReturnType<typeof vi.fn<() => void>>;
    }> = [];
    testState.newGadget.mockImplementation(() => {
      const dispose = vi.fn<() => void>();
      const id = `w${created.length}`;
      const workspace = {
        newChat: vi.fn<() => Promise<number>>(async () => 1),
        getMetadata: async () => ({ id }),
        listSlashCommands: vi.fn<() => Promise<never[]>>(async () => []),
        dispose,
        [Symbol.dispose]: dispose,
      };
      created.push(workspace);
      return workspace;
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root!.render(<HomePageContent space={space} prompt={prompt} />));
    await settle();
    return { created };
  };

  it("is absent, asks for no spaces and creates in the personal space while the flag is off", async () => {
    await renderHome({ spacesFlag: false, space: "platform" });

    expect(hasButton("Space")).toBe(false);
    expect(testState.listSpaces).not.toHaveBeenCalled();
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[]]);
  });

  it("is absent while the user has no team space", async () => {
    await renderHome({ spaces: [PERSONAL, ADAS] });

    expect(hasButton("Space")).toBe(false);
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[]]);
  });

  it("offers the personal space and each team space, starting on the personal one", async () => {
    await renderHome({ spaces: [PERSONAL, ADAS, DESIGN, PLATFORM] });

    expect(button("Space").textContent).toBe("Personal");
    expect((await selectOptions("Space")).map((option) => option.textContent))
      .toEqual(["Personal", "Design", "Platform"]);
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[]]);
  });

  it("starts on the team space the space parameter names, and creates the workspace in it", async () => {
    await renderHome({ space: "platform" });

    expect(button("Space").textContent).toBe("Platform");
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([["platform"]]);
  });

  it("starts on the personal space when the parameter names a space the user is not in", async () => {
    await renderHome({ space: "elsewhere" });

    expect(button("Space").textContent).toBe("Personal");
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[]]);
  });

  it("keeps the space parameter when it clears the prompt from the route", async () => {
    await renderHome({ space: "platform", prompt: "Create a daily brief." });

    expect(testState.navigate)
      .toHaveBeenCalledWith({ to: "/", search: { space: "platform" }, replace: true });
  });

  it("clears the space parameter with the prompt while the flag is off", async () => {
    await renderHome({ spacesFlag: false, space: "platform", prompt: "Create a daily brief." });

    expect(testState.navigate).toHaveBeenCalledWith({ to: "/", search: {}, replace: true });
  });

  it("waits for the flag before it clears a prompt that came with a space parameter", async () => {
    testState.flagsLoading = true;
    await renderHome({ space: "platform", prompt: "Create a daily brief." });

    expect(testState.navigate).not.toHaveBeenCalled();
    expect(promptField().value).toBe("");

    testState.flagsLoading = false;
    await act(async () => root!.render(
      <HomePageContent space="platform" prompt="Create a daily brief." />));

    expect(promptField().value).toBe("Create a daily brief.");
    expect(testState.navigate)
      .toHaveBeenCalledWith({ to: "/", search: { space: "platform" }, replace: true });
  });

  it("disposes the workspace already created when the space changes, and creates the next in the new one", async () => {
    const { created } = await renderHome();
    await reachForWorkspace();

    await chooseOption("Space", "Design");

    expect(button("Space").textContent).toBe("Design");
    expect(created[0].dispose).toHaveBeenCalledOnce();
    // The composer starts afresh, without what it made in the disposed workspace, and leaves
    // focus with the selector.
    expect(testState.composerMounts).toBe(2);
    expect(testState.composer!.autoFocus).toBe(false);

    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[], ["design"]]);

    await chooseOption("Space", "Personal");
    await reachForWorkspace();
    expect(created[1].dispose).toHaveBeenCalledOnce();
    expect(testState.newGadget.mock.calls).toEqual([[], ["design"], []]);

    await act(async () => root?.unmount());
    root = undefined;
    expect(created.map(({ dispose }) => dispose.mock.calls.length)).toEqual([1, 1, 1]);
  });

  it("disposes a workspace created before the list of spaces arrived, once the parameter takes effect", async () => {
    const list = deferred<SpaceInfo[]>();
    const { created } = await renderHome({ space: "platform", spaces: list.promise });

    expect(hasButton("Space")).toBe(false);
    await reachForWorkspace();
    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();

    expect(button("Space").textContent).toBe("Platform");
    expect(created[0].dispose).toHaveBeenCalledOnce();
    // The user chose nothing, so the composer that starts afresh takes focus back.
    expect(testState.composerMounts).toBe(2);
    expect(testState.composer!.autoFocus).toBe(true);
    await reachForWorkspace();
    expect(testState.newGadget.mock.calls).toEqual([[], ["platform"]]);
  });

  it("holds a send made before the list of spaces arrived, and creates the workspace in the space the parameter names", async () => {
    const list = deferred<SpaceInfo[]>();
    await renderHome({ space: "platform", spaces: list.promise });

    let sent: Promise<void> | void;
    await act(async () => { sent = testState.composer!.onSend("Hello", null); });
    expect(testState.newGadget).not.toHaveBeenCalled();

    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();
    await act(async () => { await sent; });

    expect(testState.newGadget.mock.calls).toEqual([["platform"]]);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  it("holds a send made before the flags arrived, and creates the workspace in the space the parameter names", async () => {
    testState.flagsLoading = true;
    await renderHome({ space: "platform" });

    let sent: Promise<void> | void;
    await act(async () => { sent = testState.composer!.onSend("Hello", null); });
    expect(testState.newGadget).not.toHaveBeenCalled();

    testState.flagsLoading = false;
    await act(async () => root!.render(<HomePageContent space="platform" />));
    await settle();
    await act(async () => { await sent; });

    expect(testState.newGadget.mock.calls).toEqual([["platform"]]);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  it("sends at once in a workspace the composer reached for before the list of spaces arrived", async () => {
    const list = deferred<SpaceInfo[]>();
    const { created } = await renderHome({ space: "platform", spaces: list.promise });

    await reachForWorkspace();
    await act(async () => { await testState.composer!.onSend("Hello", null); });

    expect(testState.newGadget.mock.calls).toEqual([[]]);
    expect(created[0].newChat).toHaveBeenCalledOnce();
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  // A send begun in a workspace the composer reached for before the list of spaces arrived,
  // and so created in the personal space. The list, with the space the link asks for, arrives
  // while the send is in flight; `settleSend` then answers the send.
  const sendThenListArrives = async (attachments?: ChatAttachmentHandle[]) => {
    const list = deferred<SpaceInfo[]>();
    const { created } = await renderHome({ space: "platform", spaces: list.promise });
    await reachForWorkspace();
    let settleSend!: { resolve: (chat: number) => void; reject: (err: Error) => void };
    created[0].newChat.mockImplementationOnce(() => new Promise<number>((resolve, reject) => {
      settleSend = { resolve, reject };
    }));
    let sent!: Promise<void> | void;
    await act(async () => {
      sent = testState.composer!.onSend("Hello", null, undefined, attachments);
    });
    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();
    return { created, sent, settleSend };
  };

  describe("while a send is in flight", () => {
    it("keeps the workspace and the composer, and offers no other space", async () => {
      const { created, sent, settleSend } = await sendThenListArrives();

      expect(button("Space").disabled).toBe(true);
      expect(created[0].dispose).not.toHaveBeenCalled();
      expect(testState.composerMounts).toBe(1);

      await act(async () => {
        settleSend.resolve(1);
        await sent;
      });
      expect(testState.navigate).toHaveBeenCalledExactlyOnceWith(
        { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
      expect(created[0].dispose).toHaveBeenCalledOnce();
      expect(testState.newGadget.mock.calls).toEqual([[]]);
    });

    it("applies a space that changed meanwhile once the send has failed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { created, sent, settleSend } = await sendThenListArrives([{ id: "attachment-1" }]);

      await act(async () => {
        settleSend.reject(new Error("boom"));
        await expect(sent).rejects.toThrow("boom");
      });

      // The workspace was kept for a retry, in a space that is no longer the one selected.
      expect(button("Space").disabled).toBe(false);
      expect(created[0].dispose).toHaveBeenCalledOnce();
      expect(testState.composerMounts).toBe(2);
      await reachForWorkspace();
      expect(testState.newGadget.mock.calls).toEqual([[], ["platform"]]);
    });
  });

  it("leaves the composer as it is when the space changes before any workspace exists", async () => {
    await renderHome();

    await chooseOption("Space", "Platform");

    expect(testState.newGadget).not.toHaveBeenCalled();
    expect(testState.composerMounts).toBe(1);
    expect(testState.composer!.autoFocus).toBe(true);
  });

  it("starts the composer afresh without the prompt it was seeded with", async () => {
    await renderHome({ prompt: "Create a daily brief." });
    expect(promptField().value).toBe("Create a daily brief.");

    await reachForWorkspace();
    await chooseOption("Space", "Design");

    // The seed would overwrite the draft the new composer restores.
    expect(testState.composerMounts).toBe(2);
    expect(testState.seeds.at(-1)).toEqual({ text: undefined, nonce: undefined });
  });

  it("keeps the chosen space, and the workspace created in it, through a replaced session", async () => {
    const { created } = await renderHome();
    await chooseOption("Space", "Platform");
    await reachForWorkspace();

    // A session that replaces this one, as a reconnect does, knows neither its flags nor its
    // spaces at first.
    const list = deferred<SpaceInfo[]>();
    testState.authenticatedApi = { ...testState.authenticatedApi };
    testState.listSpaces.mockImplementation(() => list.promise);
    testState.flagsLoading = true;
    await act(async () => root!.render(<HomePageContent />));
    await settle();
    expect(button("Space").textContent).toBe("Platform");

    testState.flagsLoading = false;
    await act(async () => root!.render(<HomePageContent />));
    await settle();
    expect(button("Space").textContent).toBe("Platform");

    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();
    expect(button("Space").textContent).toBe("Platform");
    expect(created[0].dispose).not.toHaveBeenCalled();
    expect(testState.composerMounts).toBe(1);
  });

  it("creates a workspace in the chosen space while a session that replaced another has no list yet", async () => {
    await renderHome();
    await chooseOption("Space", "Platform");

    testState.authenticatedApi = { ...testState.authenticatedApi };
    testState.listSpaces.mockImplementation(() => new Promise<SpaceInfo[]>(() => {}));
    testState.flagsLoading = true;
    await act(async () => root!.render(<HomePageContent />));
    await act(async () => { await testState.composer!.onSend("Hello", null); });

    expect(testState.newGadget.mock.calls).toEqual([["platform"]]);
  });

  it("reads the slash commands again from the workspace that replaces a disposed one", async () => {
    const { created } = await renderHome();

    await loadCatalog();
    await chooseOption("Space", "Design");
    await loadCatalog();

    expect(created[0].listSlashCommands).toHaveBeenCalledOnce();
    expect(created[1].listSlashCommands).toHaveBeenCalledOnce();
  });

  it("disposes a workspace kept for a retry when the space changes", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { created } = await renderHome({ space: "platform" });
    const attachments: ChatAttachmentHandle[] = [{ id: "attachment-1" }];

    await reachForWorkspace();
    created[0].newChat.mockRejectedValueOnce(new Error("boom"));
    await act(async () => {
      await expect(testState.composer!.onSend("Hello", null, undefined, attachments))
        .rejects.toThrow("boom");
    });
    // The attachment lives in the workspace, so it is kept for the retry.
    expect(created[0].dispose).not.toHaveBeenCalled();

    await chooseOption("Space", "Design");
    expect(created[0].dispose).toHaveBeenCalledOnce();

    await act(async () => { await testState.composer!.onSend("Hello", null); });
    expect(testState.newGadget.mock.calls).toEqual([["platform"], ["design"]]);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w1" }, search: { chat: 1 } });
    expect(created[1].dispose).toHaveBeenCalledOnce();
  });
});
