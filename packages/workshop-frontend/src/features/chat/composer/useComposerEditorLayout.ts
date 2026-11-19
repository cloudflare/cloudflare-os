import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CAPSULE_OVERLAY_GAP } from "../../../CapsuleOverlay";
import type { ComposerMirrorHandle } from "./inline-items/ComposerMirror";

type UseComposerEditorLayoutOptions = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  mirrorRef: RefObject<ComposerMirrorHandle | null>;
  text: string;
  activeTextOffset: number | undefined;
  /** Text the mirror paints after the textarea's value, as offsets into the mirror's text. */
  preview?: { start: number; end: number };
  minRows: number;
  maxRows: number;
};

export const useComposerEditorLayout = ({
  textareaRef,
  wrapperRef,
  mirrorRef,
  text,
  activeTextOffset,
  preview,
  minRows,
  maxRows,
}: UseComposerEditorLayoutOptions) => {
  const [urlLineOffset, setUrlLineOffset] = useState<number>();
  const activeTextOffsetRef = useRef(activeTextOffset);
  const measureUrlLineOffsetRef = useRef<() => void>(() => {});
  activeTextOffsetRef.current = activeTextOffset;
  const previewRef = useRef(preview);
  previewRef.current = preview;
  // The height the mirror's text needed at the last resize, preview included.
  const contentHeightRef = useRef(0);
  // How far the mirror scrolls past the end of the textarea's own range, to show preview words the
  // textarea can't scroll to because it doesn't hold them.
  const overscrollRef = useRef(0);
  const fitPreviewRef = useRef<() => void>(() => {});

  // Counted in whole lines, because the glyph boxes measured are shorter than the line boxes.
  const previewContentHeight = (lineHeight: number, verticalPadding: number) => {
    const range = previewRef.current;
    const mirror = mirrorRef.current;
    if (!range || range.end <= range.start || !mirror) return 0;
    const first = mirror.textOffsetTop(0);
    const last = mirror.textOffsetTop(range.end - 1);
    if (first === null || last === null) return 0;
    return (Math.round((last - first) / lineHeight) + 1) * lineHeight + verticalPadding;
  };

  const measureUrlLineOffset = () => {
    const offset = activeTextOffsetRef.current;
    const wrapper = wrapperRef.current;
    if (offset === undefined || !wrapper) {
      setUrlLineOffset(undefined);
      return;
    }
    const textTop = mirrorRef.current?.textOffsetTop(offset);
    if (textTop === null || textTop === undefined) {
      setUrlLineOffset(undefined);
      return;
    }
    const wrapperBottom = wrapper.getBoundingClientRect().bottom;
    setUrlLineOffset(Math.max(
      CAPSULE_OVERLAY_GAP,
      wrapperBottom - textTop + CAPSULE_OVERLAY_GAP,
    ));
  };
  measureUrlLineOffsetRef.current = measureUrlLineOffset;

  const syncMirrorScroll = (textarea: HTMLTextAreaElement) => {
    // Scrolling the textarea back from its end is the user reading earlier text.
    if (textarea.scrollTop < textarea.scrollHeight - textarea.clientHeight - 1) {
      overscrollRef.current = 0;
    }
    mirrorRef.current?.syncScroll(textarea, overscrollRef.current);
    // Overscrolled, the mirror no longer lines up with the caret the textarea draws.
    textarea.style.caretColor = overscrollRef.current ? "transparent" : "";
    measureUrlLineOffsetRef.current();
  };

  const resizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    const styles = getComputedStyle(textarea);
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const verticalBorder = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    const minimumHeight = lineHeight * minRows + verticalPadding + verticalBorder;
    const maximumHeight = lineHeight * maxRows + verticalPadding + verticalBorder;
    // The preview counts toward the height, so the textarea grows for words it doesn't hold.
    const contentHeight = Math.max(
      textarea.scrollHeight, previewContentHeight(lineHeight, verticalPadding),
    );
    contentHeightRef.current = contentHeight;
    textarea.style.height =
      `${Math.min(Math.max(contentHeight, minimumHeight), maximumHeight)}px`;
    textarea.style.overflow = textarea.scrollHeight > maximumHeight ? "auto" : "hidden";
    mirrorRef.current?.syncLayout(textarea);
    measureUrlLineOffsetRef.current();
  };

  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    const syncLayout = () => {
      mirrorRef.current?.syncLayout(textarea);
      measureUrlLineOffsetRef.current();
    };
    syncLayout();
    let width: number | undefined;
    let frame = 0;
    // Showing or hiding the scrollbar resizes the content box too, so this also catches overflow
    // changes made by resizeTextarea.
    const observer = new ResizeObserver(([entry]) => {
      mirrorRef.current?.syncWidth(textarea, entry.contentRect.width);
      syncLayout();
      // A preview rewraps at a new width. Refit on the next frame, since resizing the textarea
      // from here would resize what this observes.
      if (previewRef.current && width !== undefined && width !== entry.contentRect.width) {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => fitPreviewRef.current());
      }
      width = entry.contentRect.width;
    });
    observer.observe(textarea);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [mirrorRef, textareaRef]);

  useLayoutEffect(() => {
    measureUrlLineOffset();
  }, [activeTextOffset, text]);

  // Refits for the preview and scrolls to its newest words, past the textarea's own range if they
  // run beyond it, unless the user is working at a caret or selection earlier in the textarea.
  const fitPreview = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    resizeTextarea(textarea);
    const end = textarea.value.length;
    const editingEarlier = document.activeElement === textarea &&
      (textarea.selectionStart !== end || textarea.selectionEnd !== end);
    overscrollRef.current = 0;
    if (previewRef.current && !editingEarlier) {
      textarea.scrollTop = textarea.scrollHeight;
      overscrollRef.current = Math.max(0, contentHeightRef.current - textarea.scrollHeight);
    }
    syncMirrorScroll(textarea);
  };
  fitPreviewRef.current = fitPreview;

  // A preview changes the mirror without an input event, so refit whenever it does, and once more
  // when it goes.
  const previewFittedRef = useRef(false);
  useLayoutEffect(() => {
    if (!preview && !previewFittedRef.current) return;
    previewFittedRef.current = Boolean(preview);
    fitPreview();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, preview?.start, preview?.end]);

  return { resizeTextarea, syncMirrorScroll, urlLineOffset };
};
