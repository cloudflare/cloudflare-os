import emojiData from "@emoji-mart/data";
import { Picker as EmojiMartPicker } from "emoji-mart";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useResolvedThemeMode } from "../bridge";

export const DEFAULT_COLLECTION_ICON = "📚";

/** Props for {@link CollectionIconPicker}. */
export type CollectionIconPickerProps = {
  id?: string;
  value?: string;
  onChange: (emoji: string) => void;
  size?: number;
  /** "boxed": standalone bordered tile (settings modal). "inline": borderless tile that sits inside a shared input pill. */
  variant?: "boxed" | "inline";
};

/** Button that opens an emoji picker for choosing a collection icon. */
export function CollectionIconPicker({
  id,
  value,
  onChange,
  size = 32,
  variant = "boxed",
}: CollectionIconPickerProps) {
  const themeMode = useResolvedThemeMode();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pickerHostRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapRef.current?.contains(target)
        || pickerHostRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Fixed-position layer anchored to the trigger so the form can't clip it. Opens above the trigger
  // by default, flips below when there's no room, and stays glued to the button on scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const PICKER_W = 352;
    const PICKER_H = 435;
    const GAP = 6;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const roomAbove = rect.top;
      const roomBelow = window.innerHeight - rect.bottom;
      const openAbove = roomAbove >= PICKER_H + GAP || roomAbove >= roomBelow;
      const top = openAbove
        ? Math.max(GAP, rect.top - GAP - PICKER_H)
        : Math.min(window.innerHeight - PICKER_H - GAP, rect.bottom + GAP);
      const left = Math.min(
        Math.max(GAP, rect.left),
        window.innerWidth - PICKER_W - GAP,
      );
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pickerHostRef.current) return;
    const host = pickerHostRef.current;
    const picker = new (EmojiMartPicker as any)({
      data: emojiData,
      theme: themeMode,
      previewPosition: "none",
      skinTonePosition: "none",
      // Hide the "Frequently used" category.
      maxFrequentRows: 0,
      onEmojiSelect: (e: { native: string }) => {
        onChange(e.native);
        setOpen(false);
      },
    });
    host.appendChild(picker as unknown as Node);
    return () => {
      host.replaceChildren();
    };
  }, [open, onChange, themeMode]);

  const inline = variant === "inline";
  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        ref={btnRef}
        id={id}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Choose an icon"
        className={
          inline
            ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-[18px] leading-none text-kumo-subtle transition-colors hover:bg-kumo-fill"
            : "grid place-items-center rounded-lg border border-kumo-line bg-kumo-base hover:border-kumo-brand transition-colors"
        }
        style={
          inline
            ? undefined
            : {
                width: size + 12,
                height: size + 12,
                fontSize: size * 0.66,
                lineHeight: 1,
              }
        }
      >
        <span>{value || DEFAULT_COLLECTION_ICON}</span>
      </button>
      {open
        // Portaled to <body> so a transformed ancestor (e.g. .ctx-rise's fill-both transform) can't
        // become the containing block for `fixed` and offset the coordinates.
        && createPortal(
          <div
            ref={pickerHostRef}
            className="z-[2000]"
            style={{
              position: "fixed",
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              // Hidden until measured so it never flashes at (0,0).
              visibility: pos ? "visible" : "hidden",
            }}
          />,
          document.body,
        )}
    </div>
  );
}
