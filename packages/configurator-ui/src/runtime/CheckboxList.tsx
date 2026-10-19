import { Badge } from "@cloudflare/kumo/components/badge";
import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { Field } from "@cloudflare/kumo/primitives/field";
import { cn } from "@cloudflare/kumo/utils";
import { useEffect, useEffectEvent, useId, useState } from "react";
import type { CheckboxListProps, ConfiguratorUIOption } from "../index.ts";
import { useFieldLabel } from "./Field.tsx";
import { FilterInput } from "./FilterInput.tsx";
import {
  checkboxSelection, failureMessage, sanitizeOptions, withUnavailableOptions, type OptionsState,
} from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";
import type { ConfiguratorStore } from "./store.ts";
import { useCollectionHold, useConfiguratorState, useConfiguratorStore } from "./storeContext.ts";

/** The filter only earns its space once the list is long enough to scroll. */
const FILTER_THRESHOLD = 6;

const ListStatus = ({ name, text }: { name?: string; text: string }) => (
  <p data-name={name} className="m-0 text-sm text-kumo-subtle">{text}</p>
);

type OptionRowProps = {
  option: ConfiguratorUIOption;
  checked: boolean;
  disabled: boolean;
  onToggle(): void;
};

/**
 * One option, toggled from anywhere on its row. Its own field, as in Kumo's labelled `Checkbox`, so
 * the list's field label names none of the checkboxes; the title names it and the rest describes it.
 */
const OptionRow = ({ option, checked, disabled, onToggle }: OptionRowProps) => {
  const id = useId();
  const describedBy = [option.subtitle && `${id}-subtitle`, option.meta && `${id}-meta`]
    .filter(Boolean).join(" ");
  return (
    <Field.Root>
      <Field.Label
        className={cn("flex items-start gap-3 rounded-md px-2 py-1.5 text-sm",
          disabled ? "cursor-not-allowed" : "cursor-pointer hover:bg-kumo-tint")}
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          disabled={disabled}
          onCheckedChange={onToggle}
          aria-labelledby={`${id}-title`}
          aria-describedby={describedBy || undefined}
        />
        <span className="flex min-w-0 flex-1 flex-col">
          <span id={`${id}-title`} className="truncate">{option.title}</span>
          {option.subtitle ? (
            <span id={`${id}-subtitle`} className="truncate text-xs text-kumo-subtle">{option.subtitle}</span>
          ) : null}
        </span>
        {option.meta ? <Badge variant="secondary"><span id={`${id}-meta`}>{option.meta}</span></Badge> : null}
      </Field.Label>
    </Field.Root>
  );
};

/** One list's load, and its options once they arrive. */
type OptionsLoad = { promise: Promise<ConfiguratorUIOption[]>; options?: ConfiguratorUIOption[] };

/**
 * Loads by list name, per frame (store). The host mints a new frame whenever the account or resource
 * type changes, and a list whose options depend on anything else varies its name, so a name names
 * one list for the life of the frame. A load in flight is shared, so showing a name again before it
 * settles does not start another. Failures are not kept: showing the name again retries.
 */
const loadsByStore = new WeakMap<ConfiguratorStore, Map<string, OptionsLoad>>();

const loadsOf = (store: ConfiguratorStore) => {
  let loads = loadsByStore.get(store);
  if (!loads) loadsByStore.set(store, loads = new Map());
  return loads;
};

/** The name's load, in flight or done, or else a new one. */
const startLoad = (
  store: ConfiguratorStore, name: string, loadOptions: CheckboxListProps["loadOptions"],
): OptionsLoad => {
  const loads = loadsOf(store);
  const existing = loads.get(name);
  if (existing) return existing;
  const load: OptionsLoad = {
    promise: Promise.resolve().then(() => loadOptions()).then(options => sanitizeOptions(options, "refuse")),
  };
  load.promise.then(options => {
    load.options = options;
  }, () => loads.delete(name));
  loads.set(name, load);
  return load;
};

const cachedLoad = (store: ConfiguratorStore, name: string): OptionsState => {
  const options = loadsOf(store).get(name)?.options;
  return options ? { status: "ready", options } : { status: "loading" };
};

