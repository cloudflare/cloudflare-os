import { Button, Dialog, DropdownMenu, Input, InputArea, useKumoToastManager } from "@cloudflare/kumo";
import {
  BookOpen,
  Buildings,
  Clock,
  GitBranch,
  Folder,
  FileText,
  Plus,
  Trash,
  PencilSimple,
  MagnifyingGlass,
  CaretLeft,
  CaretRight,
  CaretDown,
  Check,
  Code,
  Eye,
  Lock,
  DotsThree,
  Key,
  Image as ImageIcon,
  UploadSimple,
  FilePlus,
  FolderPlus,
  User,
  X,
} from "@phosphor-icons/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import { createPortal } from "react-dom";
import type {
  ContextCollectionContent,
  ContextCollectionMetadata,
  ContextCollectionVisibility,
  ContextDocumentSummary,
  ContextGitTokenCreateResult,
  ContextGitTokenInfo,
  EnabledCollectionInfo,
} from "../src/context-types";
import {
  DEFAULT_GIT_BRANCH,
  contentTypeFromPath,
  isImageContentType,
  isMarkdownContentType,
  isTextContentType,
} from "../src/context-types";
import emojiData from "@emoji-mart/data";
import { Picker as EmojiMartPicker } from "emoji-mart";
import { Compartment, EditorState } from "@codemirror/state";
import { EditorView, keymap, drawSelection, lineNumbers } from "@codemirror/view";
import {
  syntaxHighlighting,
  HighlightStyle,
  bracketMatching,
  indentOnInput,
} from "@codemirror/language";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { yaml } from "@codemirror/lang-yaml";
import { tags as t } from "@lezer/highlight";
import type { Extension } from "@codemirror/state";
import { useContextApi, usePresentWhileOpen, useResolvedThemeMode } from "./bridge";
import { extractDescription } from "../src/description-extractors";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function baseName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? path : path.slice(i + 1);
}

function dirName(path: string): string {
  const i = path.lastIndexOf("/");
  return i < 0 ? "" : path.slice(0, i);
}

function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

function resolveCollectionPath(baseDir: string, rel: string): string {
  rel = rel.split(/[?#]/)[0];
  let segs: string[] = [];
  if (!rel.startsWith("/") && baseDir) segs = baseDir.split("/");
  for (const part of rel.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") segs.pop();
    else segs.push(part);
  }
  return segs.join("/");
}

function isExternalImageSrc(src: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(src) || src.startsWith("//") || src.startsWith("#");
}

// Strip a leading YAML frontmatter fence before rendering the preview — its fields already show in
// the "When to use this" row.
function stripFrontmatter(source: string): string {
  return source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/, "");
}

function pluralize(count: number, noun: string): string {
  return `${count} ${noun}${count !== 1 ? "s" : ""}`;
}

// Bounded-concurrency helper for bulk RPC operations.
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function worker() {
    while (next < items.length) {
      await fn(items[next++]);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
}

// Segment-aware path-prefix replacement.
function replacePathPrefix(path: string, fromPrefix: string, toPrefix: string): string {
  if (path === fromPrefix) return toPrefix;
  if (path.startsWith(fromPrefix + "/")) return toPrefix + path.slice(fromPrefix.length);
  return path;
}

// Read a File as base64 (no data: prefix) for binary uploads.
function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      const result = reader.result as string;
      // result is "data:<mime>;base64,<data>"; strip the prefix.
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function dataUri(contentType: string, base64Body: string): string {
  return `data:${contentType};base64,${base64Body}`;
}

const DEFAULT_COLLECTION_ICON = "📚";

function IconPickerButton({
  value,
  onChange,
  size = 32,
  variant = "boxed",
}: {
  value?: string;
  onChange: (emoji: string) => void;
  size?: number;
  // "boxed": standalone bordered tile (settings modal). "inline": borderless tile that sits inside a
  // shared input pill.
  variant?: "boxed" | "inline";
}) {
  const themeMode = useResolvedThemeMode();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pickerHostRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        wrapRef.current?.contains(target) ||
        pickerHostRef.current?.contains(target)
      )
        return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [open]);

  // Fixed-position layer anchored to the trigger so the form can't clip it. Opens above the trigger
  // by default, flips below when there's no room, and stays glued to the button on scroll/resize.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const PICKER_W = 352;
    const PICKER_H = 435;
    const GAP = 6;
    const place = () => {
      const btn = btnRef.current;
      if (!btn) return;
      const rect = btn.getBoundingClientRect();
      const roomAbove = rect.top;
      const roomBelow = window.innerHeight - rect.bottom;
      const openAbove = roomAbove >= PICKER_H + GAP || roomAbove >= roomBelow;
      const top = openAbove
        ? Math.max(GAP, rect.top - GAP - PICKER_H)
        : Math.min(window.innerHeight - PICKER_H - GAP, rect.bottom + GAP);
      const left = Math.min(
        Math.max(GAP, rect.left),
        window.innerWidth - PICKER_W - GAP,
      );
      setPos({ left, top });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !pickerHostRef.current) return;
    const host = pickerHostRef.current;
    const picker = new (EmojiMartPicker as any)({
      data: emojiData,
      theme: themeMode,
      previewPosition: "none",
      skinTonePosition: "none",
      // Hide the "Frequently used" category.
      maxFrequentRows: 0,
      onEmojiSelect: (e: { native: string }) => {
        onChange(e.native);
        setOpen(false);
      },
    });
    host.appendChild(picker as unknown as Node);
    return () => {
      host.replaceChildren();
    };
  }, [open, onChange, themeMode]);

  const inline = variant === "inline";
  return (
    <div ref={wrapRef} className="relative inline-block">
      <button
        ref={btnRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        title="Choose an icon"
        className={
          inline
            ? "grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-kumo-tint text-[18px] leading-none text-kumo-subtle transition-colors hover:bg-kumo-fill"
            : "grid place-items-center rounded-xl border border-kumo-line bg-kumo-base hover:border-kumo-brand transition-colors"
        }
        style={
          inline
            ? undefined
            : {
                width: size + 12,
                height: size + 12,
                fontSize: size * 0.66,
                lineHeight: 1,
              }
        }
      >
        <span>{value || DEFAULT_COLLECTION_ICON}</span>
      </button>
      {open &&
        // Portaled to <body> so a transformed ancestor (e.g. .ctx-rise's fill-both transform) can't
        // become the containing block for `fixed` and offset the coordinates.
        createPortal(
          <div
            ref={pickerHostRef}
            className="z-[2000]"
            style={{
              position: "fixed",
              left: pos?.left ?? 0,
              top: pos?.top ?? 0,
              // Hidden until measured so it never flashes at (0,0).
              visibility: pos ? "visible" : "hidden",
            }}
          />,
          document.body,
        )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Layout primitives
// ---------------------------------------------------------------------------

// Provenance for a row, framed as authorship: public collections are admin-published (and always
// on), the rest are ones the user created.
function CollectionProvenance({ source }: { source: EnabledCollectionInfo["source"] }) {
  const isPublic = source === "public";
  return (
    <span
      className="flex w-52 items-center gap-1 whitespace-nowrap"
      title={
        isPublic
          ? "Provided by your organization for everyone"
          : "A collection you created"
      }
    >
      {isPublic ? <Buildings size={11} /> : <User size={11} />}
      {isPublic ? "Required by your organization" : "Created by you"}
    </span>
  );
}

// Tile dimensions + matching fallback-book glyph size, keyed together so they can't drift.
const ICON_TILE_SIZES = {
  sm: { tile: "h-9 w-9 rounded-lg text-[18px]", book: 16 },
  md: { tile: "h-10 w-10 rounded-xl text-[20px]", book: 18 },
  lg: { tile: "h-12 w-12 rounded-2xl text-[26px]", book: 24 },
} as const;

function CollectionIconTile({
  icon,
  size = "md",
}: {
  icon?: string;
  size?: keyof typeof ICON_TILE_SIZES;
}) {
  const { tile, book } = ICON_TILE_SIZES[size];
  return (
    <div
      className={`grid ${tile} shrink-0 place-items-center bg-kumo-fill leading-none text-kumo-subtle`}
    >
      {icon ? <span>{icon}</span> : <BookOpen size={book} weight="regular" />}
    </div>
  );
}

function formatRelativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function handleCardKeyDown(e: React.KeyboardEvent, onClick: () => void) {
  if (e.currentTarget !== e.target) return;
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    onClick();
  }
}

function CollectionRow({
  collection,
  onClick,
}: {
  collection: EnabledCollectionInfo;
  onClick: () => void;
}) {
  const hasDescription = collection.description.trim().length > 0;
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(e) => handleCardKeyDown(e, onClick)}
      className="group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint"
    >
      <CollectionIconTile icon={collection.icon} size="sm" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium tracking-[-0.25px] text-kumo-default">
          {collection.title}
        </p>
        <p
          className={`mt-0.5 line-clamp-1 text-[12px] leading-4 tracking-[-0.2px] ${
            hasDescription ? "text-kumo-subtle" : "italic text-kumo-inactive"
          }`}
        >
          {hasDescription ? collection.description : "No description"}
        </p>
      </div>
      {/* Fixed-width meta columns so rows line up like a table. */}
      <div className="hidden shrink-0 items-center gap-6 text-xs text-kumo-inactive lg:flex">
        <CollectionProvenance source={collection.source} />
        <span className="flex w-16 items-center justify-end gap-1 whitespace-nowrap">
          <Clock size={10} />
          {formatRelativeTime(collection.lastUpdated)}
        </span>
      </div>
    </div>
  );
}

