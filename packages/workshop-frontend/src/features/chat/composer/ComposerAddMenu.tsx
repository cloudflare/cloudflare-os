import {
  Fragment,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowsInIcon,
  ListChecksIcon,
  CaretLeftIcon,
  CaretRightIcon,
  CheckIcon,
  CubeIcon,
  PaperclipIcon,
  PlugIcon,
  ScrollIcon,
  ShapesIcon,
} from "@phosphor-icons/react";
import type { AiChatAuthorInfo, OutputFormatOffer, SlashCommandChoice } from "@gadgets/workshop-shared/api";
import { PlusIcon as DesignPlusIcon } from "../../../components/icons/designIcons";
import styles from "./ChatComposer.module.css";
import { FormatGlyph } from "../../../components/format/FormatVisuals";
import { useOutputFormats } from "../../../components/format/useOutputFormats";
import { modelLabel, type SelectedModel } from "./composerModel";
import { isImeComposing } from "../../../keyboardEvent";
import { filterSlashCommandCatalog } from "./slash-commands/slashCommandInput";
import {
  loadSlashCommandCatalog,
  slashCommandKey,
  type OverseerSource,
} from "../../../components/chat/slash-command-catalog";

const isBuiltin = (choice: SlashCommandChoice) => choice.selection.builtin === true;

// A built-in command keeps its familiar name ("Compact"); its description stays in the tooltip.
const BUILTIN_LABELS: Record<string, string> = { compact: "Compact" };

// A skill's name as a person reads it: "meeting-brief" is "Meeting brief". The name itself, which
// a slash command types, stays in the row's tooltip.
function skillLabel(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

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
  /**
   * The chat's model. The design's composer row has no model control, so the choice lives here, a
   * row that opens the list in place.
   */
  model?: {
    models: readonly AiChatAuthorInfo[];
    selected: SelectedModel;
    onChange: (modelId: string | null) => void;
  };
  /** Offers the deployment's standard formats, inserted at the caret when picked. */
  onSelectFormat?: (format: OutputFormatOffer) => void;
  /** Whether the agent's thinking is shown, and how to flip it. */
  thinking?: { shown: boolean; onToggle: () => void };
};

// "main" is the files, connections and skills list; the others replace it in place, so a nested
// popover never has to escape this one's outside-click handling.
type MenuView = "main" | "models" | "formats";

type MenuItem =
  | { kind: "upload"; key: string }
  | { kind: "connection"; key: string }
  | { kind: "model-view"; key: string }
  | { kind: "format-view"; key: string }
  | { kind: "thinking"; key: string }
  | { kind: "back"; key: string }
  | { kind: "model"; key: string; modelId: string | null; label: string; description?: string }
  | { kind: "format"; key: string; format: OutputFormatOffer }
  | { kind: "skill"; key: string; choice: SlashCommandChoice };

// The menu is a small popover over the + (a sheet as wide as the composer read as a second
// composer): it lines up with the button's left edge and opens away from the composer.
const MENU_WIDTH = 300;

