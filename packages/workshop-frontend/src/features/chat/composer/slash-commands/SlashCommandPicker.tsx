import { RpcStub } from "capnweb";
import { createPortal } from "react-dom";
import {
  useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type RefObject, type SetStateAction,
} from "react";
import type { Overseer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { CaretRightIcon, ScrollIcon } from "@phosphor-icons/react";
import { PICKER_EMPTY, TabHint } from "../../../../components/pickerRows";
import {
  exactSlashCommandMatches, filterSlashCommandCatalog, parseSlashCommandInput,
  slashCommandTokenKey, type ParsedSlashCommandInput,
} from "./slashCommandInput";
import {
  invalidateSlashCommandCatalog,
  loadSlashCommandCatalog,
  slashCommandKey,
} from "../../../../components/chat/slash-command-catalog";

type SlashCommandPopupLayout = {
  left: number;
  top?: number;
  bottom?: number;
  width: number;
  maxHeight: number;
};

function computePopupLayout(anchor: HTMLElement): SlashCommandPopupLayout {
  const popup = { margin: 12, gap: 8, minHeight: 120, maxHeight: 440 };
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.min(rect.width, viewportWidth - popup.margin * 2);
  const left = Math.min(
    Math.max(rect.left, popup.margin),
    viewportWidth - width - popup.margin,
  );
  const spaceAbove = rect.top - popup.margin - popup.gap;
  const spaceBelow = viewportHeight - rect.bottom - popup.margin - popup.gap;
  const openBelow = spaceBelow >= popup.minHeight || spaceBelow > spaceAbove;
  const available = Math.max(openBelow ? spaceBelow : spaceAbove, popup.minHeight);
  return {
    left,
    width,
    maxHeight: Math.min(popup.maxHeight, available),
    ...(openBelow
      ? { top: rect.bottom + popup.gap }
      : { bottom: viewportHeight - rect.top + popup.gap }),
  };
}

export function useSlashCommandPicker({
  inputValue,
  cursorPosition,
  selectedCommand,
  disabled,
  anchorRef,
  getOverseer,
  onSelect,
  chatExists,
}: {
  inputValue: string;
  cursorPosition: number;
  selectedCommand: SlashCommandChoice | null;
  disabled: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  onSelect: (choice: SlashCommandChoice, tokenStart: number, tokenEnd: number) => void;
  /**
   * Whether the composer is attached to an existing chat. A built-in command acts on the chat it is
   * sent to, so starting a new one with it would leave an empty thread and do nothing.
   */
  chatExists: boolean;
}) {
  const [choices, setChoices] = useState<SlashCommandChoice[]>([]);
  const [choicesQuery, setChoicesQuery] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dismissedToken, setDismissedToken] = useState<string | null>(null);
  const [explicitChoiceToken, setExplicitChoiceToken] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const [layout, setLayout] = useState<SlashCommandPopupLayout | null>(null);
  const catalogRef = useRef<SlashCommandChoice[] | null>(null);
  const catalogSourceRef = useRef(getOverseer);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const offerable = useCallback((catalog: SlashCommandChoice[]) =>
      chatExists ? catalog : catalog.filter(choice => choice.selection.builtin !== true),
    [chatExists]);

  const parsed = selectedCommand || disabled
    ? null
    : parseSlashCommandInput(inputValue, cursorPosition);
  const activeToken = parsed ? slashCommandTokenKey(inputValue, cursorPosition) : null;
  const open = parsed !== null && dismissedToken !== activeToken;
  const query = parsed?.query ?? "";
  const selectable = choicesQuery === query && !loading && error === null;
  const exactMatches = parsed && selectable
    ? exactSlashCommandMatches(offerable(catalogRef.current ?? choices), parsed)
    : [];
  const exactIndex = exactMatches.length === 1 ? choices.indexOf(exactMatches[0]) : -1;
  const requiresExplicitChoice = exactMatches.length > 1;
  const activeChoice = !requiresExplicitChoice || explicitChoiceToken === activeToken
    ? choices[index]
    : undefined;
  const selectIndex = (next: SetStateAction<number>) => {
    setIndex(next);
    setExplicitChoiceToken(activeToken);
  };

  if (catalogSourceRef.current !== getOverseer) {
    catalogSourceRef.current = getOverseer;
    catalogRef.current = null;
  }

  const loadCatalog = useCallback(async () => {
    if (catalogRef.current) return catalogRef.current;
    const source = getOverseer;
    const catalog = await loadSlashCommandCatalog(source);
    if (catalogSourceRef.current === source) catalogRef.current = catalog;
    return catalog;
  }, [getOverseer]);

  const select = useCallback((choice: SlashCommandChoice) => {
    const current = parseSlashCommandInput(inputValue, cursorPosition);
    if (!current) return;
    onSelect(choice, current.tokenStart, current.tokenEnd);
    setChoices([]);
    setChoicesQuery(null);
    setDismissedToken(null);
  }, [cursorPosition, inputValue, onSelect]);

  useEffect(() => setExplicitChoiceToken(null), [activeToken]);

  const resolveExact = useCallback(async (current: ParsedSlashCommandInput) => {
    const matches = exactSlashCommandMatches(offerable(await loadCatalog()), current);
    return matches.length === 1 ? matches[0] : null;
  }, [loadCatalog, offerable]);

  const invalidateCatalog = useCallback(() => {
    catalogRef.current = null;
    invalidateSlashCommandCatalog(getOverseer);
  }, [getOverseer]);

  useEffect(() => {
    if (!parsed) {
      setChoices([]);
      setChoicesQuery(null);
      setLoading(false);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(catalogRef.current === null);
    setError(null);
    loadCatalog()
      .then((catalog) => {
        if (cancelled) return;
        setChoices(filterSlashCommandCatalog(offerable(catalog), query));
        setChoicesQuery(query);
        setIndex(0);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoading(false);
        setError(err instanceof Error ? err.message : `${err}`);
        console.error("Failed to list slash commands:", err);
      });
    return () => {
      cancelled = true;
    };
  }, [loadCatalog, offerable, parsed !== null, query]);

  useEffect(() => {
    if (exactIndex >= 0) setIndex(exactIndex);
  }, [exactIndex, query]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setLayout(null);
      return;
    }
    const update = () => {
      if (anchorRef.current) setLayout(computePopupLayout(anchorRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, choices.length, error, loading, open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${index}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [index]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (popupRef.current?.contains(target) || anchorRef.current?.contains(target)) return;
      setDismissedToken(activeToken);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [activeToken, anchorRef, open]);

  const popup = open && layout ? createPortal(
    <div
      ref={popupRef}
      className="themed-floating-shadow-lg fixed z-[1000] flex flex-col overflow-hidden rounded-2xl border border-kumo-line/70 bg-kumo-base"
      style={layout}
    >
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Slash commands"
        aria-busy={loading}
        className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2"
      >
        {loading && choices.length === 0 ? (
          <p className={PICKER_EMPTY}>Loading commands…</p>
        ) : choices.length > 0 ? (
          choices.map((choice, optionIndex) => (
            <button
              key={slashCommandKey(choice.selection)}
              id={`${listboxId}-option-${optionIndex}`}
              data-index={optionIndex}
              type="button"
              role="option"
              aria-selected={optionIndex === index && activeChoice !== undefined}
              disabled={!selectable}
              title={[
                `/${choice.name}`,
                choice.description,
                [choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · "),
              ].join("\n")}
              className={`flex w-full cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${optionIndex === index ? "bg-kumo-tint text-kumo-strong" : "text-kumo-default hover:bg-kumo-tint/70"}`}
              onMouseMove={() => setIndex(optionIndex)}
              onClick={() => select(choice)}
            >
              <ScrollIcon size={16} className="shrink-0" />
              <span className="flex min-w-0 flex-1 items-center gap-2">
                <span className="max-w-[35%] shrink-0 truncate">{choice.name}</span>
                <CaretRightIcon size={11} aria-hidden="true" className="shrink-0 text-kumo-inactive" />
                <span className="min-w-0 flex-1 truncate text-kumo-subtle">{choice.description}</span>
              </span>
              {optionIndex === index && selectable && <TabHint />}
            </button>
          ))
        ) : (
          <p className={PICKER_EMPTY}>
            {error
              ? `Couldn’t load commands. ${error}`
              : query
                ? "No commands match your search."
                : "No commands are available."}
          </p>
        )}
      </div>
    </div>,
    document.body,
  ) : null;

  return {
    activeChoice,
    activeDescendant: open && selectable && activeChoice
      ? `${listboxId}-option-${index}`
      : undefined,
    choices,
    dismiss: () => setDismissedToken(activeToken),
    invalidateCatalog,
    listboxId,
    open,
    popup,
    resolveExact,
    select,
    selectable,
    setIndex: selectIndex,
    status: open
      ? loading
        ? "Loading slash commands"
        : error
          ? `Slash commands unavailable: ${error}`
          : `${choices.length} slash command${choices.length === 1 ? "" : "s"} found`
      : "",
  };
}
