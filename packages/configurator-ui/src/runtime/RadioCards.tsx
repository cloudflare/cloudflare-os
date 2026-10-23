import { Radio } from "@cloudflare/kumo/components/radio";
import { Field } from "@cloudflare/kumo/primitives/field";
import type { RadioCardsProps } from "../index.ts";

/**
 * Named by the enclosing `Field`, whose label Base UI attaches to the radio group. Base UI would
 * also give every radio that label; each `Field.Item` keeps a card named by its own title.
 */
export const RadioCards = ({ value, options, onChange }: RadioCardsProps) => (
  <Radio.Group
    appearance="card"
    value={value ?? null}
    onValueChange={next => {
      if (typeof next === "string") onChange(next);
    }}
  >
    {options.map(option => (
      <Field.Item key={option.value}>
        <Radio.Item value={option.value} label={option.title} description={option.description} />
      </Field.Item>
    ))}
  </Radio.Group>
);
