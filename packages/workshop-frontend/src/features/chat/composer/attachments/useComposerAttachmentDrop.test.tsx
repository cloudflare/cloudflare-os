// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useComposerAttachmentDrop } from "./useComposerAttachmentDrop";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dragEvent = (type: string, files = [] as unknown as FileList) => {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: { types: ["Files"], files, dropEffect: "none" },
  });
  return event as DragEvent;
};

describe("useComposerAttachmentDrop", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
  });

  const renderDropTarget = async ({
    attachmentCount = 0,
    onFilesDropped = vi.fn<(files: FileList) => void>(),
  } = {}) => {
    const Harness = () => {
      const drop = useComposerAttachmentDrop({
        attachmentCount,
        maxAttachments: 5,
        onFilesDropped,
      });
      return (
        <div
          data-active={drop.isActive}
          onDragEnter={drop.onDragEnter}
          onDragLeave={drop.onDragLeave}
          onDragOver={drop.onDragOver}
          onDrop={drop.onDrop}
        />
      );
    };
    container = document.createElement("div");
    root = createRoot(container);
    await act(async () => root!.render(<Harness />));
    return { node: container.firstElementChild as HTMLDivElement, onFilesDropped };
  };

  it("stays active until nested drag entries have all left", async () => {
    const { node } = await renderDropTarget();

    act(() => {
      node.dispatchEvent(dragEvent("dragenter"));
      node.dispatchEvent(dragEvent("dragenter"));
      node.dispatchEvent(dragEvent("dragleave"));
    });
    expect(node.dataset.active).toBe("true");

    act(() => node.dispatchEvent(dragEvent("dragleave")));
    expect(node.dataset.active).toBe("false");
  });

  it("rejects the drop effect when the attachment limit is reached", async () => {
    const { node } = await renderDropTarget({ attachmentCount: 5 });
    const event = dragEvent("dragover");

    act(() => node.dispatchEvent(event));

    expect(event.dataTransfer!.dropEffect).toBe("none");
    expect(event.defaultPrevented).toBe(true);
  });

  it("forwards dropped files and clears the active state", async () => {
    const files = [new File(["data"], "report.txt")] as unknown as FileList;
    const { node, onFilesDropped } = await renderDropTarget();
    act(() => node.dispatchEvent(dragEvent("dragenter", files)));

    act(() => node.dispatchEvent(dragEvent("drop", files)));

    expect(onFilesDropped).toHaveBeenCalledWith(files);
    expect(node.dataset.active).toBe("false");
  });
});