function CollectionsSkeleton() {
  return (
    <div className="flex flex-col gap-0.5">
      {[1, 2, 3, 4, 5].map((i) => (
        <div
          key={i}
          className="h-[58px] animate-pulse rounded-lg bg-kumo-elevated"
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// New collection modal
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Modal controls — shared button / input / close styling for the dialogs.
// ---------------------------------------------------------------------------

const wsButtonBase =
  "inline-flex cursor-pointer items-center justify-center rounded-lg text-[13px] leading-[18px] font-medium tracking-[-0.25px] transition-[background-color,color,opacity,transform] duration-150 ease-out active:scale-[0.98] disabled:cursor-not-allowed disabled:active:scale-100";

const wsButtonTone = {
  primary:
    "!h-9 bg-kumo-contrast px-3 text-kumo-inverse enabled:hover:bg-kumo-strong disabled:opacity-50",
  secondary:
    "!h-8 border border-kumo-line bg-kumo-base px-3 text-kumo-default enabled:hover:bg-kumo-elevated disabled:opacity-40",
  danger: "!h-8 bg-kumo-danger px-3 text-white enabled:hover:opacity-90 disabled:opacity-50",
} as const;

function buttonVariantForTone(
  tone: keyof typeof wsButtonTone,
): "primary" | "secondary" | "destructive" {
  if (tone === "primary") return "primary";
  if (tone === "danger") return "destructive";
  return "secondary";
}

function WorkshopButton({
  tone = "secondary",
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "shape"> & {
  tone?: keyof typeof wsButtonTone;
}) {
  const variant = buttonVariantForTone(tone);
  return (
    <Button
      {...props}
      variant={variant}
      className={`${wsButtonBase} ${wsButtonTone[tone]} ${className}`}
    />
  );
}

function WorkshopIconButton({
  children,
  className = "",
  ...props
}: Omit<ComponentProps<typeof Button>, "variant" | "children" | "shape"> & {
  children: ReactNode;
  "aria-label": string;
}) {
  return (
    <Button
      {...props}
      variant="ghost"
      shape="square"
      className={`!flex !h-8 !w-8 shrink-0 cursor-pointer items-center justify-center rounded-md !p-0 text-kumo-subtle transition-[background-color,color,opacity,transform] duration-150 ease-out enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40 disabled:active:scale-100 ${className}`}
    >
      {children}
    </Button>
  );
}

function WorkshopInput({ className = "", ...props }: ComponentProps<typeof Input>) {
  return (
    <Input
      {...props}
      className={`!h-9 rounded-lg border border-kumo-line bg-kumo-base px-3 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none focus:border-kumo-ring focus:outline-none focus:ring-1 focus:ring-kumo-ring/15 ${className}`}
    />
  );
}

function WorkshopInputArea({ className = "", ...props }: ComponentProps<typeof InputArea>) {
  return (
    <InputArea
      {...props}
      className={`rounded-lg border border-kumo-line bg-kumo-base px-3 py-2 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive shadow-none focus:border-kumo-ring focus:outline-none focus:ring-1 focus:ring-kumo-ring/15 ${className}`}
    />
  );
}

function FieldLabel({
  children,
  optional = false,
}: {
  children: ReactNode;
  optional?: boolean;
}) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-[12px] leading-4 font-medium tracking-[-0.2px] text-kumo-subtle">
      <span>{children}</span>
      {optional ? <span className="font-normal text-kumo-inactive">Optional</span> : null}
    </label>
  );
}

// Shared styling for the `…` overflow menus (file rows, folder rows, the tree's Add button).
const MENU_CONTENT =
  "z-[1100]! min-w-[168px]! rounded-lg border border-kumo-line bg-kumo-base p-1 shadow-[0_10px_24px_rgba(20,17,16,0.10)]";
const MENU_ITEM =
  "h-auto! rounded-md px-2.5! py-1.5! text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default data-highlighted:bg-kumo-tint";
const MENU_ITEM_DANGER =
  "h-auto! rounded-md px-2.5! py-1.5! text-[13px] leading-[18px] tracking-[-0.25px] data-highlighted:bg-kumo-danger-tint";

// A `…`/`+` overflow menu with the shared chrome. Tree rows pass `stopPropagation` so a click on the
// trigger or an item doesn't also select the row behind it.
function KebabMenu({
  trigger,
  stopPropagation = false,
  children,
}: {
  trigger: ReactElement;
  stopPropagation?: boolean;
  children: ReactNode;
}) {
  const stop = stopPropagation
    ? (e: React.MouseEvent) => e.stopPropagation()
    : undefined;
  return (
    <DropdownMenu>
      <DropdownMenu.Trigger render={trigger} />
      <DropdownMenu.Content
        onClick={stop}
        className={MENU_CONTENT}
        align="end"
        sideOffset={6}
      >
        {children}
      </DropdownMenu.Content>
    </DropdownMenu>
  );
}

// Name + description fields, shared by the New Collection page and the settings modal. Callers own
// their layout wrappers.
function CollectionNameField({
  icon,
  onIconChange,
  value,
  onChange,
  onEnter,
  autoFocus,
}: {
  icon: string;
  onIconChange: (icon: string) => void;
  value: string;
  onChange: (value: string) => void;
  onEnter?: () => void;
  autoFocus?: boolean;
}) {
  return (
    <>
      <FieldLabel>Name</FieldLabel>
      {/* Icon tile + name share one focus-within pill so the emoji reads as part of the input. */}
      <div className="flex items-center gap-2 rounded-xl border-2 border-kumo-line bg-kumo-base p-1.5 transition-[border-color,box-shadow] duration-150 ease-out focus-within:border-kumo-ring focus-within:ring-1 focus-within:ring-kumo-ring/15">
        <IconPickerButton value={icon} onChange={onIconChange} variant="inline" />
        <input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onEnter?.();
          }}
          placeholder="A short name, e.g., Brand guidelines"
          autoFocus={autoFocus}
          className="h-9 min-w-0 flex-1 appearance-none border-0 bg-transparent p-0 pr-2 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
        />
      </div>
    </>
  );
}

function CollectionDescriptionField({
  value,
  onChange,
}: {
  value: string;
  onChange: (value: string) => void;
}) {
  return (
    <>
      <FieldLabel optional>Description</FieldLabel>
      {/* `ring-0` drops Kumo InputArea's base ring so it matches the name pill's single border. */}
      <WorkshopInputArea
        value={value}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => onChange(e.target.value)}
        placeholder="What it contains and when to use it, e.g., voice and tone rules for customer-facing writing"
        rows={4}
        className="w-full border-2 ring-0 !rounded-xl transition-[border-color,box-shadow] duration-150 ease-out"
      />
    </>
  );
}

function ModalHeader({
  title,
  description,
}: {
  title: string;
  description?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-kumo-line px-4 py-5 sm:px-6">
      <div className="min-w-0">
        <Dialog.Title className="text-[17px] leading-6 font-medium tracking-[-0.35px] text-kumo-default">
          {title}
        </Dialog.Title>
        {description ? (
          <Dialog.Description className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
            {description}
          </Dialog.Description>
        ) : null}
      </div>
      <Dialog.Close
        render={(props) => (
          <WorkshopIconButton {...props} aria-label="Close">
            <X size={18} />
          </WorkshopIconButton>
        )}
      />
    </div>
  );
}

// Body copy for the delete-confirmation dialogs. The "… and all N documents inside it" clause shows
// only when `documents` is passed (folders/collections with children).
function DeletePermanentlyDescription({
  name,
  documents,
}: {
  name: ReactNode;
  documents?: number;
}) {
  return (
    <>
      This permanently deletes{" "}
      <span className="font-medium text-kumo-default">{name}</span>
      {documents !== undefined ? (
        <>
          {" "}and all{" "}
          <span className="font-medium text-kumo-danger">{pluralize(documents, "document")}</span>{" "}
          inside it
        </>
      ) : null}
      . This cannot be undone.
    </>
  );
}

// Visibility choices (admins only — non-admins can only make private collections).
const VISIBILITY_OPTIONS = [
  {
    value: "private" as const,
    Icon: Lock,
    title: "Only me",
    description: "Private to your account. Only you can view and edit it.",
  },
  {
    value: "public" as const,
    Icon: Buildings,
    title: "Everyone",
    description: "Shared across your organization and turned on for all users.",
  },
];

const CONTENT_SOURCE_OPTIONS = [
  {
    value: "web" as const,
    Icon: PencilSimple,
    title: "Editable documents",
    description: "Create, edit, and delete files through the Cloudflare OS UI.",
  },
  {
    value: "git" as const,
    Icon: GitBranch,
    title: "Git mirror",
    description: "Push content from git using repository mirroring. All changes must be made through git.",
  },
];

// Full-pane "create collection" destination (not a modal): you name it, then land inside it to add
// documents. Quick edit / delete stay as modals.
function CreateCollectionView({
  onCancel,
  onCreated,
}: {
  onCancel: () => void;
  onCreated: (collectionId: string) => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [visibility, setVisibility] = useState<ContextCollectionVisibility>("private");
  const [source, setSource] = useState<ContextCollectionContent["source"]>("web");
  const [icon, setIcon] = useState(DEFAULT_COLLECTION_ICON);
  const [creating, setCreating] = useState(false);
  // Only admins may create public collections.
  const [isAdmin, setIsAdmin] = useState(false);
  const [supportsGitCollections, setSupportsGitCollections] = useState(false);

  useEffect(() => {
    let cancelled = false;
    context
      .getViewerInfo()
      .then((info) => {
        if (!cancelled) {
          setIsAdmin(info.isAdmin);
          setSupportsGitCollections(info.supportsGitCollections);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setIsAdmin(false);
          setSupportsGitCollections(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [context]);

  const handleCreate = async () => {
    if (!title.trim() || creating) return;
    setCreating(true);
    try {
      const metadata = await context.createContextCollection(
        title.trim(),
        description.trim(),
        visibility,
        icon,
        source,
      );
      toasts.add({ title: "Collection created", variant: "success" });
      onCreated(metadata.id);
    } catch {
      toasts.add({ title: "Failed to create collection", variant: "error" });
      setCreating(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="ctx-rise px-3 pb-3 pt-10">
        <button
          type="button"
          onClick={onCancel}
          className="press mb-3 -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
        >
          <CaretLeft size={14} />
          Context &amp; Skills
        </button>
        <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
          New collection
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
          A collection of documents, skills, and other files your agents can use.
        </p>
      </header>

      <div className="ctx-scroll min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
        <div className="max-w-xl px-3">
          <div className="space-y-5">
            <div className="ctx-rise" style={{ animationDelay: "60ms" }}>
              <CollectionNameField
                icon={icon}
                onIconChange={setIcon}
                value={title}
                onChange={setTitle}
                onEnter={handleCreate}
                autoFocus
              />
            </div>
            <div className="ctx-rise" style={{ animationDelay: "120ms" }}>
              <CollectionDescriptionField value={description} onChange={setDescription} />
            </div>
            {supportsGitCollections && (
              <div className="ctx-rise" style={{ animationDelay: "160ms" }}>
                <FieldLabel>Type</FieldLabel>
                <div role="radiogroup" aria-label="Collection type" className="grid gap-2">
                  {CONTENT_SOURCE_OPTIONS.map(({
                    value,
                    Icon,
                    title: optionTitle,
                    description: optionDescription,
                  }) => {
                    const selected = source === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setSource(value)}
                        className={`press flex items-start gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 ease-out ${
                          selected
                            ? "border-kumo-brand/50 bg-kumo-brand/[0.05]"
                            : "border-kumo-line bg-kumo-base hover:border-kumo-ring/60"
                        }`}
                      >
                        <Icon
                          size={16}
                          weight={selected ? "fill" : "regular"}
                          className={`mt-0.5 shrink-0 ${selected ? "text-kumo-brand" : "text-kumo-subtle"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {optionTitle}
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                            {optionDescription}
                          </span>
                        </span>
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                          {selected && (
                            <Check size={13} weight="bold" className="text-kumo-brand" />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
            {isAdmin && (
              <div className="ctx-rise" style={{ animationDelay: "200ms" }}>
                <FieldLabel>Visibility</FieldLabel>
                <div role="radiogroup" aria-label="Visibility" className="grid gap-2">
                  {VISIBILITY_OPTIONS.map(({
                    value,
                    Icon,
                    title: optionTitle,
                    description: optionDescription,
                  }) => {
                    const selected = visibility === value;
                    return (
                      <button
                        key={value}
                        type="button"
                        role="radio"
                        aria-checked={selected}
                        onClick={() => setVisibility(value)}
                        className={`press flex items-start gap-3 rounded-xl border-2 px-3 py-2.5 text-left transition-[border-color,background-color] duration-150 ease-out ${
                          selected
                            ? "border-kumo-brand/50 bg-kumo-brand/[0.05]"
                            : "border-kumo-line bg-kumo-base hover:border-kumo-ring/60"
                        }`}
                      >
                        <Icon
                          size={16}
                          weight={selected ? "fill" : "regular"}
                          className={`mt-0.5 shrink-0 ${selected ? "text-kumo-brand" : "text-kumo-subtle"}`}
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {optionTitle}
                          </span>
                          <span className="mt-0.5 block text-[12px] leading-4 tracking-[-0.2px] text-kumo-subtle">
                            {optionDescription}
                          </span>
                        </span>
                        <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center">
                          {selected && (
                            <Check size={13} weight="bold" className="text-kumo-brand" />
                          )}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>

          <div
            className="ctx-rise mt-6 flex items-center justify-end gap-2"
            style={{ animationDelay: "220ms" }}
          >
            {/* !h-9 matches the primary CTA so the footer pair aligns. */}
            <WorkshopButton
              tone="secondary"
              onClick={onCancel}
              disabled={creating}
              className="!h-9"
            >
              Cancel
            </WorkshopButton>
            {/* Orange brand "create" button (page CTA, not a modal primary). The disabled overrides
                keep the inactive state grey rather than faded orange. */}
            <WorkshopButton
              tone="primary"
              onClick={handleCreate}
              loading={creating}
              disabled={!title.trim()}
              className="press !bg-kumo-brand text-white enabled:hover:!bg-kumo-brand-hover disabled:!bg-kumo-fill disabled:!text-kumo-inactive disabled:!opacity-100"
            >
              Create collection
            </WorkshopButton>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export default function ContextLibraryPage() {
  const context = useContextApi();

  // Iframe-local selection state (no router/URL).
  const [selectedCollection, setSelectedCollection] = useState<string | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<string | null>(null);

  const goToCollection = useCallback((id: string | null) => {
    setSelectedCollection(id);
    setSelectedDoc(null);
  }, []);
  const goToDoc = useCallback((path: string | null) => {
    setSelectedDoc(path);
  }, []);

  const [search, setSearch] = useState("");
  const [creating, setCreating] = useState(false);

  const [enabled, setEnabled] = useState<EnabledCollectionInfo[]>([]);
  const [enabledLoaded, setEnabledLoaded] = useState(false);

  const loadAll = useCallback(async () => {
    const enabledResult = await context
      .listEnabledContextCollections()
      .catch(() => null);
    if (enabledResult) {
      setEnabled(enabledResult);
      setEnabledLoaded(true);
    }
  }, [context]);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const searchLower = search.toLowerCase();
  // One combined list: public (org) collections first, then your own, each alphabetical.
  const filtered = useMemo(
    () =>
      enabled
        .filter(
          (c) =>
            !searchLower ||
            c.title.toLowerCase().includes(searchLower) ||
            c.description.toLowerCase().includes(searchLower),
        )
        .sort((a, b) => {
          if (a.source !== b.source) return a.source === "public" ? -1 : 1;
          return a.title.localeCompare(b.title);
        }),
    [enabled, searchLower],
  );

  const initialLoading = !enabledLoaded && enabled.length === 0;

  // On success, land inside the new collection rather than back on the list.
  if (creating) {
    return (
      <CreateCollectionView
        onCancel={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          goToCollection(id);
          loadAll();
        }}
      />
    );
  }

  if (selectedCollection) {
    return (
      <div className="h-full bg-kumo-base">
        <CollectionEditor
          collectionId={selectedCollection}
          selectedPath={selectedDoc}
          onSelectPath={goToDoc}
          onBack={() => {
            goToCollection(null);
            loadAll();
          }}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-6 sm:px-10">
      <header className="flex items-end justify-between gap-4 px-3 pb-3 pt-10">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight text-kumo-default">
            Context &amp; Skills
          </h1>
          <p className="mt-1 max-w-2xl text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
            Collections of documents, skills, and other files your agents can use.
          </p>
        </div>
        {enabled.length > 0 && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="press inline-flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover"
          >
            <Plus size={14} weight="bold" />
            New collection
          </button>
        )}
      </header>

      {enabled.length > 0 && (
        <div className="mb-4 px-3">
          <div className="relative">
            <MagnifyingGlass
              size={16}
              className="absolute left-3 top-1/2 -translate-y-1/2 text-kumo-inactive"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search collections…"
              className="h-9 w-full rounded-lg border border-kumo-line bg-kumo-base pl-9 pr-4 text-[13px] tracking-[-0.25px] text-kumo-default placeholder:text-kumo-inactive transition-[border-color,box-shadow] duration-150 ease-out focus:border-kumo-ring focus:outline-none focus:ring-[3px] focus:ring-kumo-ring/15"
            />
          </div>
        </div>
      )}

      <div className="ctx-scroll min-h-0 flex-1 overflow-y-auto pb-8 pt-1">
        {initialLoading ? (
          <CollectionsSkeleton />
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 py-20 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-kumo-fill text-kumo-subtle">
              <BookOpen size={18} />
            </div>
            <div>
              <p className="text-sm font-medium text-kumo-default">
                {search ? "No collections match" : "No collections yet"}
              </p>
              <p className="mx-auto mt-1 max-w-sm text-[13px] leading-[18px] text-kumo-subtle">
                {search
                  ? "Try a different search term."
                  : "Create a collection to give your agents context to work with."}
              </p>
            </div>
            {!search && (
              <button
                type="button"
                onClick={() => setCreating(true)}
                className="press mt-1 inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg bg-kumo-brand px-3.5 text-[13px] font-medium tracking-[-0.25px] text-white transition-colors hover:bg-kumo-brand-hover"
              >
                <Plus size={14} weight="bold" />
                New collection
              </button>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {filtered.map((c) => (
              <CollectionRow
                key={c.id}
                collection={c}
                onClick={() => goToCollection(c.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection Header (read-only display + settings menu)
// ---------------------------------------------------------------------------

function MetaField({
  label,
  children,
  align = "left",
}: {
  label: string;
  children: ReactNode;
  align?: "left" | "right";
}) {
  return (
    <div className={`flex flex-col gap-1 ${align === "right" ? "items-end text-right" : ""}`}>
      <span className="text-[11px] leading-none font-medium tracking-[-0.1px] text-kumo-inactive">
        {label}
      </span>
      <span className="text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-default">
        {children}
      </span>
    </div>
  );
}

// The collection overview — identity, description, and metadata shown in the detail pane when no
// file is selected. Collection-level actions (edit/delete) live on the index's ⋮ menu.
function CollectionOverview({
  metadata,
  canWrite,
  supportsGitCollections,
  refreshingSource,
  onRefreshSource,
  onEditDetails,
  onManageGitTokens,
  onDelete,
}: {
  metadata: ContextCollectionMetadata;
  canWrite: boolean;
  supportsGitCollections: boolean;
  refreshingSource: boolean;
  onRefreshSource: () => void;
  onEditDetails: () => void;
  onManageGitTokens: () => void;
  onDelete: () => void;
}) {
  const isPublic = metadata.visibility === "public";
  const isSynced = metadata.content.source === "git";
  return (
    <div className="ctx-scroll @container min-h-0 flex-1 overflow-auto">
      <div className="mx-auto max-w-[850px] px-8 py-10 sm:px-11 sm:py-12">
        <header>
          <div className="flex items-center justify-between gap-6">
            <div className="flex min-w-0 items-start gap-4">
              <CollectionIconTile icon={metadata.icon} size="lg" />
              <div className="min-w-0 pt-0.5">
                <h1 className="truncate text-2xl font-semibold leading-8 tracking-tight text-kumo-default">
                  {metadata.title}
                </h1>
                <p className="mt-1 text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
                  Context collection
                </p>
              </div>
            </div>
            {canWrite && (
              <div className="flex shrink-0 items-center gap-2">
                {isSynced && supportsGitCollections && (
                  <WorkshopButton
                    tone="secondary"
                    className="h-9!"
                    onClick={onRefreshSource}
                    loading={refreshingSource}
                  >
                    Refresh
                  </WorkshopButton>
                )}
                <CollectionOptionsMenu
                  isSynced={isSynced}
                  supportsGitCollections={supportsGitCollections}
                  onEditDetails={onEditDetails}
                  onManageGitTokens={onManageGitTokens}
                  onDelete={onDelete}
                />
              </div>
            )}
          </div>

          <div className="mt-9 grid grid-cols-2 gap-x-8 gap-y-5 @xl:grid-cols-4">
            <MetaField label="Source">
              <span className="inline-flex items-center gap-1.5">
                {isPublic ? <Buildings size={12} className="shrink-0" /> : <User size={12} className="shrink-0" />}
                {isPublic ? "Your organization" : "You"}
              </span>
            </MetaField>
            <MetaField label="Access">
              {isPublic ? "Everyone (required)" : "Private to you"}
            </MetaField>
            <MetaField label="Documents">{metadata.documentCount}</MetaField>
            <MetaField label={isSynced ? "Refreshed" : "Updated"} align="right">
              {metadata.content.source === "git"
                ? formatRelativeTime(metadata.content.lastRefreshedAt)
                : formatRelativeTime(metadata.lastUpdated)}
            </MetaField>
          </div>
        </header>

        {isSynced && !supportsGitCollections && (
          <section className="mt-8 rounded-xl border border-kumo-line bg-kumo-elevated/60 px-5 py-4">
            <p className="text-[13px] font-medium tracking-[-0.2px] text-kumo-default">
              Git synchronization unavailable
            </p>
            <p className="mt-1 text-[13px] leading-5 tracking-[-0.2px] text-kumo-subtle">
              Git content is read-only and shows its most recently cached version.
            </p>
          </section>
        )}

        <section className="mt-9 border-t border-kumo-line pt-8">
          <p className="mb-3 text-[13px] font-medium leading-none tracking-[-0.2px] text-kumo-subtle">
            Description
          </p>
          {metadata.description ? (
            <p className="max-w-3xl text-[15px] leading-7 tracking-[-0.2px] text-kumo-default">
              {metadata.description}
            </p>
          ) : (
            <p className="text-[13px] italic leading-5 text-kumo-inactive">
              No description yet.
            </p>
          )}
        </section>

        {metadata.documentCount === 0 && (
          <section className="mt-10 rounded-xl border border-kumo-line bg-kumo-elevated/60 px-5 py-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-kumo-fill text-kumo-subtle">
                <FileText size={15} />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium tracking-[-0.2px] text-kumo-default">
                  No files in this collection
                </p>
                <p className="mt-1 max-w-xl text-[13px] leading-5 tracking-[-0.2px] text-kumo-subtle">
                  {isSynced
                    ? supportsGitCollections
                      ? "This git mirror is empty. Mirror content from git, then refresh."
                      : "No Git content was cached before synchronization became unavailable."
                    : canWrite
                    ? "Use the + in the Files panel to create or upload skills or files. Agents use the names and descriptions to decide what to read."
                    : "This collection is empty."}
                </p>
              </div>
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function CollectionOptionsMenu({
  isSynced,
  supportsGitCollections,
  onEditDetails,
  onManageGitTokens,
  onDelete,
}: {
  isSynced: boolean;
  supportsGitCollections: boolean;
  onEditDetails: () => void;
  onManageGitTokens: () => void;
  onDelete: () => void;
}) {
  return (
    <KebabMenu
      trigger={
        <WorkshopIconButton
          aria-label="Collection options"
          title="Options"
          className="!h-9 !w-9 data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
        >
          <DotsThree size={18} weight="bold" />
        </WorkshopIconButton>
      }
    >
      <DropdownMenu.Item
        icon={<PencilSimple size={13} className="mr-2" />}
        onClick={onEditDetails}
        className={MENU_ITEM}
      >
        Edit details
      </DropdownMenu.Item>
      {isSynced && supportsGitCollections && (
        <DropdownMenu.Item
          icon={<Key size={13} className="mr-2" />}
          onClick={onManageGitTokens}
          className={MENU_ITEM}
        >
          Manage git tokens
        </DropdownMenu.Item>
      )}
      <DropdownMenu.Separator />
      <DropdownMenu.Item
        icon={<Trash size={13} className="mr-2" />}
        onClick={onDelete}
        className={`${MENU_ITEM_DANGER} text-kumo-danger`}
      >
        Delete collection
      </DropdownMenu.Item>
    </KebabMenu>
  );
}

// ---------------------------------------------------------------------------
// Collection Settings modal (edit metadata + delete)
// ---------------------------------------------------------------------------

function CollectionSettingsModal({
  open,
  // Which step to open on. "delete" lands on the type-to-confirm step, not immediate deletion.
  initialMode,
  metadata,
  supportsGitCollections,
  collectionId,
  onClose,
  onUpdated,
  onDeleted,
}: {
  open: boolean;
  initialMode: "edit" | "delete";
  metadata: ContextCollectionMetadata;
  supportsGitCollections: boolean;
  collectionId: string;
  onClose: () => void;
  onUpdated: () => void;
  onDeleted: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  const [mode, setMode] = useState<"edit" | "delete">(initialMode);
  const [title, setTitle] = useState(metadata.title);
  const [description, setDescription] = useState(metadata.description);
  const [icon, setIcon] = useState(metadata.icon ?? DEFAULT_COLLECTION_ICON);
  const [branch, setBranch] = useState(metadata.content.source === "git" ? metadata.content.branch : DEFAULT_GIT_BRANCH);
  const [confirmText, setConfirmText] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Reset state each time the modal opens, syncing to the latest metadata.
  useEffect(() => {
    if (open) {
      setMode(initialMode);
      setTitle(metadata.title);
      setDescription(metadata.description);
      setIcon(metadata.icon ?? DEFAULT_COLLECTION_ICON);
      setBranch(metadata.content.source === "git" ? metadata.content.branch : DEFAULT_GIT_BRANCH);
      setConfirmText("");
      setSaving(false);
      setDeleting(false);
    }
  }, [open, initialMode, metadata.title, metadata.description, metadata.icon, metadata.content]);

  const busy = saving || deleting;

  // Save is only meaningful once something actually differs from the saved collection.
  const hasChanges =
    title.trim() !== metadata.title ||
    description.trim() !== metadata.description ||
    icon !== (metadata.icon ?? DEFAULT_COLLECTION_ICON) ||
    (metadata.content.source === "git" && supportsGitCollections &&
      branch.trim() !== metadata.content.branch);

  const handleSave = async () => {
    const updates: {
      title?: string;
      description?: string;
      icon?: string;
      branch?: string;
    } = {};
    if (title.trim() !== metadata.title) updates.title = title.trim();
    if (description.trim() !== metadata.description)
      updates.description = description.trim();
    if (icon !== (metadata.icon ?? DEFAULT_COLLECTION_ICON))
      updates.icon = icon;
    if (metadata.content.source === "git" && supportsGitCollections &&
        branch.trim() !== metadata.content.branch)
      updates.branch = branch.trim();
    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }
    if (!title.trim()) {
      toasts.add({ title: "Name can't be empty", variant: "error" });
      return;
    }
    setSaving(true);
    try {
      await context.updateContextCollection(collectionId, updates);
      toasts.add({ title: "Collection updated", variant: "success" });
      onUpdated();
      onClose();
    } catch {
      toasts.add({ title: "Failed to update collection", variant: "error" });
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await context.deleteContextCollection(collectionId);
      toasts.add({ title: "Collection deleted", variant: "success" });
      onDeleted();
    } catch {
      toasts.add({ title: "Failed to delete collection", variant: "error" });
      setDeleting(false);
    }
  };

  const canDelete = confirmText.trim() === metadata.title.trim() && !deleting;

  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! w-[min(480px,calc(100vw-32px))]! overflow-visible bg-kumo-base p-0 top-[14%]! translate-y-0!"
        size="sm"
      >
        {mode === "edit" ? (
          <>
            <ModalHeader title="Edit collection" />

            <div className="space-y-5 px-4 py-5 sm:px-6">
              <div>
                <CollectionNameField
                  icon={icon}
                  onIconChange={setIcon}
                  value={title}
                  onChange={setTitle}
                  onEnter={handleSave}
                  autoFocus
                />
              </div>
              <div>
                <CollectionDescriptionField value={description} onChange={setDescription} />
              </div>
              {metadata.content.source === "git" && supportsGitCollections && (
                <div>
                  <FieldLabel>Git branch</FieldLabel>
                  <WorkshopInput
                    value={branch}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) => setBranch(e.target.value)}
                    onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                      if (e.key === "Enter" && hasChanges && title.trim()) void handleSave();
                    }}
                    placeholder={DEFAULT_GIT_BRANCH}
                    className="w-full"
                  />
                  <p className="mt-1 text-[12px] leading-4 text-kumo-subtle">
                    This branch to pull from when refreshing the collection.
                  </p>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
              <WorkshopButton tone="secondary" className="!h-9" disabled={saving} onClick={onClose}>
                Cancel
              </WorkshopButton>
              <WorkshopButton
                tone="primary"
                onClick={handleSave}
                loading={saving}
                disabled={!hasChanges || !title.trim()}
              >
                Save
              </WorkshopButton>
            </div>
          </>
        ) : (
          <>
            <ModalHeader
              title="Delete collection"
              description={
                <DeletePermanentlyDescription
                  name={metadata.title}
                  documents={metadata.documentCount}
                />
              }
            />

            <div className="px-4 py-5 sm:px-6">
              <FieldLabel>
                Type{" "}
                <span className="font-mono text-kumo-default">
                  {metadata.title}
                </span>{" "}
                to confirm
              </FieldLabel>
              <WorkshopInput
                value={confirmText}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                  setConfirmText(e.target.value)
                }
                placeholder={metadata.title}
                disabled={deleting}
                autoFocus
                className="w-full"
              />
            </div>

            <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
              <WorkshopButton
                tone="danger"
                className="!h-9"
                onClick={handleDelete}
                disabled={!canDelete}
                loading={deleting}
              >
                Delete collection
              </WorkshopButton>
            </div>
          </>
        )}
      </Dialog>
    </Dialog.Root>
  );
}

function GitTokenManagementModal({
  open,
  collectionId,
  branch,
  onClose,
}: {
  open: boolean;
  collectionId: string;
  branch: string;
  onClose: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const toastsRef = useRef(toasts);
  const { presenting, onOpenChangeComplete } = usePresentWhileOpen(open);

  const [loadingTokens, setLoadingTokens] = useState(false);
  const [creatingToken, setCreatingToken] = useState(false);
  const [revokingToken, setRevokingToken] = useState<string | null>(null);
  const [gitTokens, setGitTokens] = useState<ContextGitTokenInfo[]>([]);
  const [newGitToken, setNewGitToken] = useState<ContextGitTokenCreateResult | null>(null);

  toastsRef.current = toasts;

  useEffect(() => {
    if (open) {
      setLoadingTokens(false);
      setCreatingToken(false);
      setRevokingToken(null);
      setGitTokens([]);
      setNewGitToken(null);
    }
  }, [open]);

  const loadGitTokens = useCallback(async () => {
    if (!open) return;
    setLoadingTokens(true);
    try {
      const result = await context.listContextCollectionGitTokens(collectionId);
      setGitTokens(result.tokens);
    } catch (err) {
      toastsRef.current.add({ title: `Failed to load Git tokens: ${(err as Error).message}`, variant: "error" });
    } finally {
      setLoadingTokens(false);
    }
  }, [open, context, collectionId]);

  useEffect(() => {
    void loadGitTokens();
  }, [loadGitTokens]);

  const handleCreateGitToken = async () => {
    setCreatingToken(true);
    try {
      const token = await context.createContextCollectionGitToken(collectionId);
      setNewGitToken(token);
      await loadGitTokens();
      toasts.add({ title: "Git token created", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to create Git token: ${(err as Error).message}`, variant: "error" });
    } finally {
      setCreatingToken(false);
    }
  };

  const handleRevokeGitToken = async (tokenId: string) => {
    setRevokingToken(tokenId);
    try {
      await context.revokeContextCollectionGitToken(collectionId, tokenId);
      await loadGitTokens();
      toasts.add({ title: "Git token revoked", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to revoke Git token: ${(err as Error).message}`, variant: "error" });
    } finally {
      setRevokingToken(null);
    }
  };

  const copyToClipboard = (value: string, successTitle: string, errorTitle: string) =>
    void navigator.clipboard
      .writeText(value)
      .then(() => toasts.add({ title: successTitle, variant: "success" }))
      .catch(() => toasts.add({ title: errorTitle, variant: "error" }));

  const busy = creatingToken || revokingToken !== null;

  return (
    <Dialog.Root
      open={open && presenting}
      onOpenChange={(next: boolean) => {
        if (!busy && !next) onClose();
      }}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <Dialog
        className="z-[1000]! w-[min(560px,calc(100vw-32px))]! overflow-visible bg-kumo-base p-0 top-[14%]! translate-y-0!"
        size="sm"
      >
        <ModalHeader
          title="Manage git tokens"
        />

        <div className="space-y-3 px-4 py-5 sm:px-6">
          <div className="flex items-center justify-between gap-3">
            <p className="max-w-sm text-[12px] leading-4 text-kumo-subtle">
              Create a token to mirror content from an external git repository.
            </p>
            <WorkshopButton
              tone="secondary"
              className="h-8!"
              onClick={handleCreateGitToken}
              loading={creatingToken}
              disabled={busy}
            >
              Create token
            </WorkshopButton>
          </div>

          {newGitToken && (
            <div className="space-y-3 rounded-lg border border-green-500/30 bg-green-500/5 px-3 py-3 text-[12px] leading-5 text-kumo-subtle">
              <div>
                <div className="font-medium text-kumo-default">Token created</div>
                <p className="mt-0.5">
                  Use these credentials to push content to your collection. The password is only shown once.
                </p>
              </div>
              <div className="space-y-2">
                <div>
                  <FieldLabel>Remote URL</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      value={newGitToken.remote}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(newGitToken.remote, "Remote URL copied", "Failed to copy remote URL")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
                <div>
                  <FieldLabel>Password</FieldLabel>
                  <div className="mt-1 flex gap-2">
                    <input
                      readOnly
                      type="password"
                      value={newGitToken.plaintext}
                      className="min-w-0 flex-1 rounded border border-kumo-line bg-kumo-base px-2 py-1 font-mono text-[11px] text-kumo-default"
                    />
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => copyToClipboard(newGitToken.plaintext, "Password copied", "Failed to copy password")}
                    >
                      Copy
                    </WorkshopButton>
                  </div>
                </div>
              </div>
              <div className="border-t border-green-500/20 pt-3">
                <div className="font-medium text-kumo-default">Configure GitLab mirroring</div>
                <p className="mt-0.5">
                  These steps are specific to GitLab. Other git providers may use different setup flows.
                </p>
                <ol className="mt-2 list-decimal space-y-1.5 pl-4">
                  <li>Open your GitLab project and go to Settings &gt; Repository &gt; Mirroring repositories</li>
                  <li>Click "Add new" button to open setup flow</li>
                  <li>Set Git repository URL to the remote URL above</li>
                  <li>Set Mirror direction to Push</li>
                  <li>Set Authentication method to Username and Password</li>
                  <li>Set Username to "gitlab"</li>
                  <li>Set Password to the password above</li>
                  <li>Select Mirror specific branches and type in "{branch}"</li>
                  <li>Click "Mirror repository" button to finish</li>
                  <li>Click "Update now" button to trigger an initial push</li>
                </ol>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-kumo-line bg-kumo-base">
            {loadingTokens ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">Loading tokens...</div>
            ) : gitTokens.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-kumo-subtle">No Git tokens yet.</div>
            ) : (
              <div className="divide-y divide-kumo-line">
                {gitTokens.map((token) => (
                  <div
                    key={token.id}
                    className={`flex items-center justify-between gap-3 px-3 py-2 text-[12px] ${newGitToken?.id === token.id ? "bg-green-500/5" : ""}`}
                  >
                    <div className="min-w-0">
                      <div className="truncate font-mono text-[11px] text-kumo-default">{token.id}</div>
                      <div className="text-kumo-subtle">
                        expires {new Date(token.expiresAt).toLocaleDateString()}
                      </div>
                    </div>
                    <WorkshopButton
                      tone="secondary"
                      className="h-8!"
                      onClick={() => void handleRevokeGitToken(token.id)}
                      loading={revokingToken === token.id}
                      disabled={revokingToken !== null}
                    >
                      Revoke
                    </WorkshopButton>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
          <WorkshopButton tone="secondary" className="h-9!" disabled={busy} onClick={onClose}>
            Close
          </WorkshopButton>
        </div>
      </Dialog>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// File tree model
// ---------------------------------------------------------------------------

type TreeFolder = {
  name: string;
  path: string; // full path of this folder ("" = root)
  folders: Map<string, TreeFolder>;
  files: ContextDocumentSummary[];
};

// A folder is a skill when one of its files has a parsed skill name.
function isSkillFolder(folder: TreeFolder): boolean {
  return folder.files.some((file) => file.skillName !== undefined);
}

function buildTree(
  docs: ContextDocumentSummary[],
  extraFolders: string[],
): TreeFolder {
  const root: TreeFolder = {
    name: "",
    path: "",
    folders: new Map(),
    files: [],
  };
  const ensureFolder = (dir: string): TreeFolder => {
    if (!dir) return root;
    let node = root;
    let acc = "";
    for (const seg of dir.split("/")) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!node.folders.has(seg)) {
        node.folders.set(seg, {
          name: seg,
          path: acc,
          folders: new Map(),
          files: [],
        });
      }
      node = node.folders.get(seg)!;
    }
    return node;
  };
  for (const f of extraFolders) ensureFolder(f);
  for (const doc of docs) ensureFolder(dirName(doc.path)).files.push(doc);
  return root;
}

// Shared state for the recursive tree renderer.
type TreeCtx = {
  // Hides row actions and drag-to-move when false.
  canWrite: boolean;
  selectedPath: string | null;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
  selectFile: (path: string) => void;
  creating: { dir: string; kind: "file" | "folder" } | null;
  creatingName: string;
  setCreatingName: (v: string) => void;
  startCreate: (dir: string, kind: "file" | "folder") => void;
  commitCreate: () => void;
  cancelCreate: () => void;
  renaming: string | null;
  renameValue: string;
  setRenameValue: (v: string) => void;
  startRename: (path: string) => void;
  commitRename: () => void;
  cancelRename: () => void;
  deletePath: (path: string, isDir: boolean) => void;
  dragPath: string | null;
  setDragPath: (p: string | null) => void;
  dragOverDir: string | null;
  setDragOverDir: (d: string | null) => void;
  moveTo: (from: string, targetDir: string) => void;
};

// Depth-based indent: 16px per level, files nudged a further 16px to sit under the parent's caret.
const TREE_INDENT = 16;
const treePad = (depth: number, isFile: boolean) =>
  depth * TREE_INDENT + 8 + (isFile ? TREE_INDENT : 0);

// Hover-kebab trigger styling for tree rows: hidden until row hover / menu open.
const TREE_ROW_TRIGGER =
  "!h-5 !w-5 shrink-0 text-kumo-inactive opacity-0 hover:bg-kumo-tint hover:text-kumo-default group-hover:opacity-100 data-[popup-open]:opacity-100";

// Inline text field for the tree's create and rename rows: auto-focus, Enter-commit/Escape-cancel,
// and a blur guard that skips commit when focus moves to an action button. Rename rows pass
// `stopClickPropagation` so a click in the field doesn't select the row behind it.
function TreeInlineInput({
  value,
  onChange,
  onCommit,
  onCancel,
  placeholder,
  className = "",
  stopClickPropagation = false,
}: {
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  placeholder?: string;
  className?: string;
  stopClickPropagation?: boolean;
}) {
  return (
    <input
      autoFocus
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onClick={stopClickPropagation ? (e) => e.stopPropagation() : undefined}
      onKeyDown={(e) => {
        if (e.key === "Enter") onCommit();
        else if (e.key === "Escape") onCancel();
      }}
      onBlur={(e) => {
        if (!(e.relatedTarget instanceof HTMLButtonElement)) onCommit();
      }}
      placeholder={placeholder}
      spellCheck={false}
      autoCapitalize="off"
      autoCorrect="off"
      className={`min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] tracking-[-0.2px] text-kumo-default outline-none placeholder:text-kumo-inactive ${className}`}
    />
  );
}

function CreateRow({ depth, ctx }: { depth: number; ctx: TreeCtx }) {
  const isFolder = ctx.creating!.kind === "folder";
  return (
    <div
      className="mb-[2px] flex h-7 items-center gap-2 rounded-md bg-kumo-base pr-1.5 ring-1 ring-kumo-ring/40"
      style={{ paddingLeft: `${treePad(depth, !isFolder)}px` }}
    >
      {isFolder ? (
        <CaretRight size={12} className="shrink-0 text-kumo-inactive" />
      ) : (
        <FileText size={14} className="shrink-0 text-kumo-subtle" />
      )}
      <TreeInlineInput
        value={ctx.creatingName}
        onChange={ctx.setCreatingName}
        onCommit={ctx.commitCreate}
        onCancel={ctx.cancelCreate}
        placeholder={isFolder ? "folder-name" : "file-name.md"}
      />
    </div>
  );
}

function FolderView({
  folder,
  depth,
  ctx,
}: {
  folder: TreeFolder;
  depth: number;
  ctx: TreeCtx;
}) {
  const sortedFolders = [...folder.folders.values()].toSorted((a, b) =>
    a.name.localeCompare(b.name),
  );
  const sortedFiles = [...folder.files].toSorted((a, b) =>
    a.path.localeCompare(b.path),
  );
  const isRoot = folder.path === "";
  const open = isRoot || ctx.expanded.has(folder.path);
  const isDragOver = ctx.dragOverDir === folder.path;
  const isSkill = isSkillFolder(folder);

  const dropHandlers = {
    onDragOver: (e: React.DragEvent) => {
      if (ctx.dragPath) {
        e.preventDefault();
        // dragover fires continuously; only update state when the target dir actually changes,
        // otherwise every tick re-renders the whole tree.
        if (ctx.dragOverDir !== folder.path) ctx.setDragOverDir(folder.path);
      }
    },
    onDragLeave: () => {
      if (ctx.dragOverDir === folder.path) ctx.setDragOverDir(null);
    },
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (ctx.dragPath) ctx.moveTo(ctx.dragPath, folder.path);
      ctx.setDragOverDir(null);
      ctx.setDragPath(null);
    },
  };

  return (
    <div>
      {!isRoot && (
        <div
          draggable={ctx.canWrite && ctx.renaming !== folder.path}
          onDragStart={() => ctx.setDragPath(folder.path)}
          onDragEnd={() => {
            ctx.setDragPath(null);
            ctx.setDragOverDir(null);
          }}
          {...(ctx.canWrite ? dropHandlers : {})}
          className={[
            "group relative mb-[2px] flex h-7 items-center gap-1 rounded-md pr-1.5 transition-colors duration-150 ease-out",
            ctx.renaming === folder.path
              ? "bg-kumo-base ring-1 ring-kumo-ring/40"
              : isDragOver
                ? "bg-kumo-brand/10 ring-1 ring-kumo-brand/40"
                : "hover:bg-kumo-tint",
          ].join(" ")}
          style={{ paddingLeft: `${treePad(depth, false)}px` }}
        >
          <button
            onClick={() => ctx.toggleFolder(folder.path)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            {open ? (
              <CaretDown size={12} className="shrink-0 text-kumo-inactive" />
            ) : (
              <CaretRight size={12} className="shrink-0 text-kumo-inactive" />
            )}
            {ctx.renaming === folder.path ? (
              <TreeInlineInput
                value={ctx.renameValue}
                onChange={ctx.setRenameValue}
                onCommit={ctx.commitRename}
                onCancel={ctx.cancelRename}
                stopClickPropagation
                className="font-medium"
              />
            ) : (
              <>
                <span className="min-w-0 truncate text-[13px] leading-[18px] font-medium tracking-[-0.2px] text-kumo-default">
                  {folder.name}
                </span>
                {isSkill && (
                  <span
                    title="Contains a valid Agent Skill"
                    className="shrink-0 text-[10px] font-medium uppercase leading-none tracking-[0.4px] text-kumo-inactive"
                  >
                    skill
                  </span>
                )}
              </>
            )}
          </button>
          {ctx.canWrite && ctx.renaming !== folder.path && (
            <KebabMenu
              stopPropagation
              trigger={
                <WorkshopIconButton
                  aria-label={`Actions for ${folder.name}`}
                  onClick={(e: React.MouseEvent) => e.stopPropagation()}
                  className={TREE_ROW_TRIGGER}
                >
                  <DotsThree size={14} weight="bold" />
                </WorkshopIconButton>
              }
            >
              <DropdownMenu.Item
                icon={<FilePlus size={12} className="mr-2" />}
                onClick={() => ctx.startCreate(folder.path, "file")}
                className={MENU_ITEM}
              >
                New file
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<FolderPlus size={12} className="mr-2" />}
                onClick={() => ctx.startCreate(folder.path, "folder")}
                className={MENU_ITEM}
              >
                New folder
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<PencilSimple size={12} className="mr-2" />}
                onClick={() => ctx.startRename(folder.path)}
                className={MENU_ITEM}
              >
                Rename
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={<Trash size={12} className="mr-2" />}
                variant="danger"
                onClick={() => ctx.deletePath(folder.path, true)}
                className={MENU_ITEM_DANGER}
              >
                Delete
              </DropdownMenu.Item>
            </KebabMenu>
          )}
        </div>
      )}

      {open && (
        <div
          {...(isRoot ? dropHandlers : {})}
          className={
            isRoot && isDragOver ? "rounded-md ring-1 ring-kumo-brand/40" : ""
          }
        >
          {ctx.creating && ctx.creating.dir === folder.path && (
            <CreateRow depth={depth} ctx={ctx} />
          )}
          {sortedFolders.map((child) => (
            <FolderView
              key={child.path}
              folder={child}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
          {sortedFiles.map((doc) => (
            <FileView
              key={doc.path}
              doc={doc}
              depth={isRoot ? depth : depth + 1}
              ctx={ctx}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FileView({
  doc,
  depth,
  ctx,
}: {
  doc: ContextDocumentSummary;
  depth: number;
  ctx: TreeCtx;
}) {
  const Icon = isImageContentType(doc.contentType) ? ImageIcon : FileText;
  const selected = ctx.selectedPath === doc.path;
  const isRenaming = ctx.renaming === doc.path;
  return (
    <div
      draggable={ctx.canWrite && !isRenaming}
      onDragStart={() => ctx.setDragPath(doc.path)}
      onDragEnd={() => {
        ctx.setDragPath(null);
        ctx.setDragOverDir(null);
      }}
      className={[
        "group relative mb-[2px] flex h-7 items-center gap-2 rounded-md pr-1.5 text-[13px] leading-[18px] tracking-[-0.2px] transition-colors duration-150 ease-out",
        isRenaming
          ? "bg-kumo-base ring-1 ring-kumo-ring/40"
          : selected
            ? "cursor-pointer bg-kumo-recessed text-kumo-default"
            : "cursor-pointer text-kumo-default hover:bg-kumo-tint",
      ].join(" ")}
      style={{ paddingLeft: `${treePad(depth, true)}px` }}
      onClick={isRenaming ? undefined : () => ctx.selectFile(doc.path)}
      title={doc.description || undefined}
    >
      <Icon size={14} className={`shrink-0 ${selected ? "text-kumo-default" : "text-kumo-subtle"}`} />
      {isRenaming ? (
        <TreeInlineInput
          value={ctx.renameValue}
          onChange={ctx.setRenameValue}
          onCommit={ctx.commitRename}
          onCancel={ctx.cancelRename}
          stopClickPropagation
        />
      ) : (
        <span className={`min-w-0 flex-1 truncate ${selected ? "font-medium" : ""}`}>
          {baseName(doc.path)}
        </span>
      )}
      {ctx.canWrite && !isRenaming && (
        <KebabMenu
          stopPropagation
          trigger={
            <WorkshopIconButton
              aria-label={`Actions for ${baseName(doc.path)}`}
              onClick={(e: React.MouseEvent) => e.stopPropagation()}
              className={TREE_ROW_TRIGGER}
            >
              <DotsThree size={14} weight="bold" />
            </WorkshopIconButton>
          }
        >
          <DropdownMenu.Item
            icon={<PencilSimple size={12} className="mr-2" />}
            onClick={() => ctx.startRename(doc.path)}
            className={MENU_ITEM}
          >
            Rename
          </DropdownMenu.Item>
          <DropdownMenu.Item
            icon={<Trash size={12} className="mr-2" />}
            variant="danger"
            onClick={() => ctx.deletePath(doc.path, false)}
            className={MENU_ITEM_DANGER}
          >
            Delete
          </DropdownMenu.Item>
        </KebabMenu>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Collection Editor (file manager + document editor)
// ---------------------------------------------------------------------------

function CollectionEditor({
  collectionId,
  selectedPath,
  onSelectPath,
  onBack,
}: {
  collectionId: string;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  onBack: () => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  const [docs, setDocs] = useState<ContextDocumentSummary[]>([]);
  const [metadata, setMetadata] = useState<ContextCollectionMetadata | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsMode, setSettingsMode] = useState<"edit" | "delete">("edit");
  const [gitTokensOpen, setGitTokensOpen] = useState(false);
  const openSettings = (m: "edit" | "delete") => {
    setSettingsMode(m);
    setSettingsOpen(true);
  };
  // Default read-only until access loads so edit controls never flash to viewers.
  const [canWrite, setCanWrite] = useState(false);
  const [supportsGitCollections, setSupportsGitCollections] = useState(false);
  const [refreshingSource, setRefreshingSource] = useState(false);

  // Tree ⋮ deletes route through the same in-app confirmation dialog the document toolbar uses,
  // rather than a native confirm() that breaks out of the app chrome.
  const [pendingDelete, setPendingDelete] = useState<{
    path: string;
    isDir: boolean;
    count: number;
  } | null>(null);
  const [deletingPath, setDeletingPath] = useState(false);
  const deletePresentation = usePresentWhileOpen(!!pendingDelete);
  // Deferred until the delete dialog's close animation finishes (run from onOpenChangeComplete),
  // else swapping the pane flickers behind the exiting backdrop.
  const afterDeleteExitRef = useRef<(() => void) | null>(null);

  // Parent owns selection; alias keeps local handlers small.
  const setSelectedPath = onSelectPath;
  const [editOnOpenPath, setEditOnOpenPath] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [pendingFolders, setPendingFolders] = useState<Set<string>>(new Set());

  const [creating, setCreating] = useState<{
    dir: string;
    kind: "file" | "folder";
  } | null>(null);
  const [creatingName, setCreatingName] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [dragPath, setDragPath] = useState<string | null>(null);
  const [dragOverDir, setDragOverDir] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);
  const dirtyRef = useRef(false);
  dirtyRef.current = dirty;

  // Guard tab close/reload; in-iframe navigation is handled by the caller.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dirInputRef = useRef<HTMLInputElement>(null);
  const canEditDocuments = canWrite && metadata?.content.source !== "git";

  const loadDocs = useCallback(async () => {
    try {
      const [meta, list, writable, viewer] = await Promise.all([
        context.getContextCollectionMetadata(collectionId),
        context.listContextDocuments(collectionId),
        context.canWriteContextCollection(collectionId),
        context.getViewerInfo(),
      ]);
      setMetadata(meta);
      setDocs(list);
      setCanWrite(writable);
      setSupportsGitCollections(viewer.supportsGitCollections);
    } catch (err) {
      console.error("Failed to load documents:", err);
    } finally {
      setLoading(false);
    }
  }, [context, collectionId]);

  useEffect(() => {
    loadDocs();
  }, [loadDocs]);

  const handleRefreshArtifactSource = async () => {
    setRefreshingSource(true);
    try {
      await context.syncContextCollectionArtifactSource(collectionId);
      await loadDocs();
      toasts.add({ title: "Collection refreshed", variant: "success" });
    } catch (err) {
      toasts.add({ title: `Failed to refresh: ${(err as Error).message}`, variant: "error" });
    } finally {
      setRefreshingSource(false);
    }
  };

  useEffect(() => {
    if (!selectedPath) return;
    const segs = selectedPath.split("/");
    if (segs.length <= 1) return;
    setExpanded((prev) => {
      const next = new Set(prev);
      let acc = "";
      for (let i = 0; i < segs.length - 1; i++) {
        acc = acc ? `${acc}/${segs[i]}` : segs[i];
        next.add(acc);
      }
      return next;
    });
  }, [selectedPath]);

  const toggleFolder = (path: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const startCreate = (dir: string, kind: "file" | "folder") => {
    if (dir) setExpanded((p) => new Set(p).add(dir));
    setCreating({ dir, kind });
    setCreatingName("");
  };
  const cancelCreate = () => {
    setCreating(null);
    setCreatingName("");
  };

  const commitCreate = async () => {
    if (!creating) return;
    const name = creatingName.trim();
    if (!name) {
      cancelCreate();
      return;
    }
    const path = joinPath(creating.dir, name);
    if (creating.kind === "folder") {
      setPendingFolders((p) => new Set(p).add(path));
      setExpanded((p) => new Set(p).add(path));
      cancelCreate();
      return;
    }
    // Files start empty; content type comes from the path.
    try {
      const filePath = /\.[^/]+$/.test(path) ? path : `${path}.md`;
      await context.putContextDocument(collectionId, filePath, {
        description: "",
        body: "",
        contentType: contentTypeFromPath(filePath),
      });
      cancelCreate();
      await loadDocs();
      setEditOnOpenPath(filePath);
      setSelectedPath(filePath);
    } catch {
      toasts.add({ title: "Failed to create file", variant: "error" });
    }
  };

  const startRename = (path: string) => {
    setRenaming(path);
    setRenameValue(baseName(path));
  };
  const cancelRename = () => {
    setRenaming(null);
    setRenameValue("");
  };
  // Move a file or folder from -> dest, following the selection into the moved subtree. Throws on
  // RPC failure so callers can surface the right message.
  const relocate = async (from: string, dest: string) => {
    if (pendingFolders.has(from)) {
      setPendingFolders((p) => {
        const next = new Set(p);
        next.delete(from);
        next.add(dest);
        return next;
      });
    } else {
      await context.moveContextDocument(collectionId, from, dest);
    }
    if (selectedPath === from || selectedPath?.startsWith(from + "/")) {
      setSelectedPath(replacePathPrefix(selectedPath, from, dest));
    }
    await loadDocs();
  };

  const commitRename = async () => {
    if (!renaming) return;
    const newName = renameValue.trim();
    const oldName = baseName(renaming);
    if (!newName || newName === oldName) {
      cancelRename();
      return;
    }
    const dest = joinPath(dirName(renaming), newName);
    try {
      await relocate(renaming, dest);
    } catch (err) {
      toasts.add({
        title: `Failed to rename: ${(err as Error).message}`,
        variant: "error",
      });
    } finally {
      cancelRename();
    }
  };

  const moveTo = async (from: string, targetDir: string) => {
    // Reject self/descendant moves; same-dir moves are no-ops.
    if (targetDir === from || targetDir.startsWith(from + "/")) return;
    if (dirName(from) === targetDir) return;
    const dest = joinPath(targetDir, baseName(from));
    try {
      await relocate(from, dest);
    } catch (err) {
      toasts.add({
        title: `Failed to move: ${(err as Error).message}`,
        variant: "error",
      });
    }
  };

  // Open the confirmation dialog. Locally-created empty folders are state-only, so remove them
  // instantly without a prompt.
  const deletePath = (path: string, isDir: boolean) => {
    if (isDir && pendingFolders.has(path)) {
      setPendingFolders((p) => {
        const n = new Set(p);
        n.delete(path);
        return n;
      });
      return;
    }
    const count = isDir
      ? docs.filter((d) => d.path === path || d.path.startsWith(path + "/")).length
      : 0;
    setPendingDelete({ path, isDir, count });
  };

  const performDeletePath = async () => {
    if (!pendingDelete) return;
    const { path, isDir } = pendingDelete;
    setDeletingPath(true);
    try {
      if (isDir) {
        const inDir = docs.filter(
          (d) => d.path === path || d.path.startsWith(path + "/"),
        );
        await runWithConcurrency(inDir, 6, (d) =>
          context.deleteContextDocument(collectionId, d.path),
        );
      } else {
        await context.deleteContextDocument(collectionId, path);
      }

      afterDeleteExitRef.current = () => {
        if (isDir) {
          if (selectedPath === path || selectedPath?.startsWith(path + "/"))
            setSelectedPath(null);
        } else if (selectedPath === path) {
          setSelectedPath(null);
        }
        void loadDocs();
      };
      setPendingDelete(null);
    } catch {
      toasts.add({
        title: isDir ? "Failed to delete folder" : "Failed to delete document",
        variant: "error",
      });
    } finally {
      setDeletingPath(false);
    }
  };

  const uploadFiles = async (files: FileList) => {
    let ok = 0,
      failed = 0;
    await runWithConcurrency(Array.from(files), 6, async (file) => {
      const rel = (file as any).webkitRelativePath || file.name;
      // Derive the type from the path (its extension), not the browser-reported file.type, so the
      // stored encoding matches how the editor and the agent read-path interpret it (both go by
      // extension). Trusting file.type caused e.g. .js to be stored base64 but shown as text.
      const ct = contentTypeFromPath(rel);
      try {
        const isText = isTextContentType(ct);
        const body = isText ? await file.text() : await fileToBase64(file);
        await context.putContextDocument(collectionId, rel, {
          // Self-describing files supply their own description; others start blank.
          description: extractDescription(ct, body) ?? "",
          body,
          contentType: ct,
        });
        ok++;
      } catch {
        failed++;
      }
    });
    toasts.add({
      title: `Uploaded ${pluralize(ok, "file")}${failed ? `, ${failed} failed` : ""}`,
      variant: failed ? "error" : "success",
    });
    await loadDocs();
  };

  const extraFolders = useMemo(() => [...pendingFolders], [pendingFolders]);
  const tree = useMemo(
    () => buildTree(docs, extraFolders),
    [docs, extraFolders],
  );

  const ctx: TreeCtx = {
    canWrite: canEditDocuments,
    selectedPath,
    expanded,
    toggleFolder,
    selectFile: (path) => {
      setEditOnOpenPath(null);
      setSelectedPath(path);
    },
    creating,
    creatingName,
    setCreatingName,
    startCreate,
    commitCreate,
    cancelCreate,
    renaming,
    renameValue,
    setRenameValue,
    startRename,
    commitRename,
    cancelRename,
    deletePath,
    dragPath,
    setDragPath,
    dragOverDir,
    setDragOverDir,
    moveTo,
  };

  // The collection is gone (deleted by an admin) or no longer accessible.
  if (!loading && !metadata) {
    return (
      <div className="h-full bg-kumo-base px-5 py-4 sm:px-8">
        <div className="mx-auto max-w-[520px]">
          <button
            onClick={onBack}
            className="press -ml-1 mb-4 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            <CaretLeft size={14} />
            Context &amp; Skills
          </button>
          <div className="rounded-xl border border-kumo-line bg-kumo-base px-5 py-10 text-center shadow-[0_1px_2px_rgba(20,17,16,0.03)]">
            <BookOpen size={32} className="mx-auto mb-3 text-kumo-subtle" />
            <p className="m-0 text-[15px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
              This collection is no longer available
            </p>
            <p className="mt-1 text-[13px] leading-[18px] font-normal tracking-[-0.25px] text-kumo-subtle">
              It may have been deleted.
            </p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="ctx-rise flex h-full w-full min-w-0 overflow-hidden bg-kumo-base">
      {metadata && (
        <CollectionSettingsModal
          open={settingsOpen}
          initialMode={settingsMode}
          metadata={metadata}
          supportsGitCollections={supportsGitCollections}
          collectionId={collectionId}
          onClose={() => setSettingsOpen(false)}
          onUpdated={loadDocs}
          onDeleted={onBack}
        />
      )}

      {metadata?.content.source === "git" && supportsGitCollections && (
        <GitTokenManagementModal
          open={gitTokensOpen}
          collectionId={collectionId}
          branch={metadata.content.branch}
          onClose={() => setGitTokensOpen(false)}
        />
      )}

      {/* In-app confirmation for tree ⋮ deletes (files and folders). */}
      <Dialog.Root
        open={!!pendingDelete && deletePresentation.presenting}
        onOpenChange={(next: boolean) => {
          if (!deletingPath && !next) setPendingDelete(null);
        }}
        onOpenChangeComplete={(next: boolean) => {
          deletePresentation.onOpenChangeComplete(next);
          if (!next) {
            afterDeleteExitRef.current?.();
            afterDeleteExitRef.current = null;
          }
        }}
      >
        <Dialog
          className="z-[1000]! w-[min(440px,calc(100vw-32px))]! bg-kumo-base p-0 top-[16%]! translate-y-0!"
          size="sm"
        >
          <ModalHeader
            title={pendingDelete?.isDir ? "Delete folder" : "Delete document"}
            description={
              <DeletePermanentlyDescription
                name={pendingDelete ? baseName(pendingDelete.path) : ""}
                documents={
                  pendingDelete?.isDir && pendingDelete.count > 0
                    ? pendingDelete.count
                    : undefined
                }
              />
            }
          />
          <div className="flex items-center justify-end gap-2 border-t border-kumo-line px-4 py-3 sm:px-6">
            <WorkshopButton
              tone="secondary"
              className="!h-9"
              disabled={deletingPath}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </WorkshopButton>
            <WorkshopButton
              tone="danger"
              className="!h-9"
              onClick={performDeletePath}
              loading={deletingPath}
            >
              {pendingDelete?.isDir ? "Delete folder" : "Delete document"}
            </WorkshopButton>
          </div>
        </Dialog>
      </Dialog.Root>

      {/*
        Fresh split workspace: persistent contents on the left, selected reading/editing surface on
        the right. It intentionally fills the iframe edge-to-edge like the app chrome and the skill
        manager references: one vertical rule, no nested cards, no dead header band.
      */}
      <aside
        className={`${selectedPath ? "hidden sm:flex" : "flex"} min-h-0 w-full flex-col overflow-x-hidden border-r border-kumo-line bg-kumo-base sm:w-[320px] sm:shrink-0`}
      >
        <div className="flex h-14 shrink-0 items-center px-5">
          <button
            onClick={onBack}
            className="press -ml-1 inline-flex items-center gap-1 rounded-md px-1 py-0.5 text-[13px] font-medium tracking-[-0.25px] text-kumo-subtle transition-colors hover:text-kumo-default"
          >
            <CaretLeft size={14} />
            Context &amp; Skills
          </button>
        </div>
          {metadata && (
            <div className="px-3 py-2.5">
              {/* The collection root doubles as a nav target back to the overview, and sits active
                  when nothing is selected. */}
              <div
                className={`flex items-center rounded-lg ${selectedPath ? "hover:bg-kumo-tint" : "bg-kumo-recessed"}`}
              >
                <button
                  onClick={() => setSelectedPath(null)}
                  title="Collection overview"
                  aria-current={selectedPath ? undefined : "page"}
                  className="flex min-w-0 flex-1 transform-none items-center gap-2.5 rounded-lg px-1.5 py-1.5 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring/30 active:scale-100"
                >
                  <CollectionIconTile icon={metadata.icon} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-[15px] font-semibold leading-5 tracking-[-0.25px] text-kumo-default">
                    {metadata.title}
                  </span>
                </button>
                {canWrite && (
                  <div className="pr-1 sm:hidden">
                    <CollectionOptionsMenu
                      isSynced={metadata.content.source === "git"}
                      supportsGitCollections={supportsGitCollections}
                      onEditDetails={() => openSettings("edit")}
                      onManageGitTokens={() => setGitTokensOpen(true)}
                      onDelete={() => openSettings("delete")}
                    />
                  </div>
                )}
              </div>
            </div>
          )}

          <div className="flex h-8 shrink-0 items-center justify-between gap-2 px-5">
            <span className="text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
              Files
            </span>
            {canEditDocuments && (
              <>
            <KebabMenu
              trigger={
                <WorkshopIconButton
                  aria-label="Add"
                  title="Add file or folder"
                  className="!h-6 !w-6 text-kumo-subtle hover:bg-kumo-tint hover:text-kumo-default data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
                >
                  <Plus size={14} weight="bold" />
                </WorkshopIconButton>
              }
            >
              <DropdownMenu.Item
                icon={<FilePlus size={13} className="mr-2" />}
                onClick={() => startCreate("", "file")}
                className={MENU_ITEM}
              >
                New file
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<FolderPlus size={13} className="mr-2" />}
                onClick={() => startCreate("", "folder")}
                className={MENU_ITEM}
              >
                New folder
              </DropdownMenu.Item>
              <DropdownMenu.Separator />
              <DropdownMenu.Item
                icon={<UploadSimple size={13} className="mr-2" />}
                onClick={() => fileInputRef.current?.click()}
                className={MENU_ITEM}
              >
                Upload files
              </DropdownMenu.Item>
              <DropdownMenu.Item
                icon={<Folder size={13} className="mr-2" />}
                onClick={() => dirInputRef.current?.click()}
                className={MENU_ITEM}
              >
                Upload folder
              </DropdownMenu.Item>
            </KebabMenu>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
            <input
              ref={dirInputRef}
              type="file"
              multiple
              // @ts-expect-error non-standard directory upload attribute
              webkitdirectory=""
              className="hidden"
              onChange={(e) => {
                if (e.target.files?.length) uploadFiles(e.target.files);
                e.target.value = "";
              }}
            />
              </>
            )}
          </div>
          <div className="ctx-scroll min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-3.5 pb-6 pt-0.5">
            {loading ? (
              <p className="px-2 py-2 text-[13px] text-kumo-subtle">Loading…</p>
            ) : docs.length === 0 && pendingFolders.size === 0 && !creating ? (
              <p className="px-2 py-2 text-[12px] leading-5 text-kumo-inactive">
                {metadata?.content.source === "git"
                  ? supportsGitCollections
                    ? "No files yet. Mirror content from git, then refresh."
                    : "No Git content was cached before synchronization became unavailable."
                  : canWrite ? "No files yet. Use + to create or upload skills or files." : "No files yet."}
              </p>
            ) : (
              <FolderView folder={tree} depth={0} ctx={ctx} />
            )}
          </div>
      </aside>

      {/* Detail: the selected document, or the collection overview when nothing is selected. */}
      <section className={`${selectedPath ? "flex" : "hidden sm:flex"} min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-kumo-base`}>
          {selectedPath ? (
            <>
              {/* Mobile-only: return to the file index (desktop shows both panes already). */}
              <button
                onClick={() => setSelectedPath(null)}
                className="flex sm:hidden flex-shrink-0 items-center gap-1 border-b border-kumo-line px-4 py-2.5 text-[13px] text-kumo-subtle transition-colors hover:text-kumo-default"
              >
                <CaretLeft size={14} />
                Files
              </button>
              <div className="min-h-0 min-w-0 flex-1 overflow-hidden">
                <DocumentEditor
                  key={selectedPath}
                  collectionId={collectionId}
                  path={selectedPath}
                  readOnly={!canEditDocuments}
                  initialMode={editOnOpenPath === selectedPath ? "edit" : "read"}
                  onDirtyChange={setDirty}
                  onChanged={loadDocs}
                  onRenamed={(newPath) => {
                    setDirty(false);
                    setSelectedPath(newPath);
                    loadDocs();
                  }}
                  onRequestDelete={() => deletePath(selectedPath, false)}
                />
              </div>
            </>
          ) : metadata ? (
            <CollectionOverview
              metadata={metadata}
              canWrite={canWrite}
              supportsGitCollections={supportsGitCollections}
              refreshingSource={refreshingSource}
              onRefreshSource={handleRefreshArtifactSource}
              onEditDetails={() => openSettings("edit")}
              onManageGitTokens={() => setGitTokensOpen(true)}
              onDelete={() => openSettings("delete")}
            />
          ) : null}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Markdown preview (View mode for .md documents)
// ---------------------------------------------------------------------------

// Rendered prose for Markdown in View mode (Edit mode drops to the source editor). Frontmatter is
// stripped — its fields already show in the "When to use this" row. Prose styling: `.kb-mdx-content`.
function MarkdownImage({
  collectionId,
  documentPath,
  imageCache,
  src = "",
  alt = "",
}: {
  collectionId: string;
  documentPath: string;
  imageCache: { current: Map<string, string> };
  src?: string;
  alt?: string;
}) {
  const context = useContextApi();
  const [resolvedSrc, setResolvedSrc] = useState(src);

  useEffect(() => {
    setResolvedSrc(src);
    if (!src || isExternalImageSrc(src)) return;

    let cancelled = false;
    const imagePath = resolveCollectionPath(dirName(documentPath), src);
    const cached = imageCache.current.get(imagePath);
    if (cached) {
      setResolvedSrc(cached);
      return;
    }
    context.getContextDocument(collectionId, imagePath)
      .then((doc) => {
        if (!cancelled && doc && isImageContentType(doc.contentType)) {
          const uri = dataUri(doc.contentType, doc.body);
          imageCache.current.set(imagePath, uri);
          setResolvedSrc(uri);
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [context, collectionId, documentPath, imageCache, src]);

  return <img src={resolvedSrc} alt={alt} />;
}

function MarkdownPreview({
  body,
  collectionId,
  documentPath,
}: {
  body: string;
  collectionId: string;
  documentPath: string;
}) {
  const content = useMemo(() => stripFrontmatter(body).trim(), [body]);
  const imageCache = useRef(new Map<string, string>());
  const components = useMemo(
    () => ({
      img({ src, alt }: ComponentProps<"img">) {
        return (
          <MarkdownImage
            collectionId={collectionId}
            documentPath={documentPath}
            imageCache={imageCache}
            src={typeof src === "string" ? src : ""}
            alt={typeof alt === "string" ? alt : ""}
          />
        );
      },
    }),
    [collectionId, documentPath],
  );

  return (
    <div className="ctx-scroll h-full min-w-0 overflow-auto">
      <div className="ctx-fade w-full min-w-0 max-w-full px-6 pb-12 pt-6 sm:max-w-[52rem] sm:px-10">
        <div className="kb-mdx-content min-w-0 max-w-full text-[16px] leading-[1.72] tracking-[-0.15px] text-kumo-default">
          {content ? (
            <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]} components={components}>
              {content}
            </ReactMarkdown>
          ) : (
            <p className="italic text-kumo-inactive">This document is empty.</p>
          )}
        </div>
      </div>
    </div>
  );
}

type DocumentBodyRenderProps = {
  body: string;
  collectionId: string;
  contentType: string;
  filename: string;
  isImage: boolean;
  isMarkdown: boolean;
  isText: boolean;
  mode: "read" | "edit";
  path: string;
  readOnly: boolean;
  onBodyChange: (value: string) => void;
};

function renderDocumentBody({
  body,
  collectionId,
  contentType,
  filename,
  isImage,
  isMarkdown,
  isText,
  mode,
  path,
  readOnly,
  onBodyChange,
}: DocumentBodyRenderProps): ReactNode {
  if (isImage) {
    return (
      <div className="flex h-full items-center justify-center p-4">
        <img
          src={dataUri(contentType, body)}
          alt={filename}
          className="max-h-full max-w-full object-contain"
        />
      </div>
    );
  }

  if (!isText) {
    return (
      <div className="p-4 text-[13px] text-kumo-subtle">
        Binary document ({contentType}, {Math.round((body.length * 3) / 4 / 1024)} KB). Use Replace to
        update it.
      </div>
    );
  }

  if (isMarkdown && mode === "read") {
    return (
      <MarkdownPreview
        body={body}
        collectionId={collectionId}
        documentPath={path}
      />
    );
  }

  return (
    <SourceEditor
      value={body}
      path={path}
      readOnly={readOnly || mode === "read"}
      onChange={onBodyChange}
    />
  );
}

// ---------------------------------------------------------------------------
// Document Editor (right pane)
// ---------------------------------------------------------------------------

function DocumentEditor({
  collectionId,
  path,
  readOnly,
  initialMode = "read",
  onChanged,
  onRenamed,
  onRequestDelete,
  onDirtyChange,
}: {
  collectionId: string;
  path: string;
  // Hide mutating controls and lock editors when true.
  readOnly: boolean;
  initialMode?: "read" | "edit";
  onChanged: () => void;
  // Parent re-selects + reloads after rename.
  onRenamed: (newPath: string) => void;
  onRequestDelete: () => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const context = useContextApi();
  const toasts = useKumoToastManager();
  // File name is the title; editing it renames the document.
  const [filename, setFilename] = useState(baseName(path));
  const [renaming, setRenaming] = useState(false);
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [skillName, setSkillName] = useState<string | null>(null);
  // Content type is path-derived, so renames update rendering immediately.
  const contentType = contentTypeFromPath(path);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const savedDocumentRef = useRef<{ description: string; body: string } | null>(null);
  // Documents open in View unless the caller requests Edit. For markdown, View is the rendered
  // preview and Edit the source; for other text, View is read-only source; for images/binaries,
  // Edit unlocks the description and Replace (the body itself is swapped, not edited inline).
  const [mode, setMode] = useState<"read" | "edit">(
    readOnly || initialMode !== "edit" ? "read" : "edit",
  );

  function documentIsDirty(nextDescription: string, nextBody: string): boolean {
    const saved = savedDocumentRef.current;
    if (!saved) return false;
    if (nextBody !== saved.body) return true;
    return (
      extractDescription(contentType, nextBody) === null &&
      nextDescription.trim() !== saved.description
    );
  }

  // Report dirty state for navigation guards.
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    context.getContextDocument(collectionId, path).then((d) => {
      if (cancelled) return;
      if (d) {
        // Self-describing files use extractedDescription below instead.
        savedDocumentRef.current = { description: d.description, body: d.body };
        setDescription(d.description);
        setBody(d.body);
        setSkillName(d.skillName ?? null);
        setDirty(false);
        setMode(readOnly || initialMode !== "edit" ? "read" : "edit");
      }
      // Also clears loading for not-found.
      setLoading(false);
    }).catch((err) => {
      if (cancelled) return;
      setLoading(false);
      toasts.add({
        title: `Failed to load document: ${(err as Error).message}`,
        variant: "error",
      });
    });
    return () => {
      cancelled = true;
    };
  }, [context, collectionId, path]);

  const isText = isTextContentType(contentType);
  const isImage = isImageContentType(contentType);
  const isMarkdown = isMarkdownContentType(contentType);
  // Some formats own their description (frontmatter/YAML/JSON); otherwise the author provides it.
  const extractedDescription = useMemo(
    () => extractDescription(contentType, body),
    [contentType, body],
  );
  const effectiveDescription = extractedDescription ?? description;

  const save = async (overrides?: { body?: string; contentType?: string }) => {
    setSaving(true);
    try {
      const savedBody = overrides?.body ?? body;
      const savedDescription = effectiveDescription.trim();
      await context.putContextDocument(collectionId, path, {
        description: savedDescription,
        body: savedBody,
        contentType: overrides?.contentType ?? contentType,
      });
      let saved = await context.getContextDocument(collectionId, path);
      savedDocumentRef.current = {
        description: saved?.description ?? savedDescription,
        body: saved?.body ?? savedBody,
      };
      setSkillName(saved?.skillName ?? null);
      setDirty(false);
      toasts.add({ title: "Saved", variant: "success" });
      onChanged();
    } catch {
      toasts.add({ title: "Failed to save", variant: "error" });
    } finally {
      setSaving(false);
    }
  };

  // Rename within the same directory; save dirty text first.
  const commitRename = async () => {
    const trimmed = filename.trim();
    if (!trimmed || trimmed === baseName(path)) {
      setFilename(baseName(path));
      return;
    }
    if (trimmed.includes("/")) {
      toasts.add({ title: "File name can't contain '/'", variant: "error" });
      setFilename(baseName(path));
      return;
    }
    const newPath = joinPath(dirName(path), trimmed);
    setRenaming(true);
    try {
      if (isText && dirty) await save();
      await context.moveContextDocument(collectionId, path, newPath);
      onRenamed(newPath);
    } catch (err) {
      toasts.add({ title: `Rename failed: ${(err as Error).message}`, variant: "error" });
      setFilename(baseName(path));
    } finally {
      setRenaming(false);
    }
  };

  const replaceFile = async (file: File) => {
    const newBody = await fileToBase64(file);
    setBody(newBody);
    // Content type stays path-derived.
    await save({ body: newBody });
  };

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-kumo-subtle">
        Loading…
      </div>
    );
  }

  // Editable files get a View/Edit toggle; read-only markdown gets rendered/source. Read-only
  // non-markdown (plain text, images, binaries) has nothing to toggle.
  const showModeToggle = !readOnly || isMarkdown;
  const descriptionIsEditable = !readOnly && extractedDescription === null && mode === "edit";

  return (
    <div className="flex h-full flex-col bg-transparent">
      <div className="flex h-14 shrink-0 items-center gap-3 border-b border-kumo-line px-6 sm:px-10">
        <div className="min-w-0 flex-1">
          <input
            value={filename}
            readOnly={readOnly || renaming}
            onChange={(e) => setFilename(e.target.value)}
            onBlur={() => { if (!readOnly) commitRename(); }}
            onKeyDown={(e) => {
              if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); }
              else if (e.key === "Escape") { setFilename(baseName(path)); e.currentTarget.blur(); }
            }}
            className="w-full bg-transparent text-[18px] font-semibold leading-6 tracking-[-0.4px] text-kumo-default focus:outline-none"
            placeholder="file-name.md"
            title="File name — edit to rename (the extension sets the type)"
          />

        </div>
        {/* Contextual actions sit left of the toggle so the always-present toggle/delete cluster
            stays right-anchored — toggling View/Edit never shifts the toggle. */}
        {!readOnly && dirty && (
          // Disabled overrides keep the inactive state grey rather than faded orange.
          <WorkshopButton
            tone="primary"
            className="!h-8 !bg-kumo-contrast !text-kumo-inverse enabled:hover:!bg-kumo-strong disabled:!bg-kumo-fill disabled:!text-kumo-inactive disabled:!opacity-100"
            onClick={() => save()}
            loading={saving}
            disabled={!dirty}
          >
            Save
          </WorkshopButton>
        )}
        {!readOnly && !isText && mode === "edit" && (
          <label className="press flex h-8 cursor-pointer items-center gap-1 rounded-lg border border-kumo-line px-2.5 text-[12px] font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default">
            <UploadSimple size={14} /> Replace
            <input
              type="file"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) replaceFile(f);
                e.target.value = "";
              }}
            />
          </label>
        )}
        {showModeToggle && (
          <div className="inline-flex h-8 shrink-0 items-center rounded-lg border border-kumo-line bg-kumo-fill p-0.5">
            {[
              { m: "read" as const, Icon: Eye, label: "View" },
              { m: "edit" as const, Icon: readOnly ? Code : PencilSimple, label: readOnly ? "Source" : "Edit" },
            ].map(({ m, Icon, label }) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                title={label}
                aria-label={label}
                aria-pressed={mode === m}
                className={`press inline-flex h-full items-center justify-center gap-1 rounded-md px-2.5 text-[12px] font-medium transition-colors ${
                  mode === m
                    ? "bg-kumo-base text-kumo-default shadow-sm ring-1 ring-kumo-line"
                    : "text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                <Icon size={14} />
                {label}
              </button>
            ))}
          </div>
        )}
        {!readOnly && (
          <>
          {/* Separate the destructive action from Save so it can't be fat-fingered. */}
          <span className="mx-0.5 h-5 w-px shrink-0 bg-kumo-line" aria-hidden="true" />
          <button
            onClick={onRequestDelete}
            title="Delete document"
            className="press flex h-8 w-8 items-center justify-center rounded-md text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-danger"
          >
            <Trash size={16} />
          </button>
          </>
        )}
      </div>

      {/* "When to use this" — the agent-facing purpose (used for retrieval & search). Files that
          declare their own description show it read-only; otherwise the author writes it. */}
      <div className="border-b border-kumo-line px-6 py-3.5 sm:px-10">
        <label className="mb-1.5 block text-[12px] font-medium tracking-[-0.15px] text-kumo-subtle">
          When to use this
          {skillName && (
            <span className="ml-1 font-mono text-kumo-brand">· /{skillName}</span>
          )}
          {extractedDescription !== null && (
            <span
              className="ml-1 text-kumo-inactive"
              title="Defined in this file; edit it in the document below."
            >
              · from file
            </span>
          )}
        </label>
        {extractedDescription !== null ? (
          <p className="max-w-3xl text-[14px] leading-5 tracking-[-0.2px] text-kumo-default">
            {effectiveDescription || (
              <span className="italic text-kumo-inactive">No description in this file yet.</span>
            )}
          </p>
        ) : descriptionIsEditable ? (
          <input
            value={description}
            onChange={(e) => {
              const nextDescription = e.target.value;
              setDescription(nextDescription);
              setDirty(documentIsDirty(nextDescription, body));
            }}
            placeholder="Describe what this document contains and when an agent should use it…"
            className="w-full bg-transparent text-[14px] leading-5 tracking-[-0.2px] text-kumo-default placeholder:text-kumo-inactive focus:outline-none"
          />
        ) : (
          <p className="max-w-3xl text-[14px] leading-5 tracking-[-0.2px] text-kumo-default">
            {description || (
              <span className="italic text-kumo-inactive">No description yet.</span>
            )}
          </p>
        )}
      </div>

      {/* Body — renders directly on the recessed panel (one cohesive surface, not a card in a card). */}
      <div className="min-h-0 flex-1 overflow-hidden">
        {renderDocumentBody({
          body,
          collectionId,
          contentType,
          filename,
          isImage,
          isMarkdown,
          isText,
          mode,
          path,
          readOnly,
          onBodyChange: (v) => {
            setBody(v);
            setDirty(documentIsDirty(description, v));
          },
        })}
      </div>

    </div>
  );
}

// Monospace font stack + syntax colors matching the Workshop's Monaco theme
// (workshop-frontend/src/components/monacoTheme.ts).
const monoFont =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace';

// Token colors matching the Workshop's Monaco theme, including its subdued markdown (headers use
// keyword purple, URLs green, the rest default).
const gadgetsHighlightStyleLight = HighlightStyle.define([
  { tag: t.comment, color: "#a39990", fontStyle: "italic" },
  {
    tag: [
      t.keyword,
      t.moduleKeyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self,
    ],
    color: "#8e3aa6",
  },
  { tag: t.operator, color: "#6b6157" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "#4d8a44" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#b56a1f" },
  { tag: [t.typeName, t.className, t.namespace], color: "#b56a1f" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#3a72c9" },
  { tag: [t.variableName, t.propertyName], color: "#1f1d1a" },
  { tag: t.constant(t.variableName), color: "#b56a1f" },
  { tag: t.standard(t.variableName), color: "#3a72c9" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: "#6b6157" },
  { tag: t.tagName, color: "#c14438" },
  { tag: t.attributeName, color: "#b56a1f" },
  { tag: t.attributeValue, color: "#4d8a44" },
  // Markdown: match Monaco (headers = keyword purple, URLs green, the rest default).
  { tag: t.heading, color: "#8e3aa6" },
  { tag: t.url, color: "#4d8a44" },
]);

const gadgetsEditorThemeLight = EditorView.theme(
  {
    "&": { color: "#1f1d1a", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: monoFont,
      lineHeight: "1.7",
      overflow: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--color-kumo-line) transparent",
    },
    ".cm-scroller::-webkit-scrollbar": { width: "4px", height: "4px" },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "var(--color-kumo-line)",
      borderRadius: "4px",
    },
    ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
    ".cm-content": { padding: "12px 0", caretColor: "#1f1d1a" },
    ".cm-line": { padding: "0 16px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#bdb7ae",
      fontSize: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 14px",
      minWidth: "28px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#6b6157" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#1f1d1a" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#b3d4ff",
    },
  },
  { dark: false },
);

const gadgetsHighlightStyleDark = HighlightStyle.define([
  { tag: t.comment, color: "#858396", fontStyle: "italic" },
  {
    tag: [
      t.keyword,
      t.moduleKeyword,
      t.controlKeyword,
      t.operatorKeyword,
      t.definitionKeyword,
      t.modifier,
      t.self,
    ],
    color: "#d8b4fe",
  },
  { tag: t.operator, color: "#b9b5c8" },
  { tag: [t.string, t.special(t.string), t.regexp, t.escape], color: "#86efac" },
  { tag: [t.number, t.bool, t.null, t.atom], color: "#fbbf24" },
  { tag: [t.typeName, t.className, t.namespace], color: "#fbbf24" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#93c5fd" },
  { tag: [t.variableName, t.propertyName], color: "#e8e6f0" },
  { tag: t.constant(t.variableName), color: "#fbbf24" },
  { tag: t.standard(t.variableName), color: "#93c5fd" },
  { tag: [t.punctuation, t.separator, t.bracket, t.paren, t.brace], color: "#b9b5c8" },
  { tag: t.tagName, color: "#fca5a5" },
  { tag: t.attributeName, color: "#fbbf24" },
  { tag: t.attributeValue, color: "#86efac" },
  { tag: t.heading, color: "#d8b4fe" },
  { tag: t.url, color: "#86efac" },
]);

const gadgetsEditorThemeDark = EditorView.theme(
  {
    "&": { color: "#e8e6f0", backgroundColor: "transparent", height: "100%", fontSize: "13px" },
    "&.cm-focused": { outline: "none" },
    ".cm-scroller": {
      fontFamily: monoFont,
      lineHeight: "1.7",
      overflow: "auto",
      scrollbarWidth: "thin",
      scrollbarColor: "var(--color-kumo-line) transparent",
    },
    ".cm-scroller::-webkit-scrollbar": { width: "4px", height: "4px" },
    ".cm-scroller::-webkit-scrollbar-thumb": {
      background: "var(--color-kumo-line)",
      borderRadius: "4px",
    },
    ".cm-scroller::-webkit-scrollbar-track": { background: "transparent" },
    ".cm-content": { padding: "12px 0", caretColor: "#e8e6f0" },
    ".cm-line": { padding: "0 16px" },
    ".cm-gutters": {
      backgroundColor: "transparent",
      border: "none",
      color: "#6d6880",
      fontSize: "12px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 8px 0 14px",
      minWidth: "28px",
    },
    ".cm-activeLineGutter": { backgroundColor: "transparent", color: "#b9b5c8" },
    ".cm-cursor, .cm-dropCursor": { borderLeftColor: "#e8e6f0" },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
      backgroundColor: "#4b3d66",
    },
  },
  { dark: true },
);

function editorThemeExtensions(mode: "light" | "dark"): Extension {
  return mode === "dark"
    ? [syntaxHighlighting(gadgetsHighlightStyleDark), gadgetsEditorThemeDark]
    : [syntaxHighlighting(gadgetsHighlightStyleLight), gadgetsEditorThemeLight];
}

// Pick a CodeMirror language grammar from the file extension; unknown types get none (plain text).
function languageForPath(path: string): Extension {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md" || ext === "markdown" || ext === "mdx") return markdown();
  if (ext === "json") return json();
  if (ext === "yaml" || ext === "yml") return yaml();
  if (["js", "jsx", "mjs", "cjs", "ts", "tsx"].includes(ext))
    return javascript({ jsx: ext.endsWith("x"), typescript: ext.startsWith("ts") });
  return [];
}

// CodeMirror source editor (Monaco doesn't run in this sandbox). Soft-wrap keeps prose-heavy source
// readable. Markdown uses MarkdownPreview in View mode; everything else uses this for both modes.
function SourceEditor({
  value,
  onChange,
  readOnly,
  path,
}: {
  value: string;
  onChange: (v: string) => void;
  readOnly?: boolean;
  path: string;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // Keep the latest onChange without recreating the editor.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const editComp = useRef(new Compartment());
  const themeComp = useRef(new Compartment());
  const themeMode = useResolvedThemeMode();
  // Read the current mode without re-running the create-once effect below.
  const themeModeRef = useRef(themeMode);
  themeModeRef.current = themeMode;

  // Create the editor once. `path` is stable per mount, so the grammar is fixed for its lifetime.
  useEffect(() => {
    if (!hostRef.current) return;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          history(),
          drawSelection(),
          indentOnInput(),
          bracketMatching(),
          EditorView.lineWrapping,
          themeComp.current.of(editorThemeExtensions(themeModeRef.current)),
          languageForPath(path),
          keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
          editComp.current.of([
            EditorState.readOnly.of(!!readOnly),
            EditorView.editable.of(!readOnly),
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString());
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Create the editor once; external value changes flow through the sync effect below.
  }, []);

  // Sync external value changes without disturbing the cursor on user edits: skip when `value`
  // already matches the document (the common case, since edits flow out and back in as `value`).
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (value !== current) {
      view.dispatch({ changes: { from: 0, to: current.length, insert: value } });
    }
  }, [value]);

  // React to View/Edit toggling (readOnly flips in place).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: editComp.current.reconfigure([
        EditorState.readOnly.of(!!readOnly),
        EditorView.editable.of(!readOnly),
      ]),
    });
  }, [readOnly]);

  // React to light/dark changes (theme swaps in place).
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure(editorThemeExtensions(themeMode)),
    });
  }, [themeMode]);

  return <div ref={hostRef} className="h-full overflow-hidden" />;
}
