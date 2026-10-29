import { Radio } from "@cloudflare/kumo/components/radio";
import { Field } from "@cloudflare/kumo/primitives/field";
import { Radio as RadioPrimitive } from "@cloudflare/kumo/primitives/radio";
import { RadioGroup } from "@cloudflare/kumo/primitives/radio-group";
import type { RadioCardsProps } from "../index.ts";
import { radioMark } from "./radioMark.ts";

/**
 * Named by the enclosing `Field`, whose label Base UI attaches to the radio group. Base UI would
 * also give every radio that label; each `Field.Item` keeps an option named by its own text.
 */
export const RadioCards = ({ value, options, onChange, compact }: RadioCardsProps) => {
  const onValueChange = (next: unknown) => {
    if (typeof next === "string") onChange(next);
  };
  if (!compact) {
    return (
      <Radio.Group appearance="card" value={value ?? null} onValueChange={onValueChange}>
        {options.map(option => (
          <Field.Item key={option.value}>
            <Radio.Item value={option.value} label={option.title} description={option.description} />
          </Field.Item>
        ))}
      </Radio.Group>
    );
  }
  // Rows in one box, as the hierarchy picker's are, with its radio, and a pixel apart so a hovered
  // row's tint doesn't run into the chosen one's. The box is as wide as it is given rather than as
  // its widest line, so a long line truncates, the description first.
  return (
    <RadioGroup
      value={value ?? null}
      onValueChange={onValueChange}
      className="flex min-w-0 flex-col gap-px rounded-lg border border-kumo-line bg-kumo-base p-1"
    >
      {options.map(option => (
        <Field.Item key={option.value}>
          <label className="group/choice flex cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-sm hover:bg-kumo-tint has-data-checked:bg-kumo-tint">
            <RadioPrimitive.Root
              value={option.value}
              className={state => `${radioMark(state.checked ? "checked" : "unchecked")} outline-none focus-visible:ring-2 focus-visible:ring-kumo-focus`}
            />
            <span className="flex min-w-0 gap-1.5">
              <span className="min-w-0 truncate font-medium">{option.title}</span>
              {option.description && <>
                <span aria-hidden="true" className="text-kumo-subtle">·</span>
                <span className="min-w-0 shrink-[3] truncate text-kumo-subtle">{option.description}</span>
              </>}
            </span>
          </label>
        </Field.Item>
      ))}
    </RadioGroup>
  );
};
