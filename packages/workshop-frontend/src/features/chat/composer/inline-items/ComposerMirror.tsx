import {
  forwardRef, memo, useImperativeHandle, useRef, useState, type ReactNode,
} from "react";
import type { ComposerRange } from "../../../../components/chat/composer-tokens";
import styles from "./ComposerMirror.module.css";

const cssLogoUrls = new Map<string, string>();

// Server-provided URLs cross into a CSS declaration here. Cache escaped safe schemes and reject
// whitespace rather than allowing a newline or declaration terminator into the value.
const cssLogoUrl = (url: string | undefined): string | undefined => {
  if (!url) return undefined;
  let cached = cssLogoUrls.get(url);
  if (cached === undefined) {
    cached = /^(https?:\/\/|data:image\/)/.test(url) && !/\s/.test(url)
      ? `url("${url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`
      : "";
    cssLogoUrls.set(url, cached);
  }
  return cached || undefined;
};

/** Makes the textarea's own text transparent so the mirror below it shows through. */
export const composerTextareaClass = styles.textarea;

/** A range the mirror paints as one object rather than as text. */
export type MirrorToken = ComposerRange & {
  kind: "capsule" | "command";
  /** Raw vendor or format logo URL. Only capsules with a logo have one. */
  logoUrl?: string;
};

export type ComposerMirrorHandle = {
  syncLayout(textarea: HTMLTextAreaElement): void;
  syncScroll(textarea: HTMLTextAreaElement): void;
  textOffsetTop(offset: number): number | null;
  tokenAtPoint(clientX: number, clientY: number): { start: number; edge: number } | null;
  /**
   * Start offset of the token under the pointer, or null. Kept here rather than in the composer so
   * that moving the pointer repaints one span instead of re-rendering the whole composer.
   */
  setHoveredToken(start: number | null): void;
};

/**
 * Paints the composer's text behind the textarea, whose own text is transparent: prose in the
 * ordinary color, tokens in brand color with their logo and hover fill. The textarea keeps the
 * caret, the selection and the spell checker.
 */
export const ComposerMirror = memo(forwardRef<ComposerMirrorHandle, {
  value: string;
  tokens: readonly MirrorToken[];
  disabled: boolean;
}>(({value, tokens, disabled}, ref) => {
  const [hoveredToken, setHoveredToken] = useState<number | null>(null);
  const node = useRef<HTMLDivElement>(null);

  const syncScroll = (textarea: HTMLTextAreaElement) => {
    if (!node.current) return;
    node.current.style.transform =
      `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  };

  const syncLayout = (textarea: HTMLTextAreaElement) => {
    const mirror = node.current;
    if (!mirror) return;
    const computedStyle = getComputedStyle(textarea);
    mirror.style.fontFamily = computedStyle.fontFamily;
    mirror.style.fontSize = computedStyle.fontSize;
    mirror.style.fontWeight = computedStyle.fontWeight;
    mirror.style.lineHeight = computedStyle.lineHeight;
    mirror.style.letterSpacing = computedStyle.letterSpacing;
    mirror.style.padding = computedStyle.padding;
    mirror.style.border = `${computedStyle.borderWidth} solid transparent`;
    // A scrollbar narrows the textarea's client box, so offset dimensions would wrap differently.
    mirror.style.height = `${textarea.clientHeight}px`;
    mirror.style.width = `${textarea.clientWidth}px`;
    syncScroll(textarea);
  };

  const textOffsetTop = (offset: number): number | null => {
    const mirror = node.current;
    if (!mirror) return null;
    for (const segment of mirror.querySelectorAll<HTMLElement>("[data-text-start]")) {
      const start = Number(segment.dataset.textStart);
      const end = Number(segment.dataset.textEnd);
      if (offset < start || offset >= end) continue;
      const textNode = Array.from(segment.childNodes).find(
        (child): child is Text => child.nodeType === Node.TEXT_NODE,
      );
      if (!textNode) return segment.getBoundingClientRect().top;
      const relativeOffset = Math.min(offset - start, textNode.length - 1);
      const range = document.createRange();
      range.setStart(textNode, relativeOffset);
      range.setEnd(textNode, relativeOffset + 1);
      return range.getBoundingClientRect().top;
    }
    return null;
  };

  const tokenAtPoint = (clientX: number, clientY: number) => {
    const mirror = node.current;
    if (!mirror) return null;
    for (const span of mirror.querySelectorAll<HTMLElement>("[data-token-start]")) {
      for (const rect of Array.from(span.getClientRects())) {
        if (clientX < rect.left || clientX > rect.right ||
            clientY < rect.top || clientY > rect.bottom) {
          continue;
        }
        return {
          start: Number(span.dataset.tokenStart),
          edge: clientX < rect.left + rect.width / 2
            ? Number(span.dataset.tokenStart)
            : Number(span.dataset.tokenEnd),
        };
      }
    }
    return null;
  };

  useImperativeHandle(ref, () => ({
    setHoveredToken,
    syncLayout,
    syncScroll,
    textOffsetTop,
    tokenAtPoint,
  }), []);

  const boundaries = new Set([0, value.length]);
  for (const token of tokens) {
    boundaries.add(token.start);
    boundaries.add(token.start + token.length);
  }
  const positions = [...boundaries]
    .filter((position) => position >= 0 && position <= value.length)
    .toSorted((a, b) => a - b);

  const segments: ReactNode[] = [];
  for (let i = 0; i < positions.length; i++) {
    const start = positions[i];
    const end = positions[i + 1];
    if (end === undefined || end <= start) continue;

    const token = tokens.find((t) => start >= t.start && end <= t.start + t.length);
    const text = value.slice(start, end);
    if (!token) {
      segments.push(
        <span key={start} data-text-start={start} data-text-end={end}>{text}</span>,
      );
      continue;
    }
    let className = token.kind === "capsule" ? styles.capsule : styles.command;
    if (!disabled && token.start === hoveredToken) className += ` ${styles.hovered}`;
    const logo = cssLogoUrl(token.logoUrl);
    const tokenNode = (
      // Tokens carry their range so pointer hit-testing can map a rect back to text offsets.
      <span
        className={className}
        style={logo ? {backgroundImage: logo} : undefined}
        data-token-start={token.start}
        data-token-end={token.start + token.length}
        data-text-start={start}
        data-text-end={end}
      >
        {text}
      </span>
    );
    segments.push(<span key={start}>{tokenNode}</span>);
  }
  // Ensure at least a space so the div has nonzero height when empty.
  if (value.length === 0) segments.push(<span key="empty"> </span>);

  return (
    <div className={styles.clip} aria-hidden="true">
      <div ref={node} className={disabled ? `${styles.mirror} ${styles.disabled}` : styles.mirror}>
        {segments}
      </div>
    </div>
  );
}));

ComposerMirror.displayName = "ComposerMirror";
