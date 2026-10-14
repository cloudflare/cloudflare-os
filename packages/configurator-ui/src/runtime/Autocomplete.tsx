import { Combobox } from "@cloudflare/kumo/components/combobox";
import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from "react";
import type { AutocompleteProps, ConfiguratorUIOption } from "../index.ts";
import { failureMessage, sanitizeOptions } from "./options.ts";
import { reportFrontendIssue } from "./reporting.ts";
import { useConfiguratorState, useConfiguratorStore } from "./storeContext.ts";

type Suggestions =
  | { status: "loading" }
  | { status: "ready"; options: ConfiguratorUIOption[] }
  | { status: "failed"; message: string };

const DEBOUNCE_MS = 180;
const POPUP_MAX_HEIGHT = 240;
const POPUP_MIN_HEIGHT = 96;
const POPUP_MARGIN = 12;
/** Set on the document because the popup portals out of the field, beyond any local variable. */
const POPUP_HEIGHT_VARIABLE = "--configurator-popup-max-height";

const sameOption = (a: ConfiguratorUIOption, b: ConfiguratorUIOption) => a.value === b.value;

/** On hover, a row cut short by the popup's width offers its whole text as a tooltip. */
const showWholeIfClipped = (option: ConfiguratorUIOption) => (event: PointerEvent<HTMLElement>) => {
  const row = event.currentTarget;
  const clipped = Array.from(row.children).some(part => part.scrollWidth > part.clientWidth);
  row.title = clipped ? [option.title, option.subtitle, option.meta].filter(Boolean).join("\n") : "";
};

/**
 * Searches the gatekeeper as the user types and selects one result. The input shows the typed query
 * (kept in the store by field name, so `clearFields` can drop it) rather than the value; a
 * pre-filled value with no title yet shows the value itself.
 */
