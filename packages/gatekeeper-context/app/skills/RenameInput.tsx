import { Text } from "@cloudflare/kumo";
import { useLayoutEffect, useRef, useState } from "react";
import { humanizeSkillName, sanitizeSkillTitle, skillNameFromTitle } from "./skillName";

type RenameInputProps = {
  initialValue: string;
  format: "skill" | "collection";
  onCommit: (value: string) => void;
  onCancel: () => void;
};

/** Single-line editor used for inline skill and collection renaming. */
export const RenameInput = ({ initialValue, format, onCommit, onCancel }: RenameInputProps) => {
  const [value, setValue] = useState(
    format === "skill" ? humanizeSkillName(initialValue) : initialValue,
  );
  const inputRef = useRef<HTMLInputElement>(null);
  const mayReceiveStaleMenuFocusRef = useRef(true);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const committed = format === "skill" ? skillNameFromTitle(value) : value.trim();
    if (committed && committed !== initialValue.trim()) onCommit(committed);
    else onCancel();
  };

  return (
    <Text as="span" size="sm" DANGEROUS_className="min-w-0 flex-1 flex items-center">
      <input
        ref={inputRef}
        type="text"
        aria-label={`Rename ${format}`}
        value={value}
        onChange={(event) => {
          const singleLine = event.target.value.replace(/\n/g, "");
          setValue(format === "skill" ? sanitizeSkillTitle(singleLine) : singleLine);
        }}
        maxLength={format === "skill" ? 64 : undefined}
        onBlur={(event) => {
          const next = event.relatedTarget;
          if (mayReceiveStaleMenuFocusRef.current
            && next instanceof HTMLElement
            && next.matches('[aria-haspopup="menu"]')) {
            mayReceiveStaleMenuFocusRef.current = false;
            queueMicrotask(() => inputRef.current?.focus());
            return;
          }
          mayReceiveStaleMenuFocusRef.current = false;
          commit();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        className="inline-block h-auto overflow-hidden rounded-sm border-0 bg-kumo-recessed p-0 m-0 shadow-none outline-none ring-0 focus:outline-none focus:ring-0"
        style={{
          font: "inherit",
          lineHeight: "inherit",
          color: "inherit",
          fieldSizing: "content",
        }}
      />
    </Text>
  );
};
