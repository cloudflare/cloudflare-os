import {
  forwardRef, memo, useImperativeHandle, useRef, useState, type ReactNode,
} from "react";
import type { ComposerRange } from "./composer-tokens";
import styles from "./ComposerMirror.module.css";

/** Makes the textarea's own text transparent so the mirror below it shows through. */
export const composerTextareaClass = styles.textarea;

/** A range the mirror paints as one object rather than as text. */
export type MirrorToken = ComposerRange & {
  kind: "capsule" | "command";
  /** `url("...")`, ready for `background-image`. Only capsules with a vendor logo have one. */
  logo?: string;
};

export type ComposerMirrorHandle = {
  /** The element whose geometry mirrors the textarea's, for size syncing and pointer hit-testing. */
  readonly node: HTMLDivElement | null;
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
}>(function ComposerMirror({value, tokens, disabled}, ref) {
  const [hoveredToken, setHoveredToken] = useState<number | null>(null);
  const node = useRef<HTMLDivElement>(null);

  useImperativeHandle(ref, () => ({
    get node() { return node.current; },
    setHoveredToken,
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
      segments.push(<span key={start}>{text}</span>);
      continue;
    }
    let className = token.kind === "capsule" ? styles.capsule : styles.command;
    if (!disabled && token.start === hoveredToken) className += ` ${styles.hovered}`;
    segments.push(
      // Tokens carry their range so pointer hit-testing can map a rect back to text offsets.
      <span
        key={start}
        className={className}
        style={token.logo ? {backgroundImage: token.logo} : undefined}
        data-token-start={token.start}
        data-token-end={token.start + token.length}
      >
        {text}
      </span>,
    );
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