export const Autocomplete = ({
  name, value, placeholder, loadOptions, onChange, onClear, disabled = false,
}: AutocompleteProps) => {
  const store = useConfiguratorStore();
  const queryName = name || placeholder;
  const storedQuery = useConfiguratorState(state => state.queries[queryName] ?? "");
  const viewport = useConfiguratorState(state => state.viewport);
  const closeRequests = useConfiguratorState(state => state.popupCloseRequests);
  // A disabled field with no value forgets what was typed into it, so enabling it again (once the
  // field it depends on is chosen) starts blank, as configurators written for the old runtime expect.
  const forgetQuery = disabled && !value && storedQuery !== "";
  useEffect(() => {
    if (forgetQuery) store.setQuery(queryName, "");
  }, [forgetQuery, store, queryName]);
  const query = forgetQuery ? "" : storedQuery;

  const [open, setOpen] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestions>({ status: "loading" });
  const anchorRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef(0);
  const timerRef = useRef<number | undefined>(undefined);
  const loadOptionsRef = useRef(loadOptions);
  loadOptionsRef.current = loadOptions;
  const load = async (text: string) => {
    clearTimeout(timerRef.current);
    const request = ++requestRef.current;
    setSuggestions({ status: "loading" });
    try {
      const options = sanitizeOptions(await loadOptionsRef.current(text), "truncate");
      if (request === requestRef.current) setSuggestions({ status: "ready", options });
    } catch (error) {
      if (request !== requestRef.current) return;
      reportFrontendIssue("configurator.autocomplete-load", error);
      setSuggestions({ status: "failed", message: failureMessage(error, "Could not load options.") });
    }
  };
  const loadSoon = (text: string) => {
    clearTimeout(timerRef.current);
    // What is listed answers an earlier query. Withdraw it now rather than when the debounce fires,
    // so a quick Enter cannot pick it and a late reply to that query is discarded.
    requestRef.current++;
    setSuggestions({ status: "loading" });
    timerRef.current = window.setTimeout(() => void load(text), DEBOUNCE_MS);
  };

  useEffect(() => () => {
    clearTimeout(timerRef.current);
    requestRef.current++;
  }, []);

  // The host resized its window, so the popup's position is stale, or focus left for the host.
  const seenCloseRequests = useRef(closeRequests);
  useEffect(() => {
    if (closeRequests === seenCloseRequests.current) return;
    seenCloseRequests.current = closeRequests;
    setOpen(false);
    if (anchorRef.current?.contains(document.activeElement)) {
      (document.activeElement as HTMLElement).blur();
    }
  }, [closeRequests]);

  // The frame is only as tall as the form, so the popup is fitted to the host's viewport instead:
  // below the input, down to the bottom of what the host can show.
  useLayoutEffect(() => {
    if (!open) return;
    const anchorBottom = anchorRef.current?.getBoundingClientRect().bottom ?? 0;
    const available = viewport.viewportHeight
      ? viewport.viewportHeight - (viewport.iframeTop + anchorBottom) - POPUP_MARGIN
      : POPUP_MAX_HEIGHT;
    const height = Math.max(POPUP_MIN_HEIGHT, Math.min(POPUP_MAX_HEIGHT, available));
    document.documentElement.style.setProperty(POPUP_HEIGHT_VARIABLE, `${height}px`);
  }, [open, viewport]);

  const options = suggestions.status === "ready" ? suggestions.options : [];
  const selected = value ? options.find(option => option.value === value)
    ?? { value, title: query || value } : null;
  const status = suggestions.status === "loading" ? "Loading..."
    : suggestions.status === "failed" ? suggestions.message
    : options.length === 0 ? "No matches." : null;

  return (
    <div ref={anchorRef}>
      <Combobox<ConfiguratorUIOption>
        items={options}
        value={selected}
        filter={null}
        disabled={disabled}
        open={open}
        inputValue={query}
        itemToStringLabel={option => option.title}
        isItemEqualToValue={sameOption}
        onOpenChange={next => {
          setOpen(next);
          // From the store, not this render: typing that opens the popup has already stored its text.
          if (next) void load(store.getState().queries[queryName] ?? "");
        }}
        onInputValueChange={(text, details) => {
          store.setQuery(queryName, text);
          // Base UI's clear button leaves the popup open, listing what answered the cleared text.
          if (details.reason === "clear-press" && open) void load("");
          if (details.reason !== "input-change") return;
          // Typing over a choice abandons it.
          if (value) onChange(null);
          loadSoon(text);
        }}
        onValueChange={(next, details) => {
          if (next) {
            store.setQuery(queryName, next.title);
            onChange(next.value);
            return;
          }
          store.setQuery(queryName, "");
          if (details.reason === "clear-press" && onClear) onClear();
          // Emptying the text already abandoned the choice, in onInputValueChange.
          else if (value && details.reason !== "input-clear") onChange(null);
        }}
      >
        <Combobox.TriggerInput placeholder={placeholder} autoComplete="off" />
        <Combobox.Content
          collisionAvoidance={{ side: "none" }}
          className="w-(--anchor-width) max-h-(--configurator-popup-max-height)"
        >
          {status ? (
            <div role="status" className="px-3.5 py-1.5 text-sm text-kumo-subtle">{status}</div>
          ) : null}
          <Combobox.List>
            {(option: ConfiguratorUIOption) => (
              // Kumo's `1fr` column grows to its longest row; `minmax(0,1fr)` lets rows truncate.
              <Combobox.Item key={option.value} value={option} className="grid-cols-[minmax(0,1fr)_16px]">
                <span className="flex min-w-0 items-baseline gap-2" onPointerEnter={showWholeIfClipped(option)}>
                  <span className="truncate">{option.title}</span>
                  {option.subtitle ? (
                    <span className="min-w-0 flex-1 truncate text-sm text-kumo-subtle">
                      {option.subtitle}
                    </span>
                  ) : null}
                  {option.meta ? (
                    <span className="ml-auto shrink-0 text-sm text-kumo-subtle">{option.meta}</span>
                  ) : null}
                </span>
              </Combobox.Item>
            )}
          </Combobox.List>
        </Combobox.Content>
      </Combobox>
    </div>
  );
};
