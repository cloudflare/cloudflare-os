import { Input } from "@cloudflare/kumo/components/input";
import type { TextInputProps } from "../index.ts";
import { useFieldLabel } from "./Field.tsx";

export const TextInput = ({ name, value, placeholder, onChange, optional, disabled }: TextInputProps) => (
  <Input
    name={name}
    // The enclosing field's `<label>` already names the input through `aria-labelledby`, which takes
    // precedence; Kumo checks only the props it is given, so without this it warns on every input.
    aria-label={useFieldLabel() ?? undefined}
    value={value ?? ""}
    placeholder={placeholder}
    disabled={disabled}
    autoComplete="off"
    onChange={event => onChange(event.currentTarget.value || (optional ? null : ""))}
  />
);
