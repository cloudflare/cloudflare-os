// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { RpcStub } from "capnweb";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Overseer } from "@gadgets/workshop-shared/api";

const testState = vi.hoisted(() => ({
  nextId: 0,
  uploadBlob: {
    size: 4,
    arrayBuffer: async () => new Uint8Array([1, 2, 3, 4]).buffer,
  } as Blob,
}));

vi.mock("./prepareChatAttachment", () => ({
  MAX_CHAT_ATTACHMENT_TOTAL_BYTES: 5 * 1024 * 1024,
  prepareChatAttachment: async (file: File) => ({
    blob: testState.uploadBlob,
    mimeType: file.type,
  }),
}));

import {
  useComposerAttachments,
  type ComposerAttachment,
} from "./useComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const waitFor = async (check: () => boolean) => {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (check()) return;
    await act(async () => Promise.resolve());
  }
  expect(check()).toBe(true);
};

describe("useComposerAttachments", () => {
  let root: Root | undefined;
  let container: HTMLDivElement | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    vi.unstubAllGlobals();
  });

  it("clears only sent attachments and cleans up through their staging Overseer", async () => {
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(
      async () => ({ id: `upload-${++testState.nextId}` }),
    );
    const deleteFromFirst = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const firstOverseer = {
      uploadChatAttachment,
      deleteChatAttachment: deleteFromFirst,
    } as unknown as RpcStub<Overseer>;
    const deleteFromSecond = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const secondOverseer = {
      deleteChatAttachment: deleteFromSecond,
    } as unknown as RpcStub<Overseer>;
    let currentOverseer = firstOverseer;
    const onError = vi.fn<(message: string) => void>();
    let attachments: ComposerAttachment[] = [];
    let addFiles: ((files: File[]) => Promise<void>) | undefined;
    let clearSentAttachments: ((sent: readonly ComposerAttachment[]) => void) | undefined;
    let removeAttachment: ((id: string) => void) | undefined;

    vi.stubGlobal("crypto", { randomUUID: () => `local-${++testState.nextId}` });
    const Harness = () => {
      const attachmentState = useComposerAttachments({
        getOverseer: () => currentOverseer,
        modelId: "model-a",
        onError,
      });
      attachments = attachmentState.attachments;
      addFiles = attachmentState.addFiles;
      clearSentAttachments = attachmentState.clearSentAttachments;
      removeAttachment = attachmentState.removeAttachment;
      return null;
    };

    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));

    await act(async () => addFiles!([
      new File(["one"], "one.txt", { type: "text/plain" }),
    ]));
    await waitFor(() => attachments[0]?.uploadState === "ready");
    const sentSnapshot = [...attachments];

    await act(async () => addFiles!([
      new File(["two"], "two.txt", { type: "text/plain" }),
    ]));
    await waitFor(() => attachments.length === 2 && attachments[1].uploadState === "ready");
    act(() => clearSentAttachments!(sentSnapshot));

    expect(attachments).toHaveLength(1);
    expect(attachments[0].name).toBe("two.txt");
    expect(deleteFromFirst).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();

    currentOverseer = secondOverseer;
    act(() => removeAttachment!(attachments[0].id));
    await waitFor(() => deleteFromFirst.mock.calls.length === 1);
    expect(deleteFromSecond).not.toHaveBeenCalled();
  });

  it("deletes an upload that finishes after the composer unmounts", async () => {
    let finishUpload!: (handle: { id: string }) => void;
    const uploadChatAttachment = vi.fn<Overseer["uploadChatAttachment"]>(
      () => new Promise((resolve) => { finishUpload = resolve; }),
    );
    const deleteChatAttachment = vi.fn<Overseer["deleteChatAttachment"]>(async () => {});
    const overseer = {
      uploadChatAttachment,
      deleteChatAttachment,
    } as unknown as RpcStub<Overseer>;
    let addFiles!: (files: File[]) => Promise<void>;
    vi.stubGlobal("crypto", { randomUUID: () => "local-race" });

    const Harness = () => {
      ({ addFiles } = useComposerAttachments({
        getOverseer: () => overseer,
        modelId: "model-a",
        onError: vi.fn<(message: string) => void>(),
      }));
      return null;
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    await act(async () => addFiles([
      new File(["one"], "one.txt", { type: "text/plain" }),
    ]));
    await waitFor(() => uploadChatAttachment.mock.calls.length === 1);

    await act(async () => root!.unmount());
    root = undefined;
    await act(async () => finishUpload({ id: "late-upload" }));
    await waitFor(() => deleteChatAttachment.mock.calls.length === 1);
    expect(deleteChatAttachment).toHaveBeenCalledWith("late-upload");
  });
});
