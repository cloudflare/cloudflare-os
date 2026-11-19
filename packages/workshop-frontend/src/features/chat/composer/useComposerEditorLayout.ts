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
  // The textarea's own inline padding-bottom, while a preview replaces it.
  const ownPaddingBottomRef = useRef<string | null>(null);

  // Lines the preview adds below the textarea's own last line, which is where the preview starts.
  const previewLines = (lineHeight: number) => {
    const range = previewRef.current;
    const mirror = mirrorRef.current;
    if (!range || range.end <= range.start || !mirror) return 0;
    const first = mirror.textOffsetTop(range.start);
    const last = mirror.textOffsetTop(range.end - 1);
    if (first === null || last === null) return 0;
    return Math.max(0, Math.round((last - first) / lineHeight));
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
    mirrorRef.current?.syncScroll(textarea);
    measureUrlLineOffsetRef.current();
  };

  const resizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = "auto";
    if (ownPaddingBottomRef.current !== null) {
      textarea.style.paddingBottom = ownPaddingBottomRef.current;
      ownPaddingBottomRef.current = null;
    }
    const styles = getComputedStyle(textarea);
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    const paddingBottom = parseFloat(styles.paddingBottom);
    const verticalPadding = parseFloat(styles.paddingTop) + paddingBottom;
    const verticalBorder = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    const minimumHeight = lineHeight * minRows + verticalPadding + verticalBorder;
    const maximumHeight = lineHeight * maxRows + verticalPadding + verticalBorder;
    // Padding, unlike content, leaves the value, selection and undo history alone, and the mirror
    // lays its text out the same whatever its bottom padding.
    const lines = previewLines(lineHeight);
    if (lines > 0) {
      ownPaddingBottomRef.current = textarea.style.paddingBottom;
      textarea.style.paddingBottom = `${paddingBottom + lines * lineHeight}px`;
    }
    textarea.style.height =
      `${Math.min(Math.max(textarea.scrollHeight, minimumHeight), maximumHeight)}px`;
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
    // Showing or hiding the scrollbar resizes the content box too, so this also catches overflow
    // changes made by resizeTextarea.
    const observer = new ResizeObserver(([entry]) => {
      mirrorRef.current?.syncWidth(textarea, entry.contentRect.width);
      syncLayout();
    });
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [mirrorRef, textareaRef]);

  useLayoutEffect(() => {
    measureUrlLineOffset();
  }, [activeTextOffset, text]);

  // A preview changes the mirror without an input event, so refit the textarea whenever it does,
  // and once more when it goes. Follow its newest words, unless the user is working at a caret or
  // selection earlier in the textarea.
  const previewFittedRef = useRef(false);
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea || (!preview && !previewFittedRef.current)) return;
    previewFittedRef.current = Boolean(preview);
    resizeTextarea(textarea);
    const end = textarea.value.length;
    const editingEarlier = document.activeElement === textarea &&
      (textarea.selectionStart !== end || textarea.selectionEnd !== end);
    if (preview && !editingEarlier) textarea.scrollTop = textarea.scrollHeight;
    syncMirrorScroll(textarea);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, preview?.start, preview?.end]);

  return { resizeTextarea, syncMirrorScroll, urlLineOffset };
};
