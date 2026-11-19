/* eslint-disable react/react-in-jsx-scope */

// The mirror paints the text the textarea draws the caret over, so both must lay text out in the
// same box, which only a real layout engine measures.

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  ComposerMirror, composerTextareaClass, type ComposerMirrorHandle,
} from "./inline-items/ComposerMirror";
import { useComposerEditorLayout } from "./useComposerEditorLayout";
import styles from "./ChatComposer.module.css";

const SHORT_TEXT = "The quick brown fox jumps over the lazy dog.";
// Past the four rows the textarea grows to, so it scrolls.
const LONG_TEXT = `${SHORT_TEXT} `.repeat(20);

// `preview` is text the mirror paints after the textarea's value, as dictation does.
const Editor = ({ text, preview = "" }: { text: string; preview?: string }) => {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<ComposerMirrorHandle>(null);
  const painted = text + preview;
  const { resizeTextarea } = useComposerEditorLayout({
    textareaRef, wrapperRef, mirrorRef, text: painted, activeTextOffset: undefined,
    preview: preview ? { start: text.length, end: painted.length } : undefined,
    minRows: 2, maxRows: 4,
  });
  return (
    <div ref={wrapperRef} className={styles.capsuleInputWrapper}>
      <ComposerMirror ref={mirrorRef} value={painted} tokens={[]} disabled={false} />
      <textarea
        ref={(textarea) => {
          textareaRef.current = textarea;
          if (textarea) resizeTextarea(textarea);
        }}
        value={text}
        readOnly
        className={composerTextareaClass}
        style={{ boxSizing: "border-box", width: "100%", padding: 0, border: 0, lineHeight: "22px" }}
      />
    </div>
  );
};

const settle = () => act(() => new Promise((resolve) => {
  requestAnimationFrame(() => requestAnimationFrame(resolve));
}));

// Where the mirror paints its first or last character.
const characterRect = (mirror: HTMLElement, which: "first" | "last") => {
  const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  while (walker.nextNode()) texts.push(walker.currentNode as Text);
  const text = which === "first" ? texts[0] : texts[texts.length - 1];
  const offset = which === "first" ? 0 : text.length - 1;
  const range = document.createRange();
  range.setStart(text, offset);
  range.setEnd(text, offset + 1);
  return range.getBoundingClientRect();
};

const expectVisible = (rect: DOMRect, clip: HTMLElement) => {
  const visible = clip.getBoundingClientRect();
  expect(rect.top).toBeGreaterThanOrEqual(visible.top);
  expect(rect.bottom).toBeLessThanOrEqual(visible.bottom);
};

describe("composer editor layout", () => {
  let container: HTMLDivElement | undefined;
  let root: Root | undefined;

  afterEach(async () => {
    await act(async () => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
  });

  const render = async (text: string, preview?: string) => {
    if (!container) {
      container = document.body.appendChild(document.createElement("div"));
      // A flex layout rarely gives the composer a whole-pixel width.
      container.style.width = "403.3px";
      root = createRoot(container);
    }
    await act(async () => root!.render(<Editor text={text} preview={preview} />));
    await settle();
    const textarea = container.querySelector("textarea")!;
    const mirror = container.querySelector<HTMLElement>('[aria-hidden="true"] > div')!;
    return { textarea, mirror, clip: mirror.parentElement! };
  };


  // A mirror rounded to a whole pixel wraps a line differently once one ends within that
  // fraction of the edge, and the caret then appears in the middle of the painted text.
  it("sizes the mirror to the textarea's fractional width", async () => {
    const { textarea, mirror } = await render(SHORT_TEXT);

    expect(mirror.getBoundingClientRect().width)
      .toBeCloseTo(textarea.getBoundingClientRect().width, 2);
  });

  it("leaves out the scrollbar the textarea gains when it scrolls", async () => {
    const { textarea, mirror } = await render(LONG_TEXT);
    const scrollbarWidth = textarea.offsetWidth - textarea.clientWidth;

    expect(scrollbarWidth).toBeGreaterThan(0);
    expect(mirror.getBoundingClientRect().width)
      .toBeCloseTo(textarea.getBoundingClientRect().width - scrollbarWidth, 2);
  });

  it("clips the mirror to the textarea, hiding scrolled-out lines", async () => {
    const { textarea, clip } = await render(LONG_TEXT);

    expect(clip.getBoundingClientRect().height).toBe(textarea.getBoundingClientRect().height);
  });

  it("grows for preview text the textarea doesn't hold, then gives the room back", async () => {
    const { textarea } = await render(SHORT_TEXT);
    const height = textarea.clientHeight;

    await render(SHORT_TEXT, ` ${SHORT_TEXT} ${SHORT_TEXT}`);
    expect(textarea.value).toBe(SHORT_TEXT);
    expect(textarea.clientHeight).toBeGreaterThan(height);

    await render(SHORT_TEXT);
    expect(textarea.clientHeight).toBe(height);
  });

  it("stops at four rows and still shows the newest preview words", async () => {
    const { textarea, mirror, clip } = await render(SHORT_TEXT, ` ${LONG_TEXT}`.trimEnd());

    expect(textarea.getBoundingClientRect().height).toBe(4 * 22);
    expectVisible(characterRect(mirror, "last"), clip);
  });

  it("refits the preview when the composer narrows", async () => {
    const { textarea, mirror, clip } = await render(SHORT_TEXT, ` ${SHORT_TEXT} ${SHORT_TEXT}`);
    container!.style.width = "200px";
    await settle();
    await settle();

    expect(textarea.getBoundingClientRect().height).toBe(4 * 22);
    expectVisible(characterRect(mirror, "last"), clip);
  });

  // The textarea can't scroll to words it doesn't hold, so only the mirror was showing them.
  it("lines the mirror back up with the textarea when the user returns to it", async () => {
    const { textarea, mirror, clip } = await render(SHORT_TEXT, ` ${LONG_TEXT}`.trimEnd());
    await act(async () => textarea.focus());
    await settle();

    expectVisible(characterRect(mirror, "first"), clip);
    expect(textarea.style.caretColor).toBe("");
  });
});
