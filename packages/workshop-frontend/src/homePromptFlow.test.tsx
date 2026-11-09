// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChatAttachmentHandle, SpaceInfo } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => {
  const listModels = vi.fn<() => Promise<never[]>>(async () => []);
  const newWorkspace = vi.fn<(spaceId?: string) => unknown>();
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
    // The composers mounted so far, and the one on screen: what it was last rendered with, what
    // it holds, and what a test has it do.
    composerMounts: 0,
    composer: null as null | (ComposerProps & {
      attachments: unknown[];
      capsules: unknown[];
      /** Uploads a file to the workspace, and holds the attachment. */
      attach: (name: string) => Promise<void>;
      /** Connects a resource in the workspace, and holds the capsule. */
      connect: (url: string) => Promise<void>;
      /** Sends `message` with what the composer holds. */
      send: (message: string) => Promise<void> | void;
    }),
  };
});

// What the page renders the composer with.
type ComposerProps = {
  autoFocus?: boolean;
  getOverseer: () => unknown;
  createCapsuleGatekeeper: (accountId: number, url: string) => Promise<unknown>;
  onSend: (
    message: string,
    modelId: string | null,
    capsules?: unknown[],
    attachments?: unknown[],
  ) => Promise<void> | void;
  seedText?: string;
  seedNonce?: number;
  draftStorageKey?: string;
};

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
    ChatComposer: (props: ComposerProps) => {
      useState(() => testState.composerMounts++);
      // What the composer made in the workspace is held in the component, as the composer holds
      // its attachments and connections: a composer mounted again has none of it to send.
      const [attachments, setAttachments] = useState<unknown[]>([]);
      const [capsules, setCapsules] = useState<unknown[]>([]);
      testState.composer = {
        ...props,
        attachments,
        capsules,
        attach: async (name) => {
          const workspace = props.getOverseer() as { uploadBlob: () => Promise<string> };
          const oid = await workspace.uploadBlob();
          setAttachments((held) => [...held, { oid, mimeType: "text/plain", name }]);
        },
        connect: async (url) => {
          const gatekeeper = await props.createCapsuleGatekeeper(1, url);
          setCapsules((held) => [...held, { gatekeeper }]);
        },
        send: (message) => props.onSend(message, null, capsules, attachments),
      };
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

// An attachment and a connection the composer makes in the first workspace, which it reaches
// for to make them, and what they leave it holding.
const attachAndConnect = () => act(async () => {
  await testState.composer!.attach("notes.txt");
  await testState.composer!.connect("https://example.com/doc");
});
const ATTACHMENT = { oid: "w0-blob", mimeType: "text/plain", name: "notes.txt" };
const CAPSULE = { gatekeeper: { workspace: "w0", accountId: 1, url: "https://example.com/doc" } };

// A workspace `newWorkspace` made, as a test reads it back.
type CreatedWorkspace = {
  newChat: ReturnType<typeof vi.fn<() => Promise<number>>>;
  moveToSpace: ReturnType<typeof vi.fn<(spaceId: string | null) => Promise<void>>>;
  getMetadata: () => Promise<{ id: string }>;
  listSlashCommands: ReturnType<typeof vi.fn<() => Promise<never[]>>>;
  dispose: ReturnType<typeof vi.fn<() => void>>;
};

// The composer on screen is the one that made the attachment and the connection and holds them
// still, and a send takes them along in `workspace`, where they were made, moved to `spaceId`.
const expectKeptAndSent = async (workspace: CreatedWorkspace, spaceId: string) => {
  expect(testState.composer!.attachments).toEqual([ATTACHMENT]);
  expect(testState.composer!.capsules).toEqual([CAPSULE]);
  expect(testState.composerMounts).toBe(1);
  expect(workspace.dispose).not.toHaveBeenCalled();

  await act(async () => { await testState.composer!.send("Hello"); });

  expect(testState.newWorkspace).toHaveBeenCalledOnce();
  expect(workspace.moveToSpace.mock.calls).toEqual([[spaceId]]);
  expect(workspace.newChat)
    .toHaveBeenCalledExactlyOnceWith("Hello", null, [CAPSULE], [ATTACHMENT], undefined);
  expect(testState.navigate).toHaveBeenCalledExactlyOnceWith(
    { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
};

describe("Home space selector", () => {
  const PERSONAL: SpaceInfo = {
    id: "home-user-a",
    name: "User A",
    kind: "personal",
    owner: { type: "user", id: "user-a", name: "User A" },
    role: "admin",
  };
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

  // The home page for a user with these spaces. `created` holds every workspace `newWorkspace`
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
    const created: CreatedWorkspace[] = [];
    testState.newWorkspace.mockImplementation(() => {
      const dispose = vi.fn<() => void>();
      const id = `w${created.length}`;
      const workspace = {
        newChat: vi.fn<() => Promise<number>>(async () => 1),
        moveToSpace: vi.fn<(spaceId: string | null) => Promise<void>>(async () => {}),
        getMetadata: async () => ({ id }),
        listSlashCommands: vi.fn<() => Promise<never[]>>(async () => []),
        // Each names the workspace it was made in.
        uploadBlob: async () => `${id}-blob`,
        newGatekeeper: async (accountId: number, url: string) => ({ workspace: id, accountId, url }),
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
    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
  });

  it("is absent while the user has no team space", async () => {
    await renderHome({ spaces: [PERSONAL] });

    expect(hasButton("Space")).toBe(false);
    await reachForWorkspace();
    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
  });

  it("offers the personal space and each team space, starting on the personal one", async () => {
    await renderHome();

    expect(button("Space").textContent).toBe("Personal");
    expect((await selectOptions("Space")).map((option) => option.textContent))
      .toEqual(["Personal", "Design", "Platform"]);
    await reachForWorkspace();
    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
  });

  it("starts on the team space the space parameter names, and creates the workspace in it", async () => {
    await renderHome({ space: "platform" });

    expect(button("Space").textContent).toBe("Platform");
    await reachForWorkspace();
    expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
  });

  it("starts on the personal space when the parameter names a space the user is not in", async () => {
    await renderHome({ space: "elsewhere" });

    expect(button("Space").textContent).toBe("Personal");
    await reachForWorkspace();
    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
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

  it("keeps the workspace already created, and the composer, when the space changes, until the page is left", async () => {
    const { created } = await renderHome();
    await reachForWorkspace();

    await chooseOption("Space", "Design");

    expect(button("Space").textContent).toBe("Design");
    expect(created[0].dispose).not.toHaveBeenCalled();
    expect(testState.composerMounts).toBe(1);
    expect(testState.composer!.autoFocus).toBe(true);

    await chooseOption("Space", "Personal");
    await reachForWorkspace();
    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
    // Only a send says which space the workspace is for, so only a send moves it.
    expect(created[0].moveToSpace).not.toHaveBeenCalled();

    await act(async () => root?.unmount());
    root = undefined;
    expect(created[0].dispose).toHaveBeenCalledOnce();
  });

  describe("what the composer made in the workspace", () => {
    it("is kept, and sent, when the user chooses another space", async () => {
      const { created } = await renderHome();
      await attachAndConnect();

      await chooseOption("Space", "Design");

      expect(button("Space").textContent).toBe("Design");
      await expectKeptAndSent(created[0], "design");
    });

    it("is kept, and sent, when it was made before the list of spaces arrived and the parameter then takes effect", async () => {
      const list = deferred<SpaceInfo[]>();
      const { created } = await renderHome({ space: "platform", spaces: list.promise });

      expect(hasButton("Space")).toBe(false);
      await attachAndConnect();
      expect(testState.newWorkspace.mock.calls).toEqual([[]]);
      await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
      await settle();

      expect(button("Space").textContent).toBe("Platform");
      expect(testState.composer!.autoFocus).toBe(true);
      await expectKeptAndSent(created[0], "platform");
    });
  });

  it("holds a send made before the list of spaces arrived, and creates the workspace in the space the parameter names", async () => {
    const list = deferred<SpaceInfo[]>();
    const { created } = await renderHome({ space: "platform", spaces: list.promise });

    let sent: Promise<void> | void;
    await act(async () => { sent = testState.composer!.onSend("Hello", null); });
    expect(testState.newWorkspace).not.toHaveBeenCalled();

    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();
    await act(async () => { await sent; });

    expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
    expect(created[0].moveToSpace).not.toHaveBeenCalled();
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  it("holds a send made before the flags arrived, and creates the workspace in the space the parameter names", async () => {
    testState.flagsLoading = true;
    await renderHome({ space: "platform" });

    let sent: Promise<void> | void;
    await act(async () => { sent = testState.composer!.onSend("Hello", null); });
    expect(testState.newWorkspace).not.toHaveBeenCalled();

    testState.flagsLoading = false;
    await act(async () => root!.render(<HomePageContent space="platform" />));
    await settle();
    await act(async () => { await sent; });

    expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  it("holds a send in a workspace the composer reached for before the list of spaces arrived, and moves it to the space the parameter names", async () => {
    const list = deferred<SpaceInfo[]>();
    const { created } = await renderHome({ space: "platform", spaces: list.promise });

    await reachForWorkspace();
    let sent: Promise<void> | void;
    await act(async () => { sent = testState.composer!.onSend("Hello", null); });
    expect(created[0].moveToSpace).not.toHaveBeenCalled();
    expect(created[0].newChat).not.toHaveBeenCalled();

    await act(async () => list.resolve([PERSONAL, DESIGN, PLATFORM]));
    await settle();
    await act(async () => { await sent; });

    expect(testState.newWorkspace.mock.calls).toEqual([[]]);
    expect(created[0].moveToSpace.mock.calls).toEqual([["platform"]]);
    expect(created[0].newChat).toHaveBeenCalledOnce();
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
  });

  describe("a send in a workspace created for another space", () => {
    it("moves the workspace to the space selected, and starts the chat only once it has moved", async () => {
      const { created } = await renderHome();
      await reachForWorkspace();
      await chooseOption("Space", "Design");
      const moved = deferred<void>();
      created[0].moveToSpace.mockImplementationOnce(() => moved.promise);

      let sent!: Promise<void> | void;
      await act(async () => { sent = testState.composer!.onSend("Hello", null); });
      await settle();
      expect(created[0].moveToSpace.mock.calls).toEqual([["design"]]);
      expect(created[0].newChat).not.toHaveBeenCalled();

      await act(async () => {
        moved.resolve();
        await sent;
      });
      expect(created[0].newChat).toHaveBeenCalledOnce();
      expect(testState.newWorkspace.mock.calls).toEqual([[]]);
      expect(testState.navigate).toHaveBeenCalledExactlyOnceWith(
        { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
    });

    it("moves a workspace created in a team space to the personal space as null", async () => {
      const { created } = await renderHome({ space: "platform" });
      await reachForWorkspace();
      await chooseOption("Space", "Personal");

      await act(async () => { await testState.composer!.onSend("Hello", null); });

      expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
      expect(created[0].moveToSpace.mock.calls).toEqual([[null]]);
      expect(created[0].moveToSpace.mock.invocationCallOrder[0])
        .toBeLessThan(created[0].newChat.mock.invocationCallOrder[0]);
    });

    it("moves nothing when the space selected is back to the one the workspace was created in", async () => {
      const { created } = await renderHome();
      await reachForWorkspace();
      await chooseOption("Space", "Design");
      await chooseOption("Space", "Personal");

      await act(async () => { await testState.composer!.onSend("Hello", null); });

      expect(testState.newWorkspace.mock.calls).toEqual([[]]);
      expect(created[0].moveToSpace).not.toHaveBeenCalled();
      expect(created[0].newChat).toHaveBeenCalledOnce();
    });

    it("moves the workspace once when the send is retried for the same space", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { created } = await renderHome();
      const attachments: ChatAttachmentHandle[] = [{ id: "attachment-1" }];
      await reachForWorkspace();
      await chooseOption("Space", "Design");
      created[0].newChat.mockRejectedValueOnce(new Error("boom"));

      await act(async () => {
        await expect(testState.composer!.onSend("Hello", null, undefined, attachments))
          .rejects.toThrow("boom");
      });
      await act(async () => {
        await testState.composer!.onSend("Hello", null, undefined, attachments);
      });

      expect(created[0].moveToSpace.mock.calls).toEqual([["design"]]);
      expect(created[0].newChat).toHaveBeenCalledTimes(2);
    });

    it("fails when the move fails, keeps what the composer made, and moves again on a retry", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { created } = await renderHome();
      await attachAndConnect();
      await chooseOption("Space", "Design");
      created[0].moveToSpace.mockRejectedValueOnce(new Error("boom"));

      await act(async () => {
        await expect(testState.composer!.send("Hello")).rejects.toThrow("boom");
      });

      expect(testState.addToast).toHaveBeenCalledExactlyOnceWith(
        { title: "Failed to create workspace", description: "boom", variant: "error" });
      expect(created[0].newChat).not.toHaveBeenCalled();
      // The rejection is what has the composer keep its draft, and it is the same composer, in
      // the same workspace, that holds what was made there.
      expect(created[0].dispose).not.toHaveBeenCalled();
      expect(testState.composerMounts).toBe(1);
      expect(testState.composer!.attachments).toEqual([ATTACHMENT]);
      expect(testState.composer!.capsules).toEqual([CAPSULE]);
      expect(button("Space").disabled).toBe(false);

      await act(async () => { await testState.composer!.send("Hello"); });

      expect(created[0].moveToSpace.mock.calls).toEqual([["design"], ["design"]]);
      expect(created[0].newChat)
        .toHaveBeenCalledExactlyOnceWith("Hello", null, [CAPSULE], [ATTACHMENT], undefined);
      expect(testState.newWorkspace).toHaveBeenCalledOnce();
      expect(testState.navigate).toHaveBeenCalledExactlyOnceWith(
        { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
    });
  });

  // A send that moves its workspace, created in the personal space, to the space a link asks
  // for. While it does, the page is asked for another space; the move is then answered, and
  // `settleSend` answers the chat the send starts.
  const sendThenSpaceChanges = async (attachments?: ChatAttachmentHandle[]) => {
    const { created } = await renderHome();
    await reachForWorkspace();
    await act(async () => root!.render(<HomePageContent space="design" />));
    const moved = deferred<void>();
    created[0].moveToSpace.mockImplementationOnce(() => moved.promise);
    let settleSend!: { resolve: (chat: number) => void; reject: (err: Error) => void };
    created[0].newChat.mockImplementationOnce(() => new Promise<number>((resolve, reject) => {
      settleSend = { resolve, reject };
    }));
    let sent!: Promise<void> | void;
    await act(async () => {
      sent = testState.composer!.onSend("Hello", null, undefined, attachments);
    });
    await act(async () => root!.render(<HomePageContent space="platform" />));
    await act(async () => moved.resolve());
    await settle();
    return { created, sent, settleSend };
  };

  describe("while a send is in flight", () => {
    it("keeps the workspace and the composer, and offers no other space", async () => {
      const { created, sent, settleSend } = await sendThenSpaceChanges();

      expect(button("Space").textContent).toBe("Platform");
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
      expect(testState.newWorkspace.mock.calls).toEqual([[]]);
      // The send was for the space selected when it began.
      expect(created[0].moveToSpace.mock.calls).toEqual([["design"]]);
    });

    it("applies a space that changed meanwhile once the send has failed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const attachments: ChatAttachmentHandle[] = [{ id: "attachment-1" }];
      const { created, sent, settleSend } = await sendThenSpaceChanges(attachments);

      await act(async () => {
        settleSend.reject(new Error("boom"));
        await expect(sent).rejects.toThrow("boom");
      });

      // The workspace was kept for a retry, in the space the failed send moved it to.
      expect(button("Space").disabled).toBe(false);
      expect(created[0].dispose).not.toHaveBeenCalled();
      expect(testState.composerMounts).toBe(1);

      await act(async () => {
        await testState.composer!.onSend("Hello", null, undefined, attachments);
      });
      expect(created[0].moveToSpace.mock.calls).toEqual([["design"], ["platform"]]);
      expect(testState.newWorkspace.mock.calls).toEqual([[]]);
      expect(testState.navigate).toHaveBeenCalledExactlyOnceWith(
        { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
    });
  });

  it("leaves the composer as it is when the space changes before any workspace exists", async () => {
    await renderHome();

    await chooseOption("Space", "Platform");

    expect(testState.newWorkspace).not.toHaveBeenCalled();
    expect(testState.composerMounts).toBe(1);
    expect(testState.composer!.autoFocus).toBe(true);
  });

  it("keeps the prompt the composer was seeded with when the space changes", async () => {
    await renderHome({ prompt: "Create a daily brief." });
    expect(promptField().value).toBe("Create a daily brief.");

    await reachForWorkspace();
    await chooseOption("Space", "Design");

    expect(promptField().value).toBe("Create a daily brief.");
    expect(testState.seeds.at(-1)).toEqual({ text: "Create a daily brief.", nonce: 1 });
    expect(testState.composerMounts).toBe(1);
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

    expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
  });

  it("reads the slash commands once, from the workspace it keeps when the space changes", async () => {
    const { created } = await renderHome();

    await loadCatalog();
    await chooseOption("Space", "Design");
    await loadCatalog();

    expect(testState.newWorkspace).toHaveBeenCalledOnce();
    expect(created[0].listSlashCommands).toHaveBeenCalledOnce();
  });

  it("moves a workspace kept for a retry when the space changes before the retry", async () => {
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
    expect(created[0].dispose).not.toHaveBeenCalled();

    await act(async () => {
      await testState.composer!.onSend("Hello", null, undefined, attachments);
    });
    expect(testState.newWorkspace.mock.calls).toEqual([["platform"]]);
    expect(created[0].moveToSpace.mock.calls).toEqual([["design"]]);
    expect(created[0].newChat).toHaveBeenCalledTimes(2);
    expect(testState.navigate).toHaveBeenCalledWith(
      { to: "/workspace/$id", params: { id: "w0" }, search: { chat: 1 } });
    expect(created[0].dispose).toHaveBeenCalledOnce();
  });
});
