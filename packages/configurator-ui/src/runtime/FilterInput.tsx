import { inputVariants } from "@cloudflare/kumo/components/input";
import { cn } from "@cloudflare/kumo/utils";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { KeyboardEvent } from "react";

type FilterInputProps = {
  label: string;
  value: string;
  placeholder?: string;
  disabled: boolean;
  onChange(value: string): void;
  onKeyDown?(event: KeyboardEvent<HTMLInputElement>): void;
};

/**
 * A search box that narrows the control it sits in. A native input with Kumo's input styling
 * rather than Kumo's `Input`, which would register as the enclosing `Field`'s control and take the
 * field's label, leaving the list the field describes unnamed.
 */
export const FilterInput = ({ label, value, placeholder, disabled, onChange, onKeyDown }: FilterInputProps) => (
  <div className="relative flex items-center">
    <MagnifyingGlassIcon aria-hidden size={14} className="pointer-events-none absolute left-2.5 text-kumo-subtle" />
    <input
      type="search"
      aria-label={label}
      className={cn(inputVariants({ size: "sm", focusIndicator: true }), "w-full pl-8")}
      value={value}
      placeholder={placeholder ?? label}
      disabled={disabled}
      autoComplete="off"
      onChange={event => onChange(event.currentTarget.value)}
      onKeyDown={onKeyDown}
    />
  </div>
);
