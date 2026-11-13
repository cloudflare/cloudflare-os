import { useRef } from "react";
import { isImeComposing } from "../../keyboardEvent";

/**
 * An inline folder name field. Enter or leaving it reports the name; Escape reports null.
 * Starts focused with its text selected.
 */
export const FolderNameInput = ({ initialName, onDone }: {
  initialName: string;
  onDone: (name: string | null) => void;
}) => {
  // Enter and Escape unmount the input, which can then report a blur too; only the first counts.
  const doneRef = useRef(false);
  const finish = (value: string | null) => {
    if (doneRef.current) return;
    doneRef.current = true;
    onDone(value);
  };

  return (
    <input
      type="text"
      defaultValue={initialName}
      placeholder="Folder name"
      autoFocus
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={(e) => {
        if (isImeComposing(e)) return;
        if (e.key === "Enter") {
          e.preventDefault();
          finish(e.currentTarget.value);
        } else if (e.key === "Escape") {
          e.preventDefault();
          finish(null);
        }
      }}
      onBlur={(e) => finish(e.currentTarget.value)}
      spellCheck={false}
      autoComplete="off"
      aria-label="Folder name"
      className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
    />
  );
};
