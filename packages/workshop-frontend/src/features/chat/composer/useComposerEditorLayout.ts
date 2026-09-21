import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { CAPSULE_OVERLAY_GAP } from "../../../CapsuleOverlay";
import type { ComposerMirrorHandle } from "./inline-items/ComposerMirror";

type UseComposerEditorLayoutOptions = {
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  wrapperRef: RefObject<HTMLDivElement | null>;
  mirrorRef: RefObject<ComposerMirrorHandle | null>;
  text: string;
  activeTextOffset: number | undefined;
  minRows: number;
  maxRows: number;
};

export const useComposerEditorLayout = ({
  textareaRef,
  wrapperRef,
  mirrorRef,
  text,
  activeTextOffset,
  minRows,
  maxRows,
}: UseComposerEditorLayoutOptions) => {
  const [urlLineOffset, setUrlLineOffset] = useState<number>();
  const activeTextOffsetRef = useRef(activeTextOffset);
  const measureUrlLineOffsetRef = useRef<() => void>(() => {});
  activeTextOffsetRef.current = activeTextOffset;

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
    const styles = getComputedStyle(textarea);
    const lineHeight = parseFloat(styles.lineHeight) || parseFloat(styles.fontSize) * 1.5;
    const verticalPadding = parseFloat(styles.paddingTop) + parseFloat(styles.paddingBottom);
    const verticalBorder = parseFloat(styles.borderTopWidth) + parseFloat(styles.borderBottomWidth);
    const minimumHeight = lineHeight * minRows + verticalPadding + verticalBorder;
    const maximumHeight = lineHeight * maxRows + verticalPadding + verticalBorder;
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
    const observer = new ResizeObserver(syncLayout);
    observer.observe(textarea);
    return () => observer.disconnect();
  }, [mirrorRef, textareaRef]);

  useLayoutEffect(() => {
    measureUrlLineOffset();
  }, [activeTextOffset, text]);

  return { resizeTextarea, syncMirrorScroll, urlLineOffset };
};