const NamedCheckboxList = ({
  name, value, loadOptions, onChange, allSelected = false, disabled = false,
}: CheckboxListProps) => {
  const store = useConfiguratorStore();
  const fieldLabel = useFieldLabel();
  const [optionsState, setOptionsState] = useState(() => cachedLoad(store, name));
  const filter = useConfiguratorState(state => state.filters[name] ?? "");
  // An inline `loadOptions` is new on every render, and must not reload.
  const load = useEffectEvent(loadOptions);

  // Followed even when it has settled: it may have done so since this render read the cache.
  useEffect(() => {
    const { promise } = startLoad(store, name, load);
    let cancelled = false;
    promise.then(loaded => {
      if (!cancelled) setOptionsState({ status: "ready", options: loaded });
    }, error => {
      if (cancelled) return;
      reportFrontendIssue("configurator.checkbox-list-load", error);
      setOptionsState({ status: "failed", message: failureMessage(error, "Could not load options.") });
    });
    return () => {
      cancelled = true;
    };
  }, [store, name]);

  useCollectionHold(name,
    optionsState.status === "failed" && !disabled ? "Configurator options did not load." : null);

  if (optionsState.status === "loading") return <ListStatus name={name} text="Loading..." />;
  if (optionsState.status === "failed") return <ListStatus name={name} text={optionsState.message} />;

  const options = withUnavailableOptions(optionsState.options, value);
  if (options.length === 0) return <ListStatus name={name} text="Nothing to choose from." />;
  const selected = checkboxSelection(optionsState.options, value, allSelected);

  const showFilter = options.length > FILTER_THRESHOLD;
  const needle = showFilter ? filter.trim().toLowerCase() : "";
  const matches = needle ? options.filter(option =>
    option.value.toLowerCase().includes(needle)
    || option.title.toLowerCase().includes(needle)
    || (option.subtitle ?? "").toLowerCase().includes(needle)) : options;

  const emit = (next: Set<string>) => {
    const ordered = options.map(option => option.value).filter(option => next.has(option));
    onChange(ordered.length > 0 ? ordered.join(",") : null);
  };
  const toggle = (option: string) => {
    const next = new Set(selected);
    if (next.has(option)) next.delete(option);
    else next.add(option);
    emit(next);
  };

  // Bulk actions apply to what is visible, so filtering then "select all" is a deliberate, narrow
  // gesture, and clearing a filtered list leaves hidden selections alone.
  const selectable = matches.filter(option => !selected.has(option.value));
  const clearable = matches.filter(option => selected.has(option.value));

  return (
    // Spans the field's grid: Kumo's `Field` lays out any field holding a checkbox as one checkbox
    // beside its label, which would push the label of a whole list into a column of its own.
    <div data-name={name}
      className="col-span-full flex flex-col overflow-hidden rounded-lg border border-kumo-line bg-kumo-base">
      <div className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-2 border-b border-kumo-line p-2 pl-3">
        {showFilter ? (
          <div className="min-w-40 flex-1">
            <FilterInput label="Filter options" placeholder="Filter..." value={filter} disabled={disabled}
              onChange={text => store.setFilter(name, text)} />
          </div>
        ) : null}
        <span className={cn("text-sm", !showFilter && "flex-1", selected.size > 0 ? "font-medium" : "text-kumo-subtle")}>
          {selected.size > 0
            ? `${selected.size} of ${options.length} selected`
            : `None of ${options.length} selected`}
        </span>
        {disabled ? null : (
          <span className="flex shrink-0 gap-1">
            {selectable.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => emit(new Set([...selected, ...selectable.map(option => option.value)]))}
              >
                {needle ? `Select ${matches.length} shown` : "Select all"}
              </Button>
            ) : null}
            {clearable.length > 0 ? (
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  const next = new Set(selected);
                  for (const option of clearable) next.delete(option.value);
                  emit(next);
                }}
              >
                {needle ? `Clear ${clearable.length} shown` : "Clear"}
              </Button>
            ) : null}
          </span>
        )}
      </div>

      {matches.length === 0 ? (
        <p className="m-0 p-3 text-sm text-kumo-subtle">{`Nothing matches "${filter.trim()}".`}</p>
      ) : (
        // Keyed by the filter so a new filter starts at the top, while selecting keeps the scroll.
        <div key={needle} role="group" aria-label={fieldLabel ?? undefined}
          className="flex max-h-66 flex-col overflow-y-auto p-1">
          {matches.map(option => (
            <OptionRow
              key={option.value}
              option={option}
              checked={selected.has(option.value)}
              disabled={disabled}
              onToggle={() => toggle(option.value)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

/** Mounted afresh for each name, so nothing one list loaded or failed shows under another's. */
export const CheckboxList = (props: CheckboxListProps) => <NamedCheckboxList key={props.name} {...props} />;