function menuLayout(anchor: HTMLElement, trigger: HTMLElement | null): MenuLayout {
  const margin = 12;
  const gap = 8;
  const minHeight = 160;
  const rect = anchor.getBoundingClientRect();
  const triggerLeft = trigger?.getBoundingClientRect().left ?? rect.left;
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const width = Math.max(0, Math.min(MENU_WIDTH, viewportWidth - margin * 2));
  const spaceAbove = rect.top - margin - gap;
  const spaceBelow = viewportHeight - rect.bottom - margin - gap;
  const openBelow = spaceBelow >= minHeight || spaceBelow > spaceAbove;
  const available = Math.max(minHeight, openBelow ? spaceBelow : spaceAbove);
  return {
    left: Math.min(Math.max(triggerLeft - 6, margin), viewportWidth - width - margin),
    maxHeight: Math.min(400, available),
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
  model,
  onSelectFormat,
  thinking,
}: ComposerAddMenuProps) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<MenuView>("main");
  const outputFormats = useOutputFormats(open && onSelectFormat !== undefined);
  const formatsOffered = onSelectFormat !== undefined && outputFormats.formats.length > 0;
  const [query, setQuery] = useState("");
  const [loadedCatalog, setLoadedCatalog] = useState<{
    source: OverseerSource;
    choices: SlashCommandChoice[];
  } | null>(null);
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
  const skillsAvailable = !skillSelected && view === "main";
  const hasQuery = query.trim().length > 0;
  const catalog = loadedCatalog?.source === getOverseer ? loadedCatalog.choices : [];

  const skills = useMemo(() => {
    if (!skillsAvailable) return [];
    const offerable = chatExists
      ? catalog
      : catalog.filter((choice) => choice.selection.builtin !== true);
    return filterSlashCommandCatalog(offerable, query);
  }, [catalog, chatExists, query, skillsAvailable]);

  const items = useMemo<MenuItem[]>(() => {
    if (view === "models" && model) {
      return [
        { kind: "back", key: "back" },
        ...model.models.map((choice) => ({
          kind: "model" as const,
          key: `model:${choice.id}`,
          modelId: choice.id,
          label: choice.name,
          description: choice.description,
        })),
        { kind: "model", key: "model:none", modelId: null, label: "No agent" },
      ];
    }
    if (view === "formats") {
      return [
        { kind: "back", key: "back" },
        ...outputFormats.formats.map((format) => ({
          kind: "format" as const,
          key: `format:${format.blueprintId}`,
          format,
        })),
      ];
    }
    return [
      ...(!hasQuery ? [
        { kind: "upload" as const, key: "upload" },
        { kind: "connection" as const, key: "connection" },
        ...(formatsOffered ? [{ kind: "format-view" as const, key: "format-view" }] : []),
        ...(model ? [{ kind: "model-view" as const, key: "model-view" }] : []),
        ...(thinking ? [{ kind: "thinking" as const, key: "thinking" }] : []),
      ] : []),
      // Built-in commands, such as compacting the chat, are things to do, not skills: they sit
      // with the actions above, ahead of the skills.
      ...[...skills.filter(isBuiltin), ...skills.filter((choice) => !isBuiltin(choice))].map((choice) => ({
        kind: "skill" as const,
        key: slashCommandKey(choice.selection),
        choice,
      })),
    ];
  }, [formatsOffered, hasQuery, model, outputFormats.formats, skills, thinking, view]);
  const leadingRows = items.findIndex((item) => item.kind === "skill" && !isBuiltin(item.choice));

  const close = (restoreFocus = true) => {
    setOpen(false);
    setQuery("");
    setView("main");
    if (restoreFocus) requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const activate = (item: MenuItem | undefined) => {
    if (!item) return;
    if (item.kind === "model-view" || item.kind === "format-view" || item.kind === "back") {
      setView(item.kind === "model-view" ? "models" : item.kind === "format-view" ? "formats" : "main");
      setActiveIndex(0);
      requestAnimationFrame(() => listRef.current?.focus());
      return;
    }
    close(false);
    if (item.kind === "model") model?.onChange(item.modelId);
    else if (item.kind === "thinking") thinking?.onToggle();
    else if (item.kind === "format") {
      if (item.format.requiresSetup) void outputFormats.create(item.format);
      else onSelectFormat?.(item.format);
    }
    else if (item.kind === "upload") onUpload();
    else if (item.kind === "connection") {
      triggerRef.current?.focus();
      onAddConnection();
    }
    else onSelectSkill(item.choice);
  };

  useEffect(() => {
    if (catalogVersionRef.current === catalogVersion) return;
    catalogVersionRef.current = catalogVersion;
    setLoadedCatalog(null);
  }, [catalogVersion]);

  useEffect(() => {
    if (!open || !skillsAvailable) return;
    let cancelled = false;
    setLoading(true);
    setError(false);
    loadSlashCommandCatalog(getOverseer)
      .then((choices) => {
        if (!cancelled) setLoadedCatalog({ source: getOverseer, choices });
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
      if (anchorRef.current) setLayout(menuLayout(anchorRef.current, triggerRef.current));
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
      if (view !== "main") activate({ kind: "back", key: "back" });
      else close();
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

  // How each non-skill row reads: what it is, and for rows that open a list, where it stands.
  const menuRow = (item: Exclude<MenuItem, { kind: "skill" }>): {
    icon: ReactNode;
    label: string;
    description?: string;
    detail?: string;
    checked?: boolean;
    opens?: boolean;
  } => {
    switch (item.kind) {
      case "upload": return { icon: <PaperclipIcon size={16} />, label: "Add files or photos" };
      case "connection": return { icon: <PlugIcon size={16} />, label: "Add a connection" };
      case "format-view": return { icon: <ShapesIcon size={16} />, label: "Start with a format", opens: true };
      case "model-view": return {
        icon: <CubeIcon size={16} />,
        label: "Model",
        detail: model ? modelLabel(model.models, model.selected) : undefined,
        opens: true,
      };
      case "thinking": return {
        icon: <ListChecksIcon size={16} />,
        label: thinking?.shown ? "Hide steps" : "Show steps",
      };
      case "back": return {
        icon: <CaretLeftIcon size={14} />,
        label: view === "models" ? "Model" : "Start with a format",
      };
      case "model": return {
        icon: null,
        label: item.label,
        description: item.description,
        checked: item.modelId === null ? model?.selected == null : model?.selected?.id === item.modelId,
      };
      case "format": return {
        icon: (
          <FormatGlyph
            output={item.format.output}
            size="md"
            className={outputFormats.creating === item.format.blueprintId ? "animate-pulse" : undefined}
          />
        ),
        label: outputFormats.creating === item.format.blueprintId ? "Creating…" : item.format.output.noun,
      };
    }
  };

  const search = skillsAvailable ? (
    <div className={`shrink-0 border-kumo-line bg-kumo-base px-4 ${
      layout?.top !== undefined ? "order-first border-b py-2.5" : "order-last border-t py-2.5"
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
        className="w-full border-0 bg-transparent p-0 text-[14px] leading-5 text-kumo-default outline-none placeholder:text-kumo-inactive"
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={handleKeyDown}
      />
    </div>
  ) : null;

  const popup = open && layout ? createPortal(
    <div
      ref={popupRef}
      className={`${styles.menu} fixed z-[1100] flex flex-col overflow-hidden rounded-[16px] bg-kumo-base shadow-[0_8px_28px_rgba(0,0,0,0.08)] ring-1 ring-kumo-line`}
      data-side={layout.top !== undefined ? "below" : "above"}
      style={layout}
      role="dialog"
      aria-label="Add to conversation"
    >
      {search}
      <div
        ref={listRef}
        id={listboxId}
        role="listbox"
        aria-busy={loading}
        tabIndex={skillsAvailable ? undefined : -1}
        onKeyDown={skillsAvailable ? undefined : handleKeyDown}
        aria-label={view === "models" ? "Models" : view === "formats" ? "Formats" : "Files, connections, and skills"}
        className="sidebar-scroll min-h-0 flex-1 overflow-y-auto p-1.5 outline-none"
      >
        {items.map((item, index) => {
          const active = index === activeIndex;
          if (item.kind !== "skill") {
            const row = menuRow(item);
            return (
              <Fragment key={item.key}>
                <button
                  id={`${listboxId}-option-${index}`}
                  data-index={index}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={-1}
                  className={`flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[14px] leading-5 text-kumo-default transition-colors ${active ? "bg-kumo-tint" : ""} ${item.kind === "back" ? "text-kumo-subtle" : ""}`}
                  onPointerMove={() => setActiveIndex(index)}
                  onClick={() => activate(item)}
                >
                  <span className="flex size-4 shrink-0 items-center justify-center text-kumo-subtle">{row.icon}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{row.label}</span>
                    {row.description && (
                      <span className="block truncate text-[12px] text-kumo-subtle">{row.description}</span>
                    )}
                  </span>
                  {row.detail && <span className="max-w-[40%] shrink-0 truncate text-kumo-subtle">{row.detail}</span>}
                  {row.checked && <CheckIcon size={14} className="shrink-0 text-kumo-subtle" />}
                  {row.opens && <CaretRightIcon size={12} className="shrink-0 text-kumo-inactive" />}
                </button>
              </Fragment>
            );
          }

          const choice = item.choice;
          return (
            <Fragment key={item.key}>
              {!hasQuery && index === leadingRows && (
                <>
                  {index > 0 && <div role="separator" className="mx-2.5 my-1.5 border-t border-kumo-line" />}
                  <div className="px-2.5 pb-1 pt-1.5 text-[12px] leading-4 text-kumo-inactive" aria-hidden="true">Skills</div>
                </>
              )}
              <button
                id={`${listboxId}-option-${index}`}
                data-index={index}
                type="button"
                role="option"
                aria-selected={active}
                tabIndex={-1}
                title={[
                  `/${choice.name}`,
                  choice.description,
                  [choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · "),
                ].filter(Boolean).join("\n")}
                className={`flex min-h-9 w-full cursor-pointer items-center gap-2.5 rounded-[10px] px-2.5 py-2 text-left text-[14px] leading-5 transition-colors ${active ? "bg-kumo-tint" : ""}`}
                onPointerMove={() => setActiveIndex(index)}
                onClick={() => activate(item)}
              >
                <span className="flex size-4 shrink-0 items-center justify-center text-kumo-subtle">
                  {choice.selection.builtin === true && choice.selection.commandId === "compact"
                    ? <ArrowsInIcon size={16} />
                    : <ScrollIcon size={16} />}
                </span>
                <span className="flex min-w-0 flex-1 items-baseline gap-2">
                  <span className="shrink-0 text-kumo-default">
                    {isBuiltin(choice)
                      ? BUILTIN_LABELS[choice.selection.commandId] ?? skillLabel(choice.name)
                      : skillLabel(choice.name)}
                  </span>
                  {!isBuiltin(choice) && choice.description && (
                    <span className="min-w-0 flex-1 truncate text-[13px] text-kumo-subtle">{choice.description}</span>
                  )}
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
        className={`group flex size-[26px] shrink-0 cursor-pointer items-center justify-center rounded-full text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40 ${open ? "bg-kumo-tint text-kumo-default" : ""}`}
        onClick={() => {
          if (!open) onOpen?.();
          setOpen((current) => !current);
        }}
      >
        <DesignPlusIcon size={14} className={`transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "rotate-45" : ""}`} />
      </button>
      {popup}
    </>
  );
}
