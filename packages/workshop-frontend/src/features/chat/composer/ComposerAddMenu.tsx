import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowsInIcon,
  CaretRightIcon,
  PaperclipIcon,
  PlugIcon,
  PlusIcon,
  ScrollIcon,
} from "@phosphor-icons/react";
import type { SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { isImeComposing } from "../../../keyboardEvent";
import { filterSlashCommandCatalog } from "./slash-commands/slashCommandInput";
import {
  loadSlashCommandCatalog,
  slashCommandKey,
  type OverseerSource,
} from "../../../components/chat/slash-command-catalog";

type MenuLayout = {
  bottom?: number;
  left: number;
  maxHeight: number;
  top?: number;
  width: number;
};

type ComposerAddMenuProps = {
  anchorRef: RefObject<HTMLElement | null>;
  catalogVersion?: number;
  chatExists: boolean;
  disabled?: boolean;
  getOverseer: OverseerSource;
  skillSelected?: boolean;
  onAddConnection: () => void;
  onOpen?: () => void;
  onSelectSkill: (choice: SlashCommandChoice) => void;
  onUpload: () => void;
};

type MenuItem =
  | { kind: "upload"; key: string }
  | { kind: "connection"; key: string }
  | { kind: "skill"; key: string; choice: SlashCommandChoice };

function menuLayout(anchor: HTMLElement): MenuLayout {
  const margin = 12;
  const gap = 8;
  const minHeight = 160;
  const rect = anchor.getBoundingClientRect();
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(0, Math.min(rect.width, viewportWidth - margin * 2));
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = viewportHeight - rect.bottom - margin - gap;
  const openBelow = spaceBelow >= minHeight || spaceBelow > spaceAbove;
  const available = Math.max(minHeight, openBelow ? spaceBelow : spaceAbove);
  return {
    left: Math.min(Math.max(rect.left, margin), viewportWidth - width - margin),
    maxHeight: Math.min(440, available),
    width,
    ...(openBelow
      ? { top: rect.bottom + gap }
      : { bottom: viewportHeight - rect.top + gap }),
  };
}

export default function ComposerAddMenu({
  anchorRef,
  catalogVersion = 0,
  chatExists,
  disabled = false,
  getOverseer,
  skillSelected = false,
  onAddConnection,
  onOpen,
  onSelectSkill,
  onUpload,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [catalog, setCatalog] = useState<SlashCommandChoice[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [layout, setLayout] = useState<MenuLayout | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const catalogVersionRef = useRef(catalogVersion);
  const listboxId = useId();
  const skillsAvailable = !skillSelected;
  const hasQuery = query.trim().length > 0;

  const skills = useMemo(() => {
    if (!skillsAvailable) return [];
    const offerable = chatExists
      ? catalog
      : catalog.filter((choice) => choice.selection.builtin !== true);
    return filterSlashCommandCatalog(offerable, query);
  }, [catalog, chatExists, query, skillsAvailable]);

  const items = useMemo<MenuItem[]>(() => [
    ...(!hasQuery ? [
      { kind: "upload" as const, key: "upload" },
      { kind: "connection" as const, key: "connection" },
    ] : []),
    ...skills.map((choice) => ({
      kind: "skill" as const,
      key: slashCommandKey(choice.selection),
      choice,
    })),
  ], [hasQuery, skills]);

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const activate = (item: MenuItem | undefined) => {
    if (!item) return;
    close(false);
    if (item.kind === "upload") onUpload();
    else if (item.kind === "connection") {
      triggerRef.current?.focus();
      onAddConnection();
    }
    else onSelectSkill(item.choice);
  };

  useEffect(() => {
    if (catalogVersionRef.current === catalogVersion) return;
    catalogVersionRef.current = catalogVersion;
    setCatalog([]);
  }, [catalogVersion]);

  useEffect(() => {
    if (!open || !skillsAvailable) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    loadSlashCommandCatalog(getOverseer)
      .then((choices) => {
        if (!cancelled) setCatalog(choices);
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(true);
        console.error("Failed to list skills:", loadError);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [catalogVersion, getOverseer, open, skillsAvailable]);

  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
  }, [open, query]);

  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      if (skillsAvailable) searchRef.current?.focus();
      else listRef.current?.focus();
    });
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Node)) return;
      if (popupRef.current?.contains(event.target) || triggerRef.current?.contains(event.target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, skillsAvailable]);

  useLayoutEffect(() => {
    if (!open || !anchorRef.current) {
      setLayout(null);
      return;
    }
    const update = () => {
      if (anchorRef.current) setLayout(menuLayout(anchorRef.current));
    };
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isImeComposing(event)) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const item = items[activeIndex];
      if (item) activate(item);
      else close();
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      activate(items[activeIndex]);
      return;
    }
    if (items.length > 0 && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      setActiveIndex((current) => (current + direction + items.length) % items.length);
    }
  };

  const search = skillsAvailable ? (
    <div className={`shrink-0 bg-kumo-base px-4 ${
      layout?.top !== undefined ? "pb-0 pt-3" : "pb-3 pt-2"
    }`}>
      <input
        ref={searchRef}
        value={query}
        type="text"
        role="combobox"
        aria-label="Search skills"
        aria-autocomplete="list"
        aria-expanded="true"
        aria-controls={listboxId}
        aria-activedescendant={items[activeIndex]
          ? `${listboxId}-option-${activeIndex}`
          : undefined}
        placeholder="Search skills…"
        className="w-full border-0 bg-transparent p-0 text-[14px] leading-6 text-kumo-default outline-none placeholder:text-kumo-inactive"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  ) : null;

  const popup = open && layout ? createPortal(
    <div
      ref={popupRef}
      className="themed-floating-shadow-lg fixed z-[1100] flex flex-col overflow-hidden rounded-2xl border border-kumo-line/70 bg-kumo-base"
      style={layout}
      role="dialog"
      aria-label="Add to conversation"
    >
      {layout.top !== undefined && search}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-label="Files, connections, and skills"
        aria-busy={loading}
        tabIndex={skillsAvailable ? undefined : -1}
        onKeyDown={skillsAvailable ? undefined : handleKeyDown}
        className={`sidebar-scroll min-h-0 flex-1 overflow-y-auto p-2 outline-none ${
          skillsAvailable && layout.bottom !== undefined ? "pb-0" : ""
        }`}
      >
        {items.map((item, index) => {
          const active = index === activeIndex;
          if (item.kind !== "skill") {
            const upload = item.kind === "upload";
            const Icon = upload ? PaperclipIcon : PlugIcon;
            return (
              <button
                key={item.key}
                id={`${listboxId}-option-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={-1}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-kumo-default transition-colors ${active ? "bg-kumo-tint" : "hover:bg-kumo-tint/70"}`}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => activate(item)}
              >
                <Icon size={16} className="shrink-0" />
                <span>{upload ? "Upload files or photos" : "Add a new connection"}</span>
              </button>
            );
          }

          const choice = item.choice;
          return (
            <Fragment key={item.key}>
              {!hasQuery && index === 2 && (
                <div role="separator" className="mx-2 my-1 border-t border-kumo-line/70" />
              )}
              <button
                id={`${listboxId}-option-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={-1}
                title={[
                  choice.name,
                  choice.description,
                  [choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · "),
                ].join("\n")}
                className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${active ? "bg-kumo-tint" : "hover:bg-kumo-tint/70"}`}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => activate(item)}
              >
                {choice.selection.builtin === true && choice.selection.commandId === "compact"
                  ? <ArrowsInIcon size={16} className="shrink-0" />
                  : <ScrollIcon size={16} className="shrink-0" />}
                <span className="flex min-w-0 flex-1 items-center gap-2">
                  <span className="min-w-0 shrink-0 truncate text-kumo-default sm:max-w-[35%]">
                    {choice.name}
                  </span>
                  <CaretRightIcon size={11} aria-hidden="true" className="shrink-0 text-kumo-inactive" />
                  <span className="min-w-0 flex-1 truncate text-kumo-subtle">
                    {choice.description}
                  </span>
                </span>
                <span className="max-w-[30%] shrink-0 truncate text-[11.5px] text-kumo-inactive">
                  {[choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · ")}
                </span>
              </button>
            </Fragment>
          );
        })}
        {skillsAvailable && !loading && items.length === 0 && (
          <p className="m-0 px-3 py-8 text-center text-[13px] text-kumo-inactive">
            {error ? "Couldn’t load skills." : "No skills match your search."}
          </p>
        )}
        {skillsAvailable && loading && catalog.length === 0 && query && (
          <p className="m-0 px-3 py-8 text-center text-[13px] text-kumo-inactive">Loading skills…</p>
        )}
      </div>
      {layout.bottom !== undefined && search}
    </div>,
    document.body,
  ) : null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        aria-label="Add to conversation"
        aria-haspopup="dialog"
        aria-expanded={open}
        className="group flex h-10 w-10 shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 sm:h-8 sm:w-8"
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((current) => !current);
        }}
      >
        <PlusIcon size={18} className={`transition-transform ${open ? "rotate-45" : ""}`} />
      </button>
      {popup}
    </>
  );
}
