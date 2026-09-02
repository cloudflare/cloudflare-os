// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import type { GatekeeperClient } from "@gadgets/workshop-shared/api";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComposerDocument, ComposerSelection } from "./composerDocument";
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

const emptyDocument = (text: string): ComposerDocument => ({
  text,
  capsules: [],
  formats: [],
  command: null,
});

const fakeGatekeeper = (describeResource = async () => description) => {
  const dispose = vi.fn<() => void>();
  return {
    dispose,
    stub: {
      getId: async () => 7,
      describe: describeResource,
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
  });

  const renderHarness = async (
    createCapsuleGatekeeper: () => Promise<RpcStub<GatekeeperClient<any>> | null>,
  ) => {
    const onSelectionRequest = vi.fn<(
      selection: ComposerSelection,
      documentRevision: number,
    ) => void>();
    const onError = vi.fn<(message: string) => void>();
    let controls: {
      draft: ReturnType<typeof useComposerDraft>;
      resources: ReturnType<typeof useComposerResources>;
    };
    const Harness = () => {
      const draft = useComposerDraft({ storageKey: undefined, logoSlot: "" });
      const resources = useComposerResources({
        createCapsuleGatekeeper,
        getDocumentSnapshot: draft.getDocumentSnapshot,
        commitDocumentEdit: draft.commitDocumentEdit,
        capsuleTokenText: (resource) => resource.title,
        onSelectionRequest,
        onError,
      });
      controls = { draft, resources };
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    return { get controls() { return controls; }, onError, onSelectionRequest };
  };

  it("commits and disposes a resource created from the active URL", async () => {
    const gatekeeper = fakeGatekeeper();
    const harness = await renderHarness(async () => gatekeeper.stub);
    act(() => {
      harness.controls.draft.recordEdit();
      harness.controls.draft.replaceDocument(emptyDocument(description.url));
    });
    act(() => harness.controls.resources.scanAt(10));

    await act(async () => harness.controls.resources.createCapsule(3, "vendor"));

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
    expect(harness.onSelectionRequest).toHaveBeenCalledWith(
      { start: 5, end: 5 },
      expect.any(Number),
    );
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
    const creation = harness.controls.resources.createCapsule(3, "vendor");
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
    expect(harness.onSelectionRequest).not.toHaveBeenCalled();
    expect(harness.onError).toHaveBeenCalledWith(
      "The prompt changed before the resource could be added",
    );
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
    const creation = harness.controls.resources.createCapsule(3, "vendor");
    await act(async () => Promise.resolve());

    act(() => harness.controls.resources.scanAt(0));
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document.text).toBe("See Plan ");
    expect(harness.controls.draft.document.capsules).toHaveLength(1);
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
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
    const creation = harness.controls.resources.createCapsule(3, "vendor");
    await act(async () => Promise.resolve());

    act(() => harness.controls.resources.dismissUrl());
    await act(async () => {
      resolveDescription(description);
      await creation;
    });

    expect(harness.controls.draft.document).toEqual(emptyDocument(description.url));
    expect(gatekeeper.dispose).toHaveBeenCalledOnce();
    expect(harness.onSelectionRequest).not.toHaveBeenCalled();
    expect(harness.onError).not.toHaveBeenCalled();
  });

  it("suppresses a metadata failure after the attach modal is canceled", async () => {
    let rejectMetadata!: (reason: Error) => void;
    const dispose = vi.fn<() => void>();
    const gatekeeper = {
      getId: () => new Promise<number>((_resolve, reject) => {
        rejectMetadata = reject;
      }),
      describe: async () => description,
      getCreationSpec: async () => ({ type: "gatekeeper" as const, vendorId: "vendor" }),
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
    expect(harness.onError).not.toHaveBeenCalled();
  });
});
