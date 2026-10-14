import { Button } from "@cloudflare/kumo/components/button";
import { Checkbox } from "@cloudflare/kumo/components/checkbox";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CheckboxListProps, ConfiguratorUIOption } from "../index.ts";
import { useFieldLabel } from "./Field.tsx";
import { FilterInput } from "./FilterInput.tsx";
import {
  checkboxSelection, failureMessage, sanitizeOptions, withUnavailableOptions,
} from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";
import type { ConfiguratorStore } from "./store.ts";
import { useConfiguratorStore } from "./storeContext.ts";

type Load =
  | { name: string; status: "loading" }
  | { name: string; status: "ready"; options: ConfiguratorUIOption[] }
  | { name: string; status: "failed"; message: string };

/** The filter only earns its space once the list is long enough to scroll. */
const FILTER_THRESHOLD = 6;

const Notice = ({ name, text }: { name: string; text: string }) => (
  <p data-name={name} className="m-0 text-sm text-kumo-subtle">{text}</p>
);

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
    promise: Promise.resolve().then(loadOptions).then(options => sanitizeOptions(options, "refuse")),
  };
  load.promise.then(options => {
    load.options = options;
  }, () => loads.delete(name));
  loads.set(name, load);
  return load;
};

const cachedLoad = (store: ConfiguratorStore, name: string): Load => {
  const options = loadsOf(store).get(name)?.options;
  return options ? { name, status: "ready", options } : { name, status: "loading" };
};

export const CheckboxList = ({
  name, value, loadOptions, onChange, allSelected = false, disabled = false,
}: CheckboxListProps) => {
  const store = useConfiguratorStore();
  const fieldLabel = useFieldLabel();
  const [load, setLoad] = useState(() => cachedLoad(store, name));
  const [filter, setFilter] = useState("");
  // Read from the effect so that an inline `loadOptions`, new on every render, does not reload.
  const loadOptionsRef = useRef(loadOptions);
  loadOptionsRef.current = loadOptions;

  useEffect(() => {
    // Even when cached: an earlier name's failure left here would flash back if that name returns.
    setLoad(shown => shown.name === name ? shown : cachedLoad(store, name));
    const { promise, options } = startLoad(store, name, () => loadOptionsRef.current());
    if (options) return;
    let cancelled = false;
    promise.then(loaded => {
      if (!cancelled) setLoad({ name, status: "ready", options: loaded });
    }, error => {
      if (cancelled) return;
      reportFrontendIssue("configurator.checkbox-list-load", error);
      setLoad({ name, status: "failed", message: failureMessage(error, "Could not load options.") });
    });
    return () => {
      cancelled = true;
    };
  }, [store, name]);

  const current = load.name === name ? load : cachedLoad(store, name);
  const blocking = current.status === "failed" && !disabled;
  // A layout effect, so the failure is on record before anything collects in the same turn.
  useLayoutEffect(() => {
    store.setListFailed(name, blocking);
    return () => store.setListFailed(name, false);
  }, [store, name, blocking]);

  if (current.status === "loading") return <Notice name={name} text="Loading..." />;
  if (current.status === "failed") return <Notice name={name} text={current.message} />;

  const options = withUnavailableOptions(current.options, value);
  if (options.length === 0) return <Notice name={name} text="Nothing to choose from." />;
  const selected = checkboxSelection(current.options, value, allSelected);

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
    <div data-name={name} className="grid gap-2">
      {showFilter ? (
        <FilterInput label="Filter options" placeholder="Filter..." value={filter} disabled={disabled}
          onChange={setFilter} />
      ) : null}

      <div className="flex items-baseline justify-between gap-3">
        <span className={selected.size > 0 ? "text-sm font-medium" : "text-sm text-kumo-subtle"}>
          {selected.size > 0
            ? `${selected.size} of ${options.length} selected`
            : `None of ${options.length} selected`}
        </span>
        <span className="flex shrink-0 gap-1">
          {selectable.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
              onClick={() => emit(new Set([...selected, ...selectable.map(option => option.value)]))}
            >
              {needle ? `Select ${matches.length} shown` : "Select all"}
            </Button>
          ) : null}
          {clearable.length > 0 ? (
            <Button
              variant="ghost"
              size="xs"
              disabled={disabled}
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
      </div>

      {matches.length === 0 ? (
        <p className="m-0 text-sm text-kumo-subtle">{`Nothing matches "${filter.trim()}".`}</p>
      ) : (
        // Keyed by the filter so a new filter starts at the top, while selecting keeps the scroll.
        <div key={needle} role="group" aria-label={fieldLabel ?? undefined}
          className="grid max-h-66 gap-0.5 overflow-y-auto p-px">
          {matches.map(option => {
            const isSelected = selected.has(option.value);
            return (
              <div
                key={option.value}
                className={isSelected
                  ? "rounded-md px-2.5 py-2 ring ring-kumo-ring bg-kumo-tint"
                  : "rounded-md px-2.5 py-2 hover:bg-kumo-elevated"}
              >
                <Checkbox
                  checked={isSelected}
                  disabled={disabled}
                  onCheckedChange={() => toggle(option.value)}
                  label={(
                    <span className="grid min-w-0 gap-px">
                      <span className="flex min-w-0 items-baseline gap-2">
                        <span className="truncate">{option.title}</span>
                        {option.meta ? (
                          <span className="ml-auto shrink-0 rounded bg-kumo-elevated px-1.5 text-xs text-kumo-subtle">
                            {option.meta}
                          </span>
                        ) : null}
                      </span>
                      {option.subtitle ? (
                        <span className="truncate text-sm text-kumo-subtle">{option.subtitle}</span>
                      ) : null}
                    </span>
                  )}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
