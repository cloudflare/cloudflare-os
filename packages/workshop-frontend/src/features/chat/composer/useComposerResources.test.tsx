// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import type { GatekeeperClient } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDocument, ComposerSelection } from "./composerDocument";
import type { StoredComposerDraft } from "./draft/composerDraft";

const iconState = vi.hoisted(() => ({
  resolve: undefined as ((url: string) => void) | undefined,
}));

vi.mock("../../../components/format/formatIconImage", () => ({
  formatIconDataUrl: () => new Promise<string>((resolve) => {
    iconState.resolve = resolve;
  }),
}));

import { writeComposerDraft } from "./draft/composerDraft";
import { useComposerDraft } from "./draft/useComposerDraft";
import { useComposerResources } from "./useComposerResources";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const description = {
  url: "https://example.com/plan",
  title: "Plan",
  snippet: "Project plan",
  suggestedBindingName: "plan",
  tsType: "Plan",
};

const resolution = {
  accountId: 3,
  vendorId: "vendor",
  resourceUrlPattern: "https://example.com/*",
};

const emptyDocument = (text: string): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

const fakeGatekeeper = (describeResource = async () => description) => {
  const dispose = vi.fn<() => void>();
  const remove = vi.fn<() => Promise<void>>(async () => {});
  return {
    dispose,
    remove,
    stub: {
      getId: async () => 7,
      describe: describeResource,
      remove,
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<GatekeeperClient<any>>,
  };
};

// A gatekeeper the attach modal created.
const createdGatekeeper = () => {
  const dispose = vi.fn<() => void>();
  const remove = vi.fn<() => Promise<void>>(async () => {});
  return {
    dispose,
    remove,
    stub: {
      getId: async () => 7,
      describe: async () => description,
      getCreationSpec: async () => ({ type: "gatekeeper" as const, vendorId: "vendor" }),
      remove,
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<GatekeeperClient<any>>,
  };
};

describe("useComposerResources", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    sessionStorage.clear();
    iconState.resolve = undefined;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const renderHarness = async (
    createCapsuleGatekeeper: (accountId: number, url: string) =>
      Promise<RpcStub<GatekeeperClient<any>> | null>,
    draftOptions: { storageKey?: string; logoSlot?: string } = {},
  ) => {
    const onSelectionRequest = vi.fn<(
      selection: ComposerSelection,
      documentRevision: number,
    ) => void>();
    const onConnectionCreated = vi.fn<() => void>();
    const onError = vi.fn<(title: string, description?: string, configure?: () => void) => void>();
    let controls: {
      draft: ReturnType<typeof useComposerDraft>;
      resources: ReturnType<typeof useComposerResources>;
    };
    const Harness = () => {
      const draft = useComposerDraft({
        storageKey: draftOptions.storageKey,
        logoSlot: draftOptions.logoSlot ?? "",
      });
      const resources = useComposerResources({
        createCapsuleGatekeeper,
        getDocumentSnapshot: draft.getDocumentSnapshot,
        commitDocumentEdit: draft.commitDocumentEdit,
        capsuleTokenText: (resource) => resource.title,
        onConnectionCreated,
        onSelectionRequest,
        onError,
      });
      controls = { draft, resources };
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    return {
      get controls() { return controls; },
      onConnectionCreated,
      onError,
      onSelectionRequest,
    };
  };

  it("commits and disposes a resource created from the active URL", async () => {
    const gatekeeper = fakeGatekeeper();
    const harness = await renderHarness(async () => gatekeeper.stub);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(description.url));
    });
    act(() => harness.controls.resources.scanAt(10));

    await act(async () => harness.controls.resources.createCapsule(resolution));

    expect(harness.controls.draft.document).toEqual({
      text: "Plan ",
      capsules: [{
        start: 0,
        length: 4,
        gatekeeperId: 7,
        description,
        vendorId: "vendor",
      }],
      formats: [],
      command: null,
    });
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(harness.onConnectionCreated).toHaveBeenCalledOnce();
    expect(harness.onSelectionRequest).toHaveBeenCalledWith(
      { start: 5, end: 5 },
      expect.any(Number),
    );
  });

  it("sends the URL with its query and reports the gatekeeper's refusal", async () => {
    const link = "https://chat.google.com/room/AAQANZZTsQ8?cls=7&tab=1";
    const refusal = "Google Chat resource URLs must not include fragments or query parameters other than cls.";
    const createCapsuleGatekeeper = vi.fn<(accountId: number, url: string) =>
      Promise<RpcStub<GatekeeperClient<any>> | null>>(async () => { throw new Error(refusal); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await renderHarness(createCapsuleGatekeeper);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(link));
    });
    act(() => harness.controls.resources.scanAt(10));

    await act(async () => harness.controls.resources.createCapsule(resolution));

    expect(createCapsuleGatekeeper).toHaveBeenCalledWith(3, link);
    expect(harness.onError).toHaveBeenCalledWith("Failed to add resource", refusal, expect.any(Function));
    expect(harness.controls.draft.document).toEqual(emptyDocument(link));
  });

  it("disposes but rejects a resource result after a newer edit", async () => {
    let resolveDescription!: (value: typeof description) => void;
    const gatekeeper = fakeGatekeeper(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const harness = await renderHarness(async () => gatekeeper.stub);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(description.url));
    });
    act(() => harness.controls.resources.scanAt(10));
    const creation = harness.controls.resources.createCapsule(resolution);
    await act(async () => Promise.resolve());

    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument("new prompt"));
    });
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document).toEqual(emptyDocument("new prompt"));
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(gatekeeper.remove).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).not.toHaveBeenCalled();
    expect(harness.onSelectionRequest).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenCalledWith(
      "The prompt changed before the resource could be added",
    );
    expect(harness.onError.mock.calls[0][2]).toBeUndefined();
  });

  it("commits an accepted resource after the caret leaves its URL", async () => {
    let resolveDescription!: (value: typeof description) => void;
    const gatekeeper = fakeGatekeeper(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const harness = await renderHarness(async () => gatekeeper.stub);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(`See ${description.url}`));
    });
    act(() => harness.controls.resources.scanAt(10));
    const creation = harness.controls.resources.createCapsule(resolution);
    await act(async () => Promise.resolve());

    act(() => harness.controls.resources.scanAt(0));
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document.text).toBe("See Plan ");
    expect(harness.controls.draft.document.capsules).toHaveLength(1);
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("commits a resource after async decoration shifts its URL", async () => {
    const storedDraft: StoredComposerDraft = {
      version: 1,
      text: `Document ${description.url}`,
      formats: [{ position: 0, length: 8, noun: "Document", icon: "fileText" }],
    };
    writeComposerDraft("draft:user-a", storedDraft);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    let resolveDescription!: (value: typeof description) => void;
    const gatekeeper = fakeGatekeeper(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const harness = await renderHarness(
      async () => gatekeeper.stub,
      { storageKey: "draft:user-a", logoSlot: "[icon]" },
    );
    act(() => harness.controls.resources.scanAt(15));
    const creation = harness.controls.resources.createCapsule(resolution);
    await act(async () => Promise.resolve());

    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document.text).toBe("[icon]Document Plan ");
    expect(harness.controls.draft.document.capsules).toHaveLength(1);
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("rejects a resource result after explicit dismissal", async () => {
    let resolveDescription!: (value: typeof description) => void;
    const gatekeeper = fakeGatekeeper(() => new Promise((resolve) => {
      resolveDescription = resolve;
    }));
    const harness = await renderHarness(async () => gatekeeper.stub);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(description.url));
    });
    act(() => harness.controls.resources.scanAt(10));
    const creation = harness.controls.resources.createCapsule(resolution);
    await act(async () => Promise.resolve());
    expect(harness.controls.resources.isCreatingResource).toBe(true);

    act(() => harness.controls.resources.dismissUrl());
    expect(harness.controls.resources.isCreatingResource).toBe(false);
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document).toEqual(emptyDocument(description.url));
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(gatekeeper.remove).toHaveBeenCalledOnce();
    expect(harness.onSelectionRequest).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("attaches a modal resource after async decoration shifts its position", async () => {
    const storedDraft: StoredComposerDraft = {
      version: 1,
      text: "Document notes",
      formats: [{ position: 0, length: 8, noun: "Document", icon: "fileText" }],
    };
    writeComposerDraft("draft:user-a", storedDraft);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    let resolveId!: (value: number) => void;
    const dispose = vi.fn<() => void>();
    const remove = vi.fn<() => Promise<void>>(async () => {});
    const gatekeeper = {
      getId: () => new Promise<number>((resolve) => { resolveId = resolve; }),
      describe: async () => description,
      getCreationSpec: async () => ({ type: "gatekeeper" as const, vendorId: "vendor" }),
      remove,
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<GatekeeperClient<any>>;
    const harness = await renderHarness(
      async () => null,
      { storageKey: "draft:user-a", logoSlot: "[icon]" },
    );
    act(() => harness.controls.resources.openAttachModal(storedDraft.text.length));
    const creation = harness.controls.resources.attachCreated(gatekeeper);

    await act(async () => {
      iconState.resolve!("data:image/svg+xml,icon");
      await Promise.resolve();
    });
    await act(async () => {
      resolveId(7);
      await creation;
    });

    expect(harness.controls.draft.document.text).toBe("[icon]Document notes Plan ");
    expect(harness.controls.draft.document.capsules).toHaveLength(1);
    expect(remove).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).toHaveBeenCalledOnce();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("suppresses a metadata failure after the attach modal is canceled", async () => {
    let rejectMetadata!: (reason: Error) => void;
    const dispose = vi.fn<() => void>();
    const remove = vi.fn<() => Promise<void>>(async () => {});
    const gatekeeper = {
      getId: () => new Promise<number>((_resolve, reject) => {
        rejectMetadata = reject;
      }),
      describe: async () => description,
      getCreationSpec: async () => ({ type: "gatekeeper" as const, vendorId: "vendor" }),
      remove,
      [Symbol.dispose]: dispose,
    } as unknown as RpcStub<GatekeeperClient<any>>;
    const harness = await renderHarness(async () => null);
    act(() => harness.controls.resources.openAttachModal(0));
    const creation = harness.controls.resources.attachCreated(gatekeeper);

    act(() => harness.controls.resources.closeAttachModal());
    await act(async () => {
      rejectMetadata(new Error("metadata failed"));
      await creation;
    });

    expect(dispose).toHaveBeenCalledOnce();
    expect(remove).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  const failPaste = async (
    createCapsuleGatekeeper: () => Promise<RpcStub<GatekeeperClient<any>> | null>,
  ) => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const harness = await renderHarness(createCapsuleGatekeeper);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(`See ${description.url}`));
    });
    act(() => harness.controls.resources.scanAt(10));
    await act(async () => harness.controls.resources.createCapsule(resolution));
    consoleError.mockRestore();
    expect(harness.onError).toHaveBeenCalledOnce();
    const [title, detail, configure] = harness.onError.mock.calls[0];
    return { harness, title, detail, configure };
  };

  it("reports the server's own reason a pasted URL could not be connected", async () => {
    const reason = "This is an Office file. Connect it again to make a Google copy.";
    const { title, detail, configure } = await failPaste(async () => {
      throw new Error(reason);
    });

    expect(title).toBe("Failed to add resource");
    expect(detail).toBe(reason);
    expect(configure).toBeTypeOf("function");
  });

  it("keeps a generic message for a transport failure", async () => {
    const { title, detail, configure } = await failPaste(async () => {
      throw new Error("Peer closed WebSocket");
    });

    expect(title).toBe("Failed to add resource");
    expect(detail).toBeUndefined();
    expect(configure).toBeTypeOf("function");
  });

  it("offers to configure a URL whose connection was not created", async () => {
    const { title, detail, configure } = await failPaste(async () => null);

    expect(title).toBe("Failed to create resource connection");
    expect(detail).toBeUndefined();
    expect(configure).toBeTypeOf("function");
  });

  it("opens the attach modal on a failed URL and replaces it with the modal's capsule", async () => {
    const { harness, configure } = await failPaste(async () => {
      throw new Error("Not a Google Sheet");
    });
    expect(harness.controls.resources.attachModalOpen).toBe(false);

    act(() => configure!());

    expect(harness.controls.resources.attachModalOpen).toBe(true);
    expect(harness.controls.resources.attachModalPrefill).toEqual({
      url: description.url,
      resolution,
    });
    expect(harness.controls.resources.activeUrl).toBeNull();

    const gatekeeper = createdGatekeeper();
    await act(async () => harness.controls.resources.attachCreated(gatekeeper.stub));

    expect(harness.controls.draft.document).toEqual({
      text: "See Plan ",
      capsules: [{
        start: 4,
        length: 4,
        gatekeeperId: 7,
        description,
        vendorId: "vendor",
      }],
      formats: [],
      command: null,
    });
    expect(harness.controls.resources.attachModalOpen).toBe(false);
    expect(harness.controls.resources.attachModalPrefill).toBeUndefined();
    expect(gatekeeper.remove).not.toHaveBeenCalled();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).toHaveBeenCalledOnce();
    expect(harness.onSelectionRequest).toHaveBeenCalledWith(
      { start: 9, end: 9 },
      expect.any(Number),
    );
    expect(harness.onError).toHaveBeenCalledOnce();
  });

  it("replaces the failed URL after the prompt was edited elsewhere", async () => {
    const { harness, configure } = await failPaste(async () => null);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(
        emptyDocument(`Please see ${description.url} today`),
      );
    });

    act(() => configure!());
    await act(async () => harness.controls.resources.attachCreated(createdGatekeeper().stub));

    expect(harness.controls.draft.document.text).toBe("Please see Plan today");
    expect(harness.controls.draft.document.capsules).toEqual([
      expect.objectContaining({ start: 11, length: 4, gatekeeperId: 7 }),
    ]);
  });

  it("replaces the first remaining copy of the failed URL wherever edits moved it", async () => {
    const { harness, configure } = await failPaste(async () => null);
    const other = "https://other.example.com/x";
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(
        emptyDocument(`Compare ${other} with ${description.url} and ${description.url}`),
      );
    });

    act(() => configure!());
    await act(async () => harness.controls.resources.attachCreated(createdGatekeeper().stub));

    expect(harness.controls.draft.document.text)
      .toBe(`Compare ${other} with Plan and ${description.url}`);
    expect(harness.controls.draft.document.capsules).toEqual([
      expect.objectContaining({ start: 14 + other.length, length: 4, gatekeeperId: 7 }),
    ]);
    expect(harness.onError).toHaveBeenCalledOnce();
  });

  it("does not open the modal once the failed URL is gone", async () => {
    const { harness, configure } = await failPaste(async () => null);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument("See nothing"));
    });

    act(() => configure!());

    expect(harness.controls.resources.attachModalOpen).toBe(false);
    expect(harness.onError).toHaveBeenLastCalledWith(
      "The prompt changed before the resource could be added",
    );
  });

  it("removes the modal's connection when the URL changed while the modal was open", async () => {
    const { harness, configure } = await failPaste(async () => null);
    act(() => configure!());
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument("See nothing"));
    });

    const gatekeeper = createdGatekeeper();
    await act(async () => harness.controls.resources.attachCreated(gatekeeper.stub));

    expect(harness.controls.draft.document).toEqual(emptyDocument("See nothing"));
    expect(gatekeeper.remove).toHaveBeenCalledOnce();
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(harness.onConnectionCreated).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenLastCalledWith(
      "The prompt changed before the resource could be added",
    );
  });

  it("opens the add-menu modal without a prefill", async () => {
    const harness = await renderHarness(async () => null);
    act(() => harness.controls.resources.openAttachModal(0));

    expect(harness.controls.resources.attachModalOpen).toBe(true);
    expect(harness.controls.resources.attachModalPrefill).toBeUndefined();
  });
});
