// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerAttachmentTray } from "./ComposerAttachmentTray";
import type { ComposerAttachment } from "./useComposerAttachments";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const attachment = (overrides: Partial<ComposerAttachment>): ComposerAttachment => ({
  id: "a",
  blob: new Blob([]),
  mimeType: "application/pdf",
  name: "report.pdf",
  uploadState: "ready",
  ...overrides,
});

let root: Root | undefined;
let container: HTMLElement | undefined;

const render = (
  attachments: ComposerAttachment[],
  { disabled = false, onRemove = () => {} }: { disabled?: boolean; onRemove?: (id: string) => void } = {},
) => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <ComposerAttachmentTray attachments={attachments} disabled={disabled} onRemove={onRemove} />,
    );
  });
  return container;
};

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe("ComposerAttachmentTray", () => {
  it("shows no cards without attachments", () => {
    expect(render([]).querySelectorAll("li")).toHaveLength(0);
  });

  it("removes the attachment whose button was pressed, naming it for assistive tech", () => {
    const onRemove = vi.fn<(id: string) => void>();
    const view = render(
      [attachment({ id: "one", name: "one.pdf" }), attachment({ id: "two", name: "two.pdf" })],
      { onRemove },
    );

    const button = view.querySelector<HTMLButtonElement>('button[aria-label="Remove two.pdf"]')!;
    act(() => button.click());

    expect(onRemove).toHaveBeenCalledExactlyOnceWith("two");
  });

  it("blocks removal while disabled", () => {
    const onRemove = vi.fn<(id: string) => void>();
    const view = render([attachment({})], { disabled: true, onRemove });

    const button = view.querySelector<HTMLButtonElement>("button")!;
    act(() => button.click());

    expect(button.disabled).toBe(true);
    expect(onRemove).not.toHaveBeenCalled();
  });

  it("shows an image as a preview and any other file as an icon card with its name", () => {
    const view = render([
      attachment({ id: "img", name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo" }),
      attachment({ id: "doc", name: "report.pdf" }),
    ]);

    const image = view.querySelector("img")!;
    expect(image.getAttribute("src")).toBe("blob:photo");
    expect(view.querySelectorAll("img")).toHaveLength(1);
    expect(view.textContent).toContain("report.pdf");
    expect(view.textContent).not.toContain("photo.png");
  });

  it("hides the content of an uploading card but still announces it", () => {
    const view = render([
      attachment({ name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo", uploadState: "uploading" }),
    ]);

    expect(view.querySelector("img")).toBeNull();
    expect(view.querySelector(".sr-only")?.textContent).toBe("Uploading photo.png");
  });

  it("reports a failed upload next to the file name, replacing any image preview", () => {
    const view = render([
      attachment({ name: "photo.png", mimeType: "image/png", previewUrl: "blob:photo", uploadState: "error" }),
    ]);

    expect(view.querySelector("img")).toBeNull();
    expect(view.textContent).toContain("Upload failed");
    expect(view.textContent).toContain("photo.png");
  });
});
