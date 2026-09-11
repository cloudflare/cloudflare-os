import { Text } from "@cloudflare/kumo";
import { useLayoutEffect, useRef, useState } from "react";
import { formatSkillName } from "./addSkillNavigatorNode";

type RenameInputProps = {
  initialValue: string;
  format: "skill" | "collection";
  onCommit: (value: string) => void;
  onCancel: () => void;
};

/** Single-line editor used for inline skill and collection renaming. */
export const RenameInput = ({ initialValue, format, onCommit, onCancel }: RenameInputProps) => {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useLayoutEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const commit = () => {
    const trimmed = value.trim();
    if (trimmed && trimmed !== initialValue.trim()) onCommit(trimmed);
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
          setValue(format === "skill" ? formatSkillName(singleLine) : singleLine);
        }}
        onBlur={commit}
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
