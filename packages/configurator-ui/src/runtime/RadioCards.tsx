import { Radio } from "@cloudflare/kumo/components/radio";
import type { RadioCardsProps } from "../index.ts";

/** Named by the enclosing `Field`, whose label Base UI attaches to the radio group. */
export const RadioCards = ({ value, options, onChange }: RadioCardsProps) => (
  <Radio.Group
    appearance="card"
    value={value ?? null}
    onValueChange={next => {
      if (typeof next === "string") onChange(next);
    }}
  >
    {options.map(option => (
      <Radio.Item
        key={option.value}
        value={option.value}
        label={option.title}
        description={option.description}
      />
    ))}
  </Radio.Group>
);
