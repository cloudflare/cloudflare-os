import { isTransientRpcError, logRpcFailure } from "./rpcErrors";
import {
  Fragment,
  memo,
  useState,
  useEffect,
  useLayoutEffect,
  useRef,
  useMemo,
  useCallback,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { reportIssue } from './errorReporting'
import {
  DropdownMenu,
  Popover,
  Tooltip,
  useKumoToastManager,
} from "@cloudflare/kumo";

import {
  CaretDown,
  CaretLeft,
  CaretRight,
  Check,
  X,
  Pencil,
  Trash,
  DotsThreeVertical,
  LinkSimple,
  Plug,
  Plus,
  Swap,
  ArrowUUpLeft,
  ArrowsClockwise,
  Lightning,
  Copy,
  WarningCircle,
  Code,
  File as FileIcon,
  PencilSimple,
  Brain,
  ShieldCheck,
  Terminal,
  Globe,
  MagnifyingGlass,
  Question,
  ArrowUpRight,
  Blueprint,
} from "@phosphor-icons/react";
import { RpcStub, RpcTarget } from "capnweb";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import * as Y from "yjs";
import styles from "./ChatInterface.module.css";
import {
  getStoredSelectedModel,
  persistSelectedModel,
} from "./modelSelection";
import {
  Overseer,
  GatekeeperClient,
  AiChatHistoryPage,
  AiChatMetadata,
  AiChatMessage,
  AiChatSubscriber,
  ActionLogEntry,
  AiChatAuthorInfo,
  CapsuleSpecifier,
  AiChatStreamEvent,
  AiToolCall,
  SlashCommandChoice,
  SlashCommandId,
  SlashCommandRequest,
  ChatAttachmentHandle,
  ChatAttachmentRef,
  WorkpieceId,
  BlueprintOutput,
  MessageFormatRef,
  OutputFormatOffer,
} from "@gadgets/workshop-shared/api";
import { ActionKind, ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import {
  parseSlashCommandInput, slashCommandTokenKey, stripSlashCommandToken,
} from "./components/chat/slash-command-input";
import {
  ComposerMirror, composerTextareaClass, type ComposerMirrorHandle, type MirrorToken,
} from "./components/chat/ComposerMirror";
import {
  useSlashCommandChoice, type OverseerSource,
} from "./components/chat/slash-command-catalog";
import {
  removeComposerToken, snapCaretOutOfRanges, spliceComposerToken, type ComposerRange,
} from "./components/chat/composer-tokens";
import CapsuleOverlay, { CAPSULE_OVERLAY_GAP } from "./CapsuleOverlay";
import type { SelectableItem } from "./ResourcePicker";
import GatekeeperModal from "./GatekeeperModal";
import { GatekeeperIcon } from "./components/GatekeeperIcon";
import { formatOf, FORMAT_ICONS } from "./components/format/formats";
import { FormatMiniature } from "./components/format/FormatVisuals";
import { formatIconDataUrl } from "./components/format/formatIconImage";
import { locateMessageFormatRefs } from "./components/format/messageFormatRefs";
import ComposerFormatMenuItems from "./components/format/ComposerFormatMenuItems";
import { HookToggle } from "./components/HookToggle";
import { handlePickerKeyDown } from "./pickerNavigation";
import { normalizeResourceUrl } from "./resourceMatching";
import DeleteConfirmationDialog from "./components/DeleteConfirmationDialog";
import AutoApproveConfirmDialog from "./components/AutoApproveConfirmDialog";
import { AlwaysApproveButton, ResolveButton } from "./components/ResolveButton";
import { WorkshopButton, WorkshopIconButton, WorkshopInput } from "./components/WorkshopControls";
import { useActionEntries } from "./useActions";
import { useAlwaysApproveTag } from "./useAlwaysApproveTag";
import { useResolveAction } from "./useResolveAction";
import { safeExternalUrl } from "./utils/safeExternalUrl";
import { useAuthenticatedApi } from "./AuthContext";
import { useVendorBranding } from "./useVendorBranding";
import OutOfCreditsModal from "./components/billing/OutOfCreditsModal";
import { useSlashCommandPicker } from "./components/chat/SlashCommandPicker";
import { formatFullTimestamp } from "./utils/formatTimestamp";
import { copyToClipboard } from "./clipboard";

export interface StreamingProposedChanges {
  updates: Uint8Array[];
  count: number;
}

type CreatedGadgetCardInfo = {
  gadgetId: WorkpieceId;
  title: string;
  isPending: boolean;

  // The output format this gadget was built as, inherited from the blueprint it came from.
  // Absent for a gadget built from scratch, which reads as a generic app.
  output?: BlueprintOutput;
};

function CreatedGadgetChatCard({
  gadget,
  onOpen,
}: {
  gadget: CreatedGadgetCardInfo;
  onOpen: () => void;
}) {
  return (
    <div className="group/createdApp relative w-full max-w-[440px]">
      <button
        type="button"
        onClick={onOpen}
        className="group flex w-full cursor-pointer items-stretch overflow-hidden rounded-2xl border border-kumo-line bg-kumo-base text-left shadow-[0_1px_2px_rgba(82,16,0,0.04)] transition-all duration-150 ease-out hover:-translate-y-px hover:shadow-[0_10px_28px_rgba(82,16,0,0.10)]"
      >
        <span
          className="relative grid w-[88px] flex-shrink-0 place-items-center overflow-hidden border-r border-kumo-line bg-kumo-tint/40"
          aria-hidden="true"
        >
          <span className="absolute inset-0 bg-gradient-to-br from-kumo-brand/[0.08] via-transparent to-transparent" />
          {/* Drawn from the shared format vocabulary, so this card depicts a Document as a page
              rather than a generic window the moment formats exist. */}
          <FormatMiniature output={gadget.output} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 px-3.5 py-3 pr-10">
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[14px] font-medium tracking-[-0.2px] text-kumo-default">
              {gadget.title}
            </span>
            <span className="mt-0.5 flex items-center gap-1.5 text-[12px] text-kumo-subtle">
              {gadget.isPending && (
                <span className="rounded-full bg-kumo-fill px-1.5 py-0.5 text-[10px] font-medium leading-none">
                  Draft
                </span>
              )}
              <span>
                {gadget.isPending
                    ? `New ${formatOf(gadget.output).noun.toLowerCase()} · Click to preview`
                    : `${formatOf(gadget.output).noun} · Click to open`}
              </span>
            </span>
          </span>
          <span className="grid h-7 w-7 flex-shrink-0 place-items-center rounded-full text-kumo-inactive transition-all duration-150 group-hover:bg-kumo-tint group-hover:text-kumo-default">
            <ArrowUpRight size={15} weight="bold" />
          </span>
        </span>
      </button>
    </div>
  );
}

// The file an agent is currently streaming edits into. Files are identified by (workpiece,
// filename) pairs since a chat can edit multiple gadgets.
export type ActiveFileTarget = {
  workpieceId: WorkpieceId;
  filename: string;
};

type DraftUpdateEntry = {
  timestamp: Date;
  author: AiChatAuthorInfo;
  update: Uint8Array;
};

type DraftChatState = {
  entries: DraftUpdateEntry[];
  latestAuthor: AiChatAuthorInfo | null;
};

type ChatListScope = "direct" | "agents" | "all";

const CHAT_LIST_SCOPE_LABELS: Record<ChatListScope, string> = {
  all: "All",
  direct: "Started by people",
  agents: "Started by agents",
};

const SHOW_THINKING_TRACES_KEY = "showThinkingTraces";

function getStoredShowThinkingTraces(): boolean {
  try {
    // Clean up the key this setting replaced.
    window.localStorage.removeItem("expandReasoningByDefault");
    return window.localStorage.getItem(SHOW_THINKING_TRACES_KEY) !== "false";
  } catch {
    return true;
  }
}

function persistShowThinkingTraces(show: boolean): void {
  try {
    window.localStorage.setItem(SHOW_THINKING_TRACES_KEY, show ? "true" : "false");
  } catch {
    // private mode / sandboxed iframes
  }
}

function refreshDraftLatestAuthor(state: DraftChatState) {
  state.latestAuthor =
    state.entries.length > 0 ? state.entries[state.entries.length - 1].author : null;
}

function pruneDraftEntriesBefore(
  drafts: Map<number, DraftChatState>,
  chatId: number,
  cutoff: Date,
) {
  let state = drafts.get(chatId);
  if (!state) {
    return false;
  }

  const cutoffTime = cutoff.getTime();
  const nextEntries = state.entries.filter(
    (entry) => entry.timestamp.getTime() > cutoffTime,
  );
  if (nextEntries.length === state.entries.length) {
    return false;
  }

  if (nextEntries.length === 0) {
    drafts.delete(chatId);
    return true;
  }

  state.entries = nextEntries;
  refreshDraftLatestAuthor(state);
  return true;
}

function getOrCreateDraftChatState(
  drafts: Map<number, DraftChatState>,
  chatId: number,
): DraftChatState {
  let state = drafts.get(chatId);
  if (!state) {
    state = {
      entries: [],
      latestAuthor: null,
    };
    drafts.set(chatId, state);
  }
  return state;
}

// Auto-resize a textarea element between min and max row heights.
function autoResizeTextarea(textarea: HTMLTextAreaElement, minRows: number, maxRows: number) {
  textarea.style.height = 'auto'
  const cs = getComputedStyle(textarea)
  const lineHeight = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5
  const paddingY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
  const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth)
  const minH = lineHeight * minRows + paddingY + borderY
  const maxH = lineHeight * maxRows + paddingY + borderY
  textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minH), maxH)}px`
  textarea.style.overflow = textarea.scrollHeight > maxH ? 'auto' : 'hidden'
}

// Internal capsule state tracked within ChatInput (not yet sent).
interface InputCapsule {
  start: number;
  length: number;
  gatekeeperId: number;
  description: ResourceDescription;
  // Which service the resource came from, so the composer can show its logo.
  vendorId?: string;
}

// A capsule's text begins with an em space, which reserves the box the mirror paints the vendor
// logo into, and a no-break space, which is the gap between the logo and the title. The word
// joiner keeps the two spaces (and the title) on one line, since the logo must not wrap away from
// what it labels.
const CAPSULE_LOGO_SLOT = "\u2003\u2060\u00a0";

// The format a new workspace will be made from, as a token in the composer's text.
type FormatToken = ComposerRange & {
  format: OutputFormatOffer;
  // Data URL for the format's icon, painted into the token's logo slot. Absent if it couldn't be
  // rendered, in which case the token carries no slot either.
  logo?: string;
};

const cssLogoUrls = new Map<string, string>();

// Vendor logo URLs are server-provided but end up inside a CSS `url()`, so check the scheme and
// escape what could terminate the string. Whitespace is rejected rather than escaped: no real logo
// URL contains any, and it keeps newlines out of the declaration.
function cssLogoUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  // Logos are inline SVG data URLs of a few kilobytes and the mirror re-renders on every
  // keystroke, so escape each one once.
  let cached = cssLogoUrls.get(url);
  if (cached === undefined) {
    cached = /^(https?:\/\/|data:image\/)/.test(url) && !/\s/.test(url)
      ? `url("${url.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}")`
      : "";
    cssLogoUrls.set(url, cached);
  }
  return cached || undefined;
}

function firstAccountIndex(items: readonly SelectableItem[]): number {
  const index = items.findIndex((item) => item.type === "account");
  return index > 0 ? index : 0;
}

// A slash command the user picked, tracked as the range of composer text that names it.
type SelectedSlashCommand = ComposerRange & {
  choice: SlashCommandChoice;
};

type PendingAttachment = {
  id: string;
  blob: Blob;
  name?: string;
  previewUrl?: string;
  mimeType: string;
  uploadState: "uploading" | "ready" | "error";
  ref?: ChatAttachmentHandle;
  error?: string;
};

const MAX_PENDING_ATTACHMENTS = 5;
const MAX_CHAT_ATTACHMENT_BYTES = 1024 * 1024;
const MAX_CHAT_ATTACHMENT_TOTAL_BYTES = 5 * 1024 * 1024;
const MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES = 25 * 1024 * 1024;
const CHAT_ATTACHMENT_IMAGE_MAX_EDGE = 1568;

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Failed to encode image.")), type, quality);
  });
}

async function prepareChatAttachment(file: File): Promise<{blob: Blob, mimeType: string}> {
  if (!file.type.startsWith("image/")) {
    if (file.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(`Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`);
    }
    return { blob: file, mimeType: file.type || "application/octet-stream" };
  }
  if (file.size > MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES) {
    throw new Error(`Images must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_SOURCE_IMAGE_BYTES)} or smaller before resizing.`);
  }

  const bitmap = await createImageBitmap(file);
  try {
    const supportedOriginalType = file.type === "image/jpeg" || file.type === "image/png" || file.type === "image/webp";
    if (supportedOriginalType && file.size <= MAX_CHAT_ATTACHMENT_BYTES && Math.max(bitmap.width, bitmap.height) <= CHAT_ATTACHMENT_IMAGE_MAX_EDGE) {
      return { blob: file, mimeType: file.type };
    }

    const scale = Math.min(1, CHAT_ATTACHMENT_IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to get 2D canvas context.");
    ctx.drawImage(bitmap, 0, 0, width, height);

    // Preserve supported source formats when resizing. In particular, converting PNG to JPEG would
    // discard transparency, and changing PNG/WebP encoding would make the original filename
    // extension inconsistent with the uploaded MIME type.
    const outputMimeType = supportedOriginalType ? file.type : "image/jpeg";
    const quality = outputMimeType === "image/png" ? undefined : 0.85;
    const blob = await canvasToBlob(canvas, outputMimeType, quality);
    if (blob.size > MAX_CHAT_ATTACHMENT_BYTES) {
      throw new Error(`Attachments must be ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_BYTES)} or smaller.`);
    }
    return { blob, mimeType: outputMimeType };
  } finally {
    bitmap.close();
  }
}

// Matches http:// and https:// URLs in text, stopping at whitespace and common delimiters.
const URL_REGEX = /https?:\/\/[^\s)>\]]*/g;
const CAPSULE_LINK_PREFIX = "/__gadgets_capsule__/";
const CAPSULE_TOKEN_PREFIX = "GADGETS_CAPSULE_";
const CAPSULE_TOKEN_SUFFIX = "_TOKEN";

type MarkdownAstNode = {
  type: string;
  value?: string;
  url?: string;
  children?: MarkdownAstNode[];
};

type TokenizedCapsuleMessage = {
  markdown: string;
  mentionsByToken: Map<string, Mention>;
};

function generateCapsuleToken(
  message: string,
  index: number,
  usedTokens: Set<string>,
) {
  let attempt = 0;
  while (true) {
    const suffix = attempt === 0 ? "" : `_${attempt}`;
    const token = `${CAPSULE_TOKEN_PREFIX}${index}${suffix}${CAPSULE_TOKEN_SUFFIX}`;
    if (!message.includes(token) && !usedTokens.has(token)) {
      return token;
    }
    attempt++;
  }
}

// A span of a message that renders as an object rather than as text. Capsules and formats share
// one pipeline; they differ only in what they draw and whether they carry authority.
type Mention =
  | { kind: "capsule"; capsule: CapsuleSpecifier }
  | { kind: "format"; format: MessageFormatRef };

function mentionText(mention: Mention): string {
  return mention.kind === "capsule"
      ? mention.capsule.description.title
      : mention.format.noun;
}

function buildTokenizedCapsuleMessage(
  message: string,
  capsules: CapsuleSpecifier[] | undefined,
  formats: MessageFormatRef[] | undefined,
): TokenizedCapsuleMessage {
  const spans = [
    ...(capsules ?? []).map(capsule =>
        ({position: capsule.position, length: capsule.length,
          mention: {kind: "capsule", capsule} as Mention})),
    ...(formats ?? []).map(format =>
        ({position: format.position, length: format.length,
          mention: {kind: "format", format} as Mention})),
  ].toSorted((a, b) => a.position - b.position);

  const usedTokens = new Set<string>();
  const mentionsByToken = new Map<string, Mention>();
  let markdown = "";
  let pos = 0;

  for (let i = 0; i < spans.length; i++) {
    const span = spans[i];
    // Spans are validated non-overlapping server-side, but a stored message predates that check and
    // is replayed verbatim, so skip anything that would rewind the cursor.
    if (span.position < pos) continue;
    const token = generateCapsuleToken(message, i, usedTokens);
    usedTokens.add(token);
    mentionsByToken.set(token, span.mention);
    markdown += message.slice(pos, span.position);
    markdown += token;
    pos = span.position + span.length;
  }

  markdown += message.slice(pos);
  return { markdown, mentionsByToken };
}

function splitTextOnCapsuleTokens(
  value: string,
  mentionsByToken: Map<string, Mention>,
): MarkdownAstNode[] | null {
  const tokens = [...mentionsByToken.keys()];
  const parts: MarkdownAstNode[] = [];
  let cursor = 0;
  let foundToken = false;

  while (cursor < value.length) {
    let nextIndex = -1;
    let nextToken: string | null = null;

    for (const token of tokens) {
      const index = value.indexOf(token, cursor);
      if (index !== -1 && (nextIndex === -1 || index < nextIndex)) {
        nextIndex = index;
        nextToken = token;
      }
    }

    if (nextToken === null) {
      break;
    }

    foundToken = true;
    if (nextIndex > cursor) {
      parts.push({
        type: "text",
        value: value.slice(cursor, nextIndex),
      });
    }

    parts.push({
      type: "link",
      url: `${CAPSULE_LINK_PREFIX}${encodeURIComponent(nextToken)}`,
      children: [
        {
          type: "text",
          value: (() => {
            const mention = mentionsByToken.get(nextToken);
            return mention ? mentionText(mention) : nextToken;
          })(),
        },
      ],
    });

    cursor = nextIndex + nextToken.length;
  }

  if (!foundToken) {
    return null;
  }

  if (cursor < value.length) {
    parts.push({
      type: "text",
      value: value.slice(cursor),
    });
  }

  return parts;
}

function replaceCapsuleTokensInTree(
  node: MarkdownAstNode,
  mentionsByToken: Map<string, Mention>,
) {
  if (!node.children || node.children.length === 0) {
    return;
  }

  const nextChildren: MarkdownAstNode[] = [];
  for (const child of node.children) {
    if (child.type === "text" && typeof child.value === "string") {
      const replacementNodes = splitTextOnCapsuleTokens(
        child.value,
        mentionsByToken,
      );
      if (replacementNodes) {
        nextChildren.push(...replacementNodes);
        continue;
      }
    }

    if (child.type !== "code" && child.type !== "inlineCode") {
      replaceCapsuleTokensInTree(child, mentionsByToken);
    }
    nextChildren.push(child);
  }

  node.children = nextChildren;
}

function createCapsuleRemarkPlugin(mentionsByToken: Map<string, Mention>) {
  return function capsuleRemarkPlugin() {
    return (tree: MarkdownAstNode) => {
      replaceCapsuleTokensInTree(tree, mentionsByToken);
    };
  };
}

// Names the binding edge a gadget-binding tool call touched, as `GADGET.BINDING` when the record
// says which gadget owns it. (Records written before named chat bindings carry only the binding
// name, and a still-streaming call may not have either yet.)
function formatGadgetBindingTarget(
  gadget: string | undefined,
  name: string | undefined,
): string | undefined {
  if (!name) return gadget;
  return gadget ? `${gadget}.${name}` : name;
}

// Convert raw tool calls into user-facing transcript labels.
// What a `createGadget` call produced. Read from the gadget's own stamped output rather than
// re-derived from the blueprint, so any blueprint declaring a format counts, not just promoted
// ones. Undefined for a plain gadget, a still-streaming call, or a log predating formats.
type ToolOutputResolver = (tc: AiToolCall) => BlueprintOutput | undefined;

export function resolveToolCallOutput(
  tc: AiToolCall,
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined,
): BlueprintOutput | undefined {
  if (tc.toolName !== "createGadget") return undefined;
  const gadgetId = (tc.output as { gadgetId?: unknown } | undefined)?.gadgetId;
  return typeof gadgetId === "number" ? outputOfWorkpiece(gadgetId) : undefined;
}

function getToolCallSummary(
  tc: AiToolCall,
  outputOf?: ToolOutputResolver,
): { verb: string; target?: string } {
  switch (tc.toolName) {
    case "readFile":
      return { verb: "Read", target: tc.input.filename };
    case "writeFile":
      return { verb: "Wrote", target: tc.input.filename };
    case "editFile":
      return { verb: "Edited", target: tc.input.filename };
    case "describeBinding":
      return { verb: "Inspected", target: `${String(tc.input.name)} binding` };
    case "setBindingHook":
      return {
        verb: "Connected",
        target: tc.input.entrypoint
          ? `${tc.input.bindingName} → ${tc.input.entrypoint}`
          : tc.input.bindingName,
      };
    case "setGadgetBinding":
      return {
        verb: "Wired up",
        target: formatGadgetBindingTarget(tc.input.gadget, tc.input.name ?? tc.input.source),
      };
    // Obsolete predecessor of `setGadgetBinding`; appears only in old chat logs.
    case "saveCapsuleAsBinding":
      return { verb: "Saved resource", target: tc.input.bindingName };
    case "createGadget": {

      const output = outputOf?.(tc);
      return { verb: `Created ${output?.noun ?? "gadget"}`, target: tc.input.title };
    }
    case "executeCode": {
      // Prefer the first non-empty line as a preview. `code` may be absent while the tool call's
      // input is still streaming in, so guard against undefined.
      const firstLine = tc.input.code
        ?.split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0);
      return {
        verb: "Ran code",
        target: firstLine
          ? firstLine.length > 60
            ? `${firstLine.slice(0, 57)}…`
            : firstLine
          : undefined,
      };
    }
    case "giveUp":
      return { verb: "Stopped" };
    case "webFetch": {
      let target = tc.input.url;
      try {
        target = new URL(tc.input.url).host;
      } catch {
        // Leave as the raw URL.
      }
      return { verb: "Fetched", target };
    }
    case "observeUserChanges":
      return { verb: "Observed user changes" };
    case "listBlueprints":
      return { verb: "Listed blueprints" };
    case "listConnectableResources":
      return { verb: "Listed connectable resources", target: tc.input.vendorId };
    case "requestConnection":
      return { verb: "Requested connection", target: tc.input.vendorId };
  }
  // Compile-time exhaustiveness check.
  const _exhaustive: never = tc;
  return { verb: (_exhaustive as { toolName: string }).toolName };
}

type PhosphorIcon = typeof MagnifyingGlass;

type ActionChatMessage = Extract<AiChatMessage, { type: "action" }>;
type ChangeChatMessage = Extract<AiChatMessage, { type: "changes" }>;
type PendingTurnChanges = {
  revertFrom: number;
  through: number;
  // Titles of gadgets created by this turn's pending changes (see `createdGadgets` on the
  // "changes" message body). Reverting the turn deletes them, so discard affordances name them.
  createdGadgetTitles: string[];
};
type ObservationChatMessage = ActionChatMessage & {
  actionLog: NonNullable<ActionChatMessage["actionLog"]> & { type: "observation" };
};

type ToolCallGroup = {
  key: string;
  Icon: PhosphorIcon;
  label: string;
  detailLines: string[];
  calls: AiToolCall[];
  observations: ObservationChatMessage[];
  hasError: boolean;
};

function lowerFirst(text: string): string {
  return text ? text[0].toLowerCase() + text.slice(1) : text;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function formatTimes(count: number): string {
  return pluralize(count, "time");
}

function describeObservationCount(count: number): string {
  return count === 1 ? "Read 1 resource" : `${count} resource reads`;
}

function describeToolCallCount(toolName: AiToolCall["toolName"], count: number): string {
  switch (toolName) {
    case "readFile":
      return `Read ${pluralize(count, "file")}`;
    case "writeFile":
      return `Wrote ${pluralize(count, "file")}`;
    case "editFile":
      return count === 1 ? "Made 1 edit" : `Made ${count} edits`;
    case "webFetch":
      return `Fetched ${pluralize(count, "page")}`;
    case "executeCode":
      return count === 1 ? "Ran code" : `Ran code ${formatTimes(count)}`;
    case "describeBinding":
      return `Inspected ${pluralize(count, "binding")}`;
    case "setBindingHook":
      return `Connected ${pluralize(count, "binding")}`;
    case "setGadgetBinding":
      return `Wired up ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding":
      return `Saved ${pluralize(count, "resource")}`;
    case "createGadget":
      return `Created ${pluralize(count, "gadget")}`;
    case "observeUserChanges":
      return `Observed ${pluralize(count, "change set")}`;
    case "giveUp":
      return count === 1 ? "Stopped" : `Stopped ${count} times`;
    case "listBlueprints":
      return `Listed blueprints`;
    case "listConnectableResources":
      return `Listed connectable resources`;
    case "requestConnection":
      return count === 1 ? "Requested a connection" : `Requested ${count} connections`;
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// `output` names a format when the call is known to be producing one, so the row can use its icon.
function getToolIcon(
  toolName: AiToolCall["toolName"] | null | undefined,
  output?: BlueprintOutput,
): PhosphorIcon {
  if (output) return FORMAT_ICONS[output.icon];
  switch (toolName) {
    case "readFile":
    case "writeFile":
      return FileIcon;
    case "editFile":
      return PencilSimple;
    case "executeCode":
      return Terminal;
    case "webFetch":
      return Globe;
    case "describeBinding":
      return MagnifyingGlass;
    case "setBindingHook":
    case "setGadgetBinding":
    case "saveCapsuleAsBinding":
      return LinkSimple;
    case "createGadget":
      return Plus;
    case "listBlueprints":
      return Blueprint;
    case "observeUserChanges":
      return MagnifyingGlass;
    case "giveUp":
      return Question;
    default:
      return Question;
  }
}

function getProvisionalToolLabel(toolName: AiToolCall["toolName"] | null | undefined) {
  switch (toolName) {
    case "readFile":
      return "Reading file";
    case "writeFile":
      return "Writing file";
    case "editFile":
      return "Editing file";
    case "describeBinding":
      return "Inspecting binding";
    case "setBindingHook":
      return "Connecting binding";
    case "setGadgetBinding":
      return "Wiring up binding";
    case "saveCapsuleAsBinding":
      return "Saving resource";
    case "createGadget":
      return "Creating gadget";
    case "executeCode":
      return "Running code";
    case "webFetch":
      return "Fetching web page";
    case "observeUserChanges":
      return "Observing user changes";
    case "giveUp":
      return "Stopping";
    default:
      return "Using tool";
  }
}

function getToolTarget(tc: AiToolCall): string | undefined {
  return getToolCallSummary(tc).target;
}

// Present-tense verb for an in-progress tool call.
function getProvisionalToolVerb(toolName: AiToolCall["toolName"]): string {
  switch (toolName) {
    case "readFile": return "Reading";
    case "writeFile": return "Writing";
    case "editFile": return "Editing";
    case "describeBinding": return "Inspecting";
    case "setBindingHook": return "Connecting";
    case "setGadgetBinding": return "Wiring up";
    case "saveCapsuleAsBinding": return "Saving";
    case "createGadget": return "Creating gadget";
    case "executeCode": return "Running code";
    case "webFetch": return "Fetching";
    case "observeUserChanges": return "Observing user changes";
    case "giveUp": return "Stopping";
    case "listBlueprints": return "Listing blueprints";
    case "listConnectableResources": return "Listing connectable resources";
    case "requestConnection": return "Requesting a connection";
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// Present-tense, count-aware label mirroring describeToolCallCount (e.g. "Writing 5 files").
function describeProvisionalToolCount(toolName: AiToolCall["toolName"], count: number): string {
  if (count <= 1) return getProvisionalToolLabel(toolName);
  switch (toolName) {
    case "readFile": return `Reading ${pluralize(count, "file")}`;
    case "writeFile": return `Writing ${pluralize(count, "file")}`;
    case "editFile": return `Making ${count} edits`;
    case "webFetch": return `Fetching ${pluralize(count, "page")}`;
    case "executeCode": return count === 1 ? "Running code" : `Running code ${formatTimes(count)}`;
    case "describeBinding": return `Inspecting ${pluralize(count, "binding")}`;
    case "setBindingHook": return `Connecting ${pluralize(count, "binding")}`;
    case "setGadgetBinding": return `Wiring up ${pluralize(count, "binding")}`;
    case "saveCapsuleAsBinding": return `Saving ${pluralize(count, "resource")}`;
    case "createGadget": return `Creating ${pluralize(count, "gadget")}`;
    case "observeUserChanges": return `Observing ${pluralize(count, "change set")}`;
    case "giveUp": return "Stopping";
    case "listBlueprints": return "Listing blueprints";
    case "listConnectableResources": return "Listing connectable resources";
    case "requestConnection": return `Requesting ${pluralize(count, "connection")}`;
  }
  const _exhaustive: never = toolName;
  return _exhaustive;
}

// Builds the label + detail lines for the in-progress tool-call row.
function buildProvisionalToolSummary(
  calls: ProvisionalToolCallState[],
): { label: string; detailLines: string[] } {

  if (calls.length === 1 && calls[0].outputFormat) {
    return { label: `Creating ${calls[0].outputFormat.noun}`, detailLines: [] };
  }
  const toolNames = Array.from(
    new Set(calls.map((c) => c.toolName).filter((n): n is AiToolCall["toolName"] => !!n)),
  );
  const detailLines = Array.from(
    new Set(calls.map((c) => c.target).filter((t): t is string => Boolean(t))),
  );

  if (toolNames.length === 0) {
    return { label: "Using tool", detailLines: [] };
  }

  if (toolNames.length > 1) {
    const parts = toolNames.map((toolName) =>
      describeProvisionalToolCount(
        toolName,
        calls.filter((c) => c.toolName === toolName).length,
      ),
    );
    return {
      label: parts.map((part, i) => (i === 0 ? part : lowerFirst(part))).join(", "),
      detailLines,
    };
  }

  const toolName = toolNames[0];
  if (calls.length === 1) {
    const target = detailLines[0];
    return {
      label: target ? `${getProvisionalToolVerb(toolName)} ${target}` : getProvisionalToolLabel(toolName),
      detailLines: [],
    };
  }

  const label =
    detailLines.length === 1
      ? `${getProvisionalToolVerb(toolName)} ${detailLines[0]}`
      : describeProvisionalToolCount(toolName, calls.length);
  return { label, detailLines };
}

function buildToolCallGroups(
  toolCalls: AiToolCall[],
  observations: ObservationChatMessage[] = [],
  outputOf?: ToolOutputResolver,
): ToolCallGroup[] {
  if (toolCalls.length === 0 && observations.length === 0) return [];

  const distinctToolNames = Array.from(new Set(toolCalls.map((tc) => tc.toolName)));
  const targets = toolCalls
    .map((tc) => getToolTarget(tc))
    .filter((target): target is string => Boolean(target));
  const observationTargets = observations
    .map((msg) => msg.actionLog.resourceTitle)
    .filter((target): target is string => Boolean(target));
  const detailLines = Array.from(new Set([...targets, ...observationTargets]));
  const labelParts: string[] = [];

  if (toolCalls.length === 1) {
    const summary = getToolCallSummary(toolCalls[0], outputOf);
    labelParts.push(`${summary.verb}${summary.target ? ` ${summary.target}` : ""}`);
  } else if (toolCalls.length > 1 && distinctToolNames.length === 1) {
    const summary = getToolCallSummary(toolCalls[0], outputOf);
    labelParts.push(detailLines.length === 1 && summary.target && observations.length === 0
      ? `${summary.verb} ${summary.target}`
      : describeToolCallCount(toolCalls[0].toolName, toolCalls.length));
  } else if (toolCalls.length > 1 && distinctToolNames.length <= 3) {
    labelParts.push(...distinctToolNames.map((toolName) => {
      const count = toolCalls.filter((tc) => tc.toolName === toolName).length;
      return describeToolCallCount(toolName, count);
    }));
  } else if (toolCalls.length > 0) {
    labelParts.push(`${toolCalls.length} tool calls`);
  }

  if (observations.length > 0) {
    labelParts.push(describeObservationCount(observations.length));
  }

  const firstToolCall = toolCalls[0];
  const firstObservation = observations[0];

  return [{
    // Use the first work item id so expansion survives streaming → committed.
    key: firstToolCall
      ? `group-${firstToolCall.toolCallId}`
      : `group-observation-${firstObservation.chatId}-${firstObservation.sequence}`,
    Icon: firstToolCall
      ? getToolIcon(firstToolCall.toolName, outputOf?.(firstToolCall))
      : MagnifyingGlass,
    label: labelParts
      .map((part, index) => index === 0 ? part : lowerFirst(part))
      .join(", "),
    detailLines,
    calls: toolCalls,
    observations,
    hasError: toolCalls.some((tc) => Boolean(tc.error)),
  }];
}

function WorkIcon({ Icon }: { Icon: PhosphorIcon }) {
  return <Icon size={15} className="text-kumo-inactive" />;
}

// Splices inline nodes into plain text at recorded positions, so a slash command and a format each
// only have to know where they sit.
//
// The plain-text counterpart to the markdown path's token substitution (see
// buildTokenizedCapsuleMessage): markdown needs tokens because it reflows the text it is given,
// while text rendered as typed can be cut at the offsets directly.
function TextWithMentions(
  { text, mentions }: {
    text: string;
    // `length` 0 inserts between characters, for something that was removed from the text.
    mentions: { key: string; position: number; length: number; node: ReactNode }[];
  },
) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const mention of [...mentions].toSorted((a, b) => a.position - b.position)) {
    // Anything that would rewind the cursor is skipped: overlapping spans have no meaning, and
    // stored messages predate the validation that now refuses them.
    if (mention.position < cursor || mention.position > text.length) continue;
    if (mention.position > cursor) parts.push(text.slice(cursor, mention.position));
    parts.push(<Fragment key={mention.key}>{mention.node}</Fragment>);
    cursor = mention.position + mention.length;
  }
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <>{parts}</>;
}

// Renders a user message that invoked a slash command: their words, with the command shown back
// where they typed it and any formats they named as chips. What the command expanded into is the
// agent's context, and isn't shown.
function SlashCommandMention(
  { name, args, id, commandPosition, formats, getOverseer }: {
    name?: string;
    args: string;
    id: SlashCommandId;
    commandPosition?: number;
    formats?: MessageFormatRef[];
    getOverseer: OverseerSource;
  },
) {
  const choice = useSlashCommandChoice(getOverseer, name ? id : undefined);
  const mention = name ? <span className="text-kumo-brand">/{name}</span> : null;
  const command = choice
    ? (
      <Tooltip
        content={
          <span className="block max-w-xs">
            {/* No `block` here: it would outrank the `-webkit-box` that line-clamp needs.
                An explicit leading is required: the clamp reserves a whole number of lines at
                the *inherited* line height, so without one the reserved box and the rendered
                lines disagree and the last line is sliced through the middle. Two lines rather
                than three keeps the whole tooltip inside its own height budget. */}
            <span className="line-clamp-2 leading-[18px]">{choice.description}</span>
            {/* Provider, then whatever identifies the command within it: for a skill that is
                its collection and path. Same line the picker shows. */}
            <span className="mt-0.5 block truncate text-kumo-subtle">
              {[choice.providerLabel, choice.resourceLabel].filter(Boolean).join(" · ")}
            </span>
          </span>
        }
        asChild
      >
        {mention}
      </Tooltip>
    )
    : mention;

  if (!name) return <>{args}</>;

  // The command was cut out of `args`, taking one adjoining space with it, so put a space back on
  // whichever side now runs into a word.
  const at = Math.min(commandPosition ?? 0, args.length);
  const spaceBefore = at > 0 && !/\s$/.test(args.slice(0, at));
  const spaceAfter = at < args.length && !/^\s/.test(args.slice(at));

  return (
    <TextWithMentions
      text={args}
      mentions={[
        {
          key: "command",
          position: at,
          length: 0,
          node: <>{spaceBefore ? " " : ""}{command}{spaceAfter ? " " : ""}</>,
        },
        ...(formats ?? []).map((format, i) => ({
          key: `format-${i}`,
          position: format.position,
          length: format.length,
          node: <FormatMention format={format} />,
        })),
      ]}
    />
  );
}

function CapsuleMention({ capsule }: { capsule: CapsuleSpecifier }) {
  const { authenticatedApi } = useAuthenticatedApi();
  const vendorBranding = useVendorBranding(authenticatedApi);
  const logo = capsule.vendorId ? vendorBranding.get(capsule.vendorId)?.logoUrl : undefined;
  const safeUrl = safeExternalUrl(capsule.description.url);
  const body = (
    <>
      {logo && <img src={logo} alt="" className={styles.capsuleMentionLogo} />}
      {capsule.description.title}
    </>
  );
  return safeUrl ? (
    <a
      href={safeUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={styles.capsuleMention}
    >
      {body}
    </a>
  ) : (
    <span className={styles.capsuleMention}>{body}</span>
  );
}

// A format the message named, drawn the way the composer drew it. Shares the capsule's chip
// styling so a message reads the same as the draft it came from. Not a link: a format names
// nothing the user can open.
function FormatMention({ format }: { format: MessageFormatRef }) {
  const Icon = FORMAT_ICONS[format.icon];
  return (
    <span className={styles.capsuleMention}>
      <Icon size={13} className={styles.formatMentionIcon} />
      {format.noun}
    </span>
  );
}

function getMarkdownComponents(
  mentionsByToken?: Map<string, Mention>,
): Components {
  return {
    table: ({ node: _node, children, ...props }) => (
      <div className={styles.markdownTableWrapper}>
        <table {...props}>{children}</table>
      </div>
    ),
    a: ({ node: _node, href, children, ...props }) => {
      if (href?.startsWith(CAPSULE_LINK_PREFIX) && mentionsByToken) {
        const token = decodeURIComponent(href.slice(CAPSULE_LINK_PREFIX.length));
        const mention = mentionsByToken.get(token);
        if (mention) {
          return mention.kind === "capsule"
              ? <CapsuleMention capsule={mention.capsule} />
              : <FormatMention format={mention.format} />;
        }
      }

      const safeHref = safeExternalUrl(href);
      if (!safeHref) {
        return <>{children}</>;
      }

      return (
        <a
          {...props}
          href={safeHref}
          target="_blank"
          rel="noopener noreferrer"
        >
          {children}
        </a>
      );
    },
  };
}

const REMARK_PLUGINS_NO_CAPSULES = [remarkGfm];
const MARKDOWN_COMPONENTS_NO_CAPSULES = getMarkdownComponents();

// Exported for unit testing (see ChatInterface.markdown.test.tsx), which verifies that a
// single newline in a user message survives to the DOM as a literal "\n" so the
// `whitespace-pre-wrap` wrapper at the user-message render site renders it as a hard break.
export const MarkdownMessage = memo(function MarkdownMessage(
  { message, capsules, formats }: {
    message: string;
    capsules?: CapsuleSpecifier[];
    formats?: MessageFormatRef[];
  },
): ReactNode {
  const tokenizedMessage = useMemo(
    () => capsules?.length || formats?.length
      ? buildTokenizedCapsuleMessage(message, capsules, formats)
      : null,
    [capsules, formats, message],
  );
  const components = useMemo(
    () => tokenizedMessage
      ? getMarkdownComponents(tokenizedMessage.mentionsByToken)
      : MARKDOWN_COMPONENTS_NO_CAPSULES,
    [tokenizedMessage],
  );
  const remarkPlugins = useMemo(
    () => tokenizedMessage
      ? [remarkGfm, createCapsuleRemarkPlugin(tokenizedMessage.mentionsByToken)]
      : REMARK_PLUGINS_NO_CAPSULES,
    [tokenizedMessage],
  );

  return (
    <ReactMarkdown
      skipHtml={true}
      remarkPlugins={remarkPlugins}
      components={components}
    >
      {tokenizedMessage?.markdown ?? message}
    </ReactMarkdown>
  );
});

function formatAttachmentSize(size: number | undefined): string | null {
  if (size === undefined) return null;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// Build a temporary object URL for inlined attachment bytes, revoking it when no longer needed.
function useAttachmentObjectUrl(content: Uint8Array | undefined, mimeType: string): string | null {
  const [objectUrl, setObjectUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!content) {
      setObjectUrl(null);
      return;
    }

    const url = URL.createObjectURL(
      new Blob([content as BlobPart], {type: mimeType || "application/octet-stream"}));
    setObjectUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [content, mimeType]);
  return objectUrl;
}

type AttachmentDownloadHandler = (attachment: ChatAttachmentRef) => void;

type AttachmentPreviewModalProps = {
  attachment: ChatAttachmentRef | null;
  onClose: () => void;
  onDownload?: AttachmentDownloadHandler;
};

const AttachmentPreviewModal = memo(function AttachmentPreviewModal(
  {
    attachment,
    onClose,
    onDownload,
  }: AttachmentPreviewModalProps,
) {
  const containerRef = useRef<HTMLDivElement>(null);
  const isImage = (attachment?.mimeType ?? "").startsWith("image/");
  const objectUrl = useAttachmentObjectUrl(
    isImage ? attachment?.content : undefined, attachment?.mimeType ?? "");

  // Dialog keyboard handling: Escape closes, Tab stays trapped, focus restores on close.
  useEffect(() => {
    if (!attachment) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key === "Tab" && containerRef.current) {
        const focusable = containerRef.current.querySelectorAll<HTMLElement>(
          'button, [href], iframe, [tabindex]:not([tabindex="-1"])');
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    // Defer to after paint so the close button exists.
    const raf = requestAnimationFrame(() => {
      containerRef.current?.querySelector<HTMLElement>("button")?.focus();
    });
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      cancelAnimationFrame(raf);
      previouslyFocused?.focus?.();
    };
  }, [attachment, onClose]);

  if (!attachment) return null;

  const sizeLabel = formatAttachmentSize(attachment.size);
  const title = attachment.name ?? "Attached file";
  const modalWidthClass = isImage
    ? "w-[min(1120px,calc(100vw-32px))]"
    : "w-[min(520px,calc(100vw-32px))]";
  const modalSurfaceClass = "rounded-2xl border border-kumo-line/70 bg-kumo-base";
  const modalPaddingClass = "p-3 sm:p-4";

  return (
    <div
      className="fixed inset-0 z-[2000] flex items-center justify-center bg-black/45 p-4 backdrop-blur-[1px]"
      role="dialog"
      aria-modal="true"
      aria-label={`Preview ${title}`}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={containerRef} className={`relative max-h-[calc(100vh-32px)] ${modalWidthClass} overflow-hidden ${modalSurfaceClass} p-0 shadow-[0_24px_80px_rgba(0,0,0,0.28)]`}>
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3 z-10 flex h-8 w-8 cursor-pointer items-center justify-center rounded-full border border-kumo-line bg-kumo-base/90 text-kumo-subtle shadow-[0_1px_2px_rgba(0,0,0,0.05)] backdrop-blur-sm transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-base hover:text-kumo-default active:scale-[0.96]"
          aria-label="Close preview"
        >
          <X size={18} />
        </button>

        <div className={modalPaddingClass}>
          {isImage && objectUrl ? (
            <img
              src={objectUrl}
              alt={title}
              className="max-h-[calc(100vh-96px)] w-full rounded-xl object-contain"
            />
          ) : (
            <div className="grid min-h-56 place-items-center rounded-xl border border-kumo-line/70 bg-kumo-elevated/40 p-6 py-10 text-center">
              <div className="max-w-sm space-y-2">
                <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-kumo-line/70 bg-kumo-base text-kumo-inactive">
                  <FileIcon size={26} />
                </div>
                <div className="text-[14px] font-medium text-kumo-default">{title}</div>
                <div className="text-[12px] leading-5 text-kumo-subtle">
                  {attachment.mimeType || "Unknown file type"}{sizeLabel ? ` · ${sizeLabel}` : ""}
                </div>
                <div className="text-[12px] leading-5 text-kumo-inactive">This file can’t be previewed here.</div>
                {onDownload && (
                  <button
                    type="button"
                    onClick={() => onDownload(attachment)}
                    className="mt-1 inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-kumo-line/70 bg-kumo-base px-3 py-1.5 text-[12px] font-medium text-kumo-default transition-colors hover:bg-kumo-tint/40"
                  >
                    Download
                  </button>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
});

type ChatAttachmentThumbnailProps = {
  attachment: ChatAttachmentRef;
  onPreview: (id: string) => void;
};

const ChatAttachmentThumbnail = memo(function ChatAttachmentThumbnail(
  {
    attachment,
    onPreview,
  }: ChatAttachmentThumbnailProps,
) {
  const isImage = attachment.mimeType.startsWith("image/");
  const objectUrl = useAttachmentObjectUrl(isImage ? attachment.content : undefined, attachment.mimeType);
  const [imageState, setImageState] = useState<"loading" | "loaded" | "error">("loading");

  return (
    <button
      type="button"
      onClick={() => onPreview(attachment.id)}
      className="relative h-28 w-36 shrink-0 cursor-pointer overflow-hidden rounded-xl border border-kumo-line/70 bg-kumo-elevated text-left transition-[border-color,background-color,transform] duration-150 ease-out hover:border-kumo-line hover:bg-kumo-tint/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-brand/40 active:scale-[0.98]"
      aria-label={`Preview ${attachment.name ?? "attached file"}`}
    >
      {isImage && objectUrl && imageState !== "error" ? (
        <>
          {/* Kept in layout (not display:none) so lazy-loading actually triggers. */}
          <img
            src={objectUrl}
            alt={attachment.name ?? "Attached image"}
            loading="lazy"
            className="block h-full w-full object-cover"
            onLoad={() => setImageState("loaded")}
            onError={() => setImageState("error")}
          />
          {imageState !== "loaded" && (
            <div className="absolute inset-0 grid place-items-center bg-kumo-elevated text-[11px] text-kumo-inactive">Loading image…</div>
          )}
        </>
      ) : (
        <div className="flex h-full w-full min-w-0 items-center justify-center gap-2 p-3 text-[12px] leading-4 text-kumo-subtle">
          <FileIcon size={20} className="shrink-0 text-kumo-inactive" />
          <span className="min-w-0 truncate">{attachment.name ?? "Attached file"}</span>
        </div>
      )}
    </button>
  );
});

type ChatAttachmentGridProps = {
  attachments: ChatAttachmentRef[];
  onDownload?: AttachmentDownloadHandler;
};

const ChatAttachmentGrid = memo(function ChatAttachmentGrid(
  {
    attachments,
    onDownload,
  }: ChatAttachmentGridProps,
) {
  const [previewAttachmentId, setPreviewAttachmentId] = useState<string | null>(null);
  const previewAttachment = previewAttachmentId === null
    ? null
    : attachments.find((attachment) => attachment.id === previewAttachmentId) ?? null;
  const handlePreview = useCallback((id: string) => setPreviewAttachmentId(id), []);
  const handleClose = useCallback(() => setPreviewAttachmentId(null), []);

  return (
    <>
      <div className="mb-2 flex flex-wrap gap-2">
        {attachments.map((attachment) => (
          <ChatAttachmentThumbnail
            key={attachment.id}
            attachment={attachment}
            onPreview={handlePreview}
          />
        ))}
      </div>
      <AttachmentPreviewModal
        attachment={previewAttachment}
        onClose={handleClose}
        onDownload={onDownload}
      />
    </>
  );
});

const ToolCallDetails = memo(function ToolCallDetails(
  { toolCall: tc }: { toolCall: AiToolCall },
) {
  return (
    <div className="space-y-2">
      {tc.error && (
        <pre className="rounded-xl border border-kumo-danger/20 bg-kumo-danger-tint/40 p-3 font-mono text-[12px] leading-[18px] text-kumo-danger whitespace-pre-wrap">
          {tc.error}
        </pre>
      )}
      {tc.toolName === "executeCode" ? (
        <>
          <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
            Code
          </span>
          <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
            {tc.input.code}
          </pre>
          {tc.output && (
            <>
              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">
                Output
              </span>
              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                {tc.output}
              </pre>
            </>
          )}
        </>
      ) : (
        <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
          {JSON.stringify(tc.input, null, 2)}
        </pre>
      )}
    </div>
  );
});

const ObservationDetails = memo(function ObservationDetails(
  { observation }: { observation: ObservationChatMessage },
) {
  const log = observation.actionLog;
  const safeResourceUrl = safeExternalUrl(log.resourceUrl);
  const metadata = log.resourceTitle;

  return (
    <div className="px-1 py-1.5 text-[13px] leading-[19px] tracking-[-0.25px]">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="m-0 font-medium text-kumo-default">
            {log.description.title}
          </p>
          {metadata && (
            <p className="mt-0.5 mb-0 truncate text-[12px] leading-4 text-kumo-inactive">
              {safeResourceUrl && log.resourceTitle ? (
                <a
                  href={safeResourceUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="hover:underline"
                >
                  {metadata}
                </a>
              ) : metadata}
            </p>
          )}
          <div className="mt-1.5 text-[12px] leading-[18px] tracking-[-0.2px] text-kumo-subtle">
            <MarkdownMessage message={log.description.description} />
          </div>
        </div>
      </div>
    </div>
  );
});

const NestedToolCallRow = memo(function NestedToolCallRow({
  toolCall: tc,
  open,
  onToggle,
  outputOf,
}: {
  toolCall: AiToolCall;
  open: boolean;
  onToggle: (key: string) => void;
  outputOf?: ToolOutputResolver;
}) {
  const key = `call-${tc.toolCallId}`;
  const summary = getToolCallSummary(tc, outputOf);
  const label = `${summary.verb}${summary.target ? ` ${summary.target}` : ""}`;
  const Icon = getToolIcon(tc.toolName, outputOf?.(tc));

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={Icon} />
        </span>
        <span className="flex min-w-0 flex-1 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          {tc.error && (
            <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
              Error
            </span>
          )}
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ToolCallDetails toolCall={tc} />
        </div>
      )}
    </div>
  );
});

const NestedObservationRow = memo(function NestedObservationRow({
  observation,
  open,
  onToggle,
}: {
  observation: ObservationChatMessage;
  open: boolean;
  onToggle: (key: string) => void;
}) {
  const key = `observation-${observation.chatId}-${observation.sequence}`;
  const log = observation.actionLog;
  const label = `Read ${log.description.title || log.resourceTitle || "resource"}`;

  return (
    <div className="group/nested">
      <button
        type="button"
        onClick={() => onToggle(key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={MagnifyingGlass} />
        </span>
        <span className="inline-flex min-w-0 max-w-full items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
          <span className="min-w-0 truncate">{label}</span>
          <CaretRight
            size={13}
            weight="bold"
            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
          />
        </span>
      </button>
      {open && (
        <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
          <ObservationDetails observation={observation} />
        </div>
      )}
    </div>
  );
});

const ThinkingTraceRow = memo(function ThinkingTraceRow({
  reasoning,
}: {
  reasoning: string;
}) {
  return (
    <div className="min-w-0 py-1 text-kumo-subtle">
      <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
        <MarkdownMessage message={reasoning} />
      </div>
    </div>
  );
});

const ToolGroupRow = memo(function ToolGroupRow({
  group,
  open,
  expandedKeys,
  onToggle,
  footerChangeSequence,
  footerTimestamp,
  footerIsTrailing,
  footerCreatedGadgetTitles,
  footerDisabled = false,
  onFooterRevert,
  outputOf,
}: {
  group: ToolCallGroup;
  open: boolean;
  expandedKeys: ReadonlySet<string>;
  onToggle: (key: string) => void;
  footerChangeSequence?: number;
  footerTimestamp?: Date;
  footerIsTrailing?: boolean;
  footerCreatedGadgetTitles?: string[];
  footerDisabled?: boolean;
  onFooterRevert?: (sequence: number) => void;
  outputOf?: ToolOutputResolver;
}) {
  const footerLabel = footerChangeSequence !== undefined
    ? getDiscardLabel(footerIsTrailing, footerCreatedGadgetTitles)
    : null;
  return (
    <div className="group -ml-0.5">
      <button
        type="button"
        onClick={() => onToggle(group.key)}
        className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
        aria-expanded={open}
      >
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
          <WorkIcon Icon={group.Icon} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
            <span className="min-w-0 truncate">{group.label}</span>
            {group.hasError && (
              <span className="flex-shrink-0 rounded-full bg-kumo-danger-tint px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.04em] text-kumo-danger">
                Error
              </span>
            )}
            <CaretRight
              size={13}
              weight="bold"
              className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
            />
          </span>
          {group.detailLines.length > 1 && (
            <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
              {group.detailLines.join(" · ")}
            </span>
          )}
        </span>
      </button>
      {open && (
        group.calls.length === 1 && group.observations.length === 0 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ToolCallDetails toolCall={group.calls[0]} />
          </div>
        ) : group.calls.length === 0 && group.observations.length === 1 ? (
          <div className="themed-surface-inset ml-8 mt-1 space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3">
            <ObservationDetails observation={group.observations[0]} />
          </div>
        ) : (
          <div className="ml-8 mt-1 space-y-1">
            {group.calls.map((toolCall) => {
              const key = `call-${toolCall.toolCallId}`;
              return (
                <NestedToolCallRow
                  key={toolCall.toolCallId}
                  toolCall={toolCall}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                  outputOf={outputOf}
                />
              );
            })}
            {group.observations.map((observation) => {
              const key = `observation-${observation.chatId}-${observation.sequence}`;
              return (
                <NestedObservationRow
                  key={key}
                  observation={observation}
                  open={expandedKeys.has(key)}
                  onToggle={onToggle}
                />
              );
            })}
          </div>
        )
      )}
      {footerChangeSequence !== undefined && footerTimestamp && footerLabel && onFooterRevert && (
        <div className="ml-0 mt-0.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover:opacity-100 group-focus-within:opacity-100">
          <Tooltip content={footerLabel} asChild>
            <button
              type="button"
              disabled={footerDisabled}
              onClick={() => onFooterRevert(footerChangeSequence)}
              className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
              aria-label={footerLabel}
            >
              <ArrowUUpLeft size={15} />
            </button>
          </Tooltip>
          <Tooltip content={formatFullTimestamp(footerTimestamp)} asChild>
            <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
              {footerTimestamp.toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          </Tooltip>
        </div>
      )}
    </div>
  );
});

export const ChatInput = ({
  createCapsuleGatekeeper,
  getOverseer,
  onSend,
  isAgentActive,
  models,
  selectedModel,
  onModelChange,
  pendingConsoleLogCount = 0,
  consoleLogPreview = "",
  consoleLogSeverity = "info",
  onConsumeConsoleLogs = () => "",
  onDiscardConsoleLogs = () => {},
  newChat = false,
  offerFormats = false,
  autoFocus = false,
  minRows = 2,
  seedText,
  seedNonce,
  attachLabel,
  draftUpdateBanner,
  blockedReason,
  chatKey,
  onStop,
  showThinkingTraces = true,
  onToggleThinkingTraces,
}: {
  createCapsuleGatekeeper: (
    accountId: number,
    url: string,
  ) => Promise<RpcStub<GatekeeperClient<any>> | null>;
  // Returns an overseer stub, used by the attach modal to create gatekeepers. Can be async
  // to support lazy provisional-gadget creation on the Home page.
  getOverseer: () => Promise<RpcStub<Overseer>> | RpcStub<Overseer>;
  onSend: (
    message: string | SlashCommandRequest,
    modelId: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
  ) => Promise<void> | void;
  isAgentActive: boolean;
  models: AiChatAuthorInfo[];
  selectedModel: string | null;
  onModelChange: (modelId: string | null) => void;
  pendingConsoleLogCount?: number;
  consoleLogPreview?: string;
  consoleLogSeverity?: "error" | "warn" | "info";
  onConsumeConsoleLogs?: () => string;
  onDiscardConsoleLogs?: () => void;
  newChat?: boolean;
  // Whether the composer offers the deployment's standard formats. A chosen format rides along as
  // an instruction on the message; it does not change which workspace is created. Only meaningful
  // with `newChat`, since a format names something to build rather than something to say.
  offerFormats?: boolean;
  autoFocus?: boolean;
  /** Minimum number of textarea rows at rest. Defaults to 2. */
  minRows?: number;
  /** Optional starter text to drop into the composer (e.g. a Home task suggestion). Applied
   * whenever `seedNonce` changes, so the same text can be re-seeded by bumping the nonce. */
  seedText?: string;
  seedNonce?: number;
  /** Optional label for the attach menu item. */
  attachLabel?: string;
  draftUpdateBanner?: ReactNode;
  /** When set, the composer is disabled and shows this message — the user must resolve something
   * (e.g. accept/deny a pending connection request) before they can type or send. */
  blockedReason?: string;
  /** Identity of the chat the composer is bound to; a change clears chat-scoped hints. */
  chatKey?: number | null;
  onStop?: () => void;
  showThinkingTraces?: boolean;
  onToggleThinkingTraces?: () => void;
  /** Show the "Pre-approve actions" menu item (only when there are uncovered candidates). */
  /** Open the pre-approval dialog (owned by the parent). */
  /** Called after a gatekeeper is connected via the attach flow, so the parent can refresh the
   * pre-approval catalog and proactively offer to pre-approve its actions. */
}) => {
  const toasts = useKumoToastManager();
  const [inputValue, setInputValue] = useState("");
  const [capsules, setCapsules] = useState<InputCapsule[]>([]);
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  // The chat the "may not have been sent" hint belongs to; the render condition scopes it, and
  // leaving the chat dismisses it.
  const [sendHiccup, setSendHiccup] = useState<{ chatKey?: number | null } | null>(null);
  useEffect(() => setSendHiccup(null), [chatKey]);
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const [selectedSlashCommand, setSelectedSlashCommand] = useState<SelectedSlashCommand | null>(null);
  // The caret the slash command picker parses at. Deliberately updated only when it moves to a
  // different command token (see `syncPickerCaret`): the mirror owns the caret the user sees,
  // so ordinary caret movement doesn't have to re-render the composer.
  const [cursorPosition, setCursorPosition] = useState(0);
  const pickerCaretRef = useRef<{key: string | null; text: string}>({key: null, text: ""});
  // Caret position and text the URL overlay was last resolved for, to skip repeated scans.
  const lastUrlScanRef = useRef({position: -1, text: ""});
  const { authenticatedApi } = useAuthenticatedApi();
  const vendorBranding = useVendorBranding(authenticatedApi);
  const selectedSlashCommandRef = useRef(selectedSlashCommand);
  selectedSlashCommandRef.current = selectedSlashCommand;
  const sendInFlightRef = useRef(false);
  const pendingAttachmentsRef = useRef<PendingAttachment[]>([]);
  pendingAttachmentsRef.current = pendingAttachments;
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const attachmentDragDepthRef = useRef(0);
  const mountedRef = useRef(true);
  const [activeUrl, setActiveUrl] = useState<{
    text: string;
    start: number;
    end: number;
  } | null>(null);
  const [overlayIndex, setOverlayIndex] = useState(0);
  const overlayItemsRef = useRef<SelectableItem[]>([]);
  const overlayActivateRef = useRef<((index: number) => void) | null>(null);
  // Once the user moves the overlay's selection, the default stops applying.
  const overlayNavigatedRef = useRef(false);
  const [urlLineOffset, setUrlLineOffset] = useState<number | undefined>(undefined);
  const navigateOverlay: Dispatch<SetStateAction<number>> = (index) => {
    overlayNavigatedRef.current = true;
    setOverlayIndex(index);
  };
  // Accounts arrive from a subscription, so they can land after the panel first renders.
  const handleOverlayItems = useCallback((items: SelectableItem[]) => {
    overlayItemsRef.current = items;
    if (!overlayNavigatedRef.current) setOverlayIndex(firstAccountIndex(items));
  }, []);

  // Attach modal state
  const [attachModalOpen, setAttachModalOpen] = useState(false);
  // Save the cursor position when the attach modal opens, so we can insert the capsule there.
  const attachCursorPosRef = useRef(0);

  // Refs for the mirror div and the textarea wrapper.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<ComposerMirrorHandle>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep inputValue in a ref so handleCursorChange can read it without re-binding.
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;

  // Seed the composer from an external suggestion (Home task cards). Re-runs whenever the nonce
  // changes so picking the same suggestion twice still works. Focus + move the cursor to the end.
  useEffect(() => {
    if (seedNonce === undefined) return;
    const text = seedText ?? "";
    setSelectedSlashCommand(null);
    setInputValue(text);
    requestAnimationFrame(() => {
      const ta = composerTextareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      autoResizeTextarea(ta, minRows, newChat ? 10 : 4);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);
  const capsulesRef = useRef(capsules);
  capsulesRef.current = capsules;
  // Sync mirror div size with the textarea via ResizeObserver.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const textarea = wrapper.querySelector("textarea");
    if (!textarea) return;

    const syncMirror = () => {
      const mirror = mirrorRef.current?.node;
      if (!mirror) return;

      // Copy computed styles from the textarea to the mirror so text layout matches exactly.
      const cs = getComputedStyle(textarea);
      mirror.style.fontFamily = cs.fontFamily;
      mirror.style.fontSize = cs.fontSize;
      mirror.style.fontWeight = cs.fontWeight;
      mirror.style.lineHeight = cs.lineHeight;
      mirror.style.letterSpacing = cs.letterSpacing;
      mirror.style.padding = cs.padding;
      mirror.style.border = `${cs.borderWidth} solid transparent`;
      // Client box, not offset box: once the textarea scrolls, its scrollbar narrows the width
      // that text wraps at, and the mirror has to wrap at exactly the same width.
      mirror.style.height = `${textarea.clientHeight}px`;
      mirror.style.width = `${textarea.clientWidth}px`;
      mirror.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
    };

    // Initial sync.
    syncMirror();

    const observer = new ResizeObserver(syncMirror);
    observer.observe(textarea);

    return () => observer.disconnect();
  }, []);

  const syncMirrorScroll = (textarea: HTMLTextAreaElement) => {
    const mirror = mirrorRef.current?.node;
    if (!mirror) return;
    mirror.style.transform = `translate(${-textarea.scrollLeft}px, ${-textarea.scrollTop}px)`;
  };

  // Reset overlay selection when the overlay appears or changes URL, preferring a connected account
  // so Tab never reaches for "Connect new account" first.
  useEffect(() => {
    setOverlayIndex(firstAccountIndex(overlayItemsRef.current));
    overlayNavigatedRef.current = false;
  }, [activeUrl]);

  // Measure the line the URL starts on, so the panel sits with that line rather than above a
  // composer the URL may have wrapped over several lines. The mirror's geometry is the textarea's.
  useLayoutEffect(() => {
    const mirror = mirrorRef.current?.node;
    const wrapper = wrapperRef.current;
    if (!activeUrl || !mirror || !wrapper) {
      setUrlLineOffset(undefined);
      return;
    }
    const walker = document.createTreeWalker(mirror, NodeFilter.SHOW_TEXT);
    let consumed = 0;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const length = node.textContent?.length ?? 0;
      if (consumed + length <= activeUrl.start) {
        consumed += length;
        continue;
      }
      const offset = activeUrl.start - consumed;
      const range = document.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(offset + 1, length));
      const line = range.getBoundingClientRect();
      const box = wrapper.getBoundingClientRect();
      // Never below the composer's own bottom edge, in case the line is scrolled out of view.
      setUrlLineOffset(Math.max(
          CAPSULE_OVERLAY_GAP, box.bottom - line.top + CAPSULE_OVERLAY_GAP));
      return;
    }
    setUrlLineOffset(undefined);
  }, [activeUrl, inputValue]);

  const isBlocked = !!blockedReason;

  // A disabled textarea stops firing mouse events, so drop the hover state the token hit-testing
  // below leaves behind; otherwise the cursor outlives `disabled:cursor-not-allowed`.
  useEffect(() => {
    if (!isBlocked) return;
    mirrorRef.current?.setHoveredToken(null);
    if (composerTextareaRef.current) composerTextareaRef.current.style.cursor = "";
  }, [isBlocked]);

  const deleteStagedAttachment = (ref: ChatAttachmentHandle) => {
    void (async () => {
      try {
        const overseer = await getOverseer();
        await overseer.deleteChatAttachment(ref.id);
      } catch {
        // Best-effort cleanup; the parent may have already disposed the Overseer while unmounting.
      }
    })();
  };

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attachments = pendingAttachmentsRef.current;
      pendingAttachmentsRef.current = [];
      for (const attachment of attachments) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      for (const attachment of attachments) {
        if (attachment.ref) deleteStagedAttachment(attachment.ref);
      }
    };
  }, []);

  const uploadPendingAttachment = async (id: string, blob: Blob, mimeType: string, name?: string) => {
    try {
      const content = new Uint8Array(await blob.arrayBuffer());
      if (!mountedRef.current || !pendingAttachmentsRef.current.some((attachment) => attachment.id === id)) return;
      const overseer = await getOverseer();
      if (!mountedRef.current || !pendingAttachmentsRef.current.some((attachment) => attachment.id === id)) return;
      const ref = await overseer.uploadChatAttachment({
        mimeType,
        content,
        name,
      }, selectedModel);
      if (!mountedRef.current || !pendingAttachmentsRef.current.some((attachment) => attachment.id === id)) {
        deleteStagedAttachment(ref);
        return;
      }
      setPendingAttachments((prev) => prev.map((attachment) => attachment.id === id ? { ...attachment, uploadState: "ready", ref } : attachment));
    } catch (err: any) {
      console.error("Failed to upload chat attachment:", err);
      if (!mountedRef.current) return;
      reportIssue('chat.attachment-upload', err)
      setPendingAttachments((prev) => prev.map((attachment) => attachment.id === id ? {
        ...attachment,
        uploadState: "error",
        error: err?.message || "Upload failed",
      } : attachment));
      toasts.add({ title: err?.message || "Failed to upload attachment", variant: "error" });
    }
  };

  const addFiles = async (files: FileList | File[]) => {
    const attachmentFiles = Array.from(files);

    const initialRoom = MAX_PENDING_ATTACHMENTS - pendingAttachmentsRef.current.length;
    if (initialRoom <= 0) {
      toasts.add({ title: `You can attach up to ${MAX_PENDING_ATTACHMENTS} attachments`, variant: "error" });
      return;
    }
    const accepted = attachmentFiles.slice(0, initialRoom);
    if (attachmentFiles.length > initialRoom) {
      const title = initialRoom === 1
        ? "Only the first attachment was attached"
        : `Only the first ${initialRoom} attachments were attached`;
      toasts.add({ title, variant: "error" });
    }

    const prepared = await Promise.allSettled(accepted.map(async (file) => ({
      file,
      ...(await prepareChatAttachment(file)),
    })));
    if (!mountedRef.current) return;

    for (const result of prepared) {
      if (result.status === "rejected") {
        console.error("Failed to process chat attachment:", result.reason);
        toasts.add({ title: result.reason?.message || "Failed to process attachment", variant: "error" });
        continue;
      }

      const { file, blob, mimeType } = result.value;
      if (pendingAttachmentsRef.current.length >= MAX_PENDING_ATTACHMENTS) {
        toasts.add({ title: `You can attach up to ${MAX_PENDING_ATTACHMENTS} attachments`, variant: "error" });
        continue;
      }
      const totalPendingBytes = pendingAttachmentsRef.current.reduce((sum, attachment) => sum + attachment.blob.size, 0);
      if (totalPendingBytes + blob.size > MAX_CHAT_ATTACHMENT_TOTAL_BYTES) {
        toasts.add({ title: `Attached files must total ${formatAttachmentSize(MAX_CHAT_ATTACHMENT_TOTAL_BYTES)} or less`, variant: "error" });
        continue;
      }
      const id = crypto.randomUUID();
      const previewUrl = mimeType.startsWith("image/") ? URL.createObjectURL(blob) : undefined;
      const pending: PendingAttachment = {
        id,
        blob,
        mimeType,
        name: file.name || undefined,
        previewUrl,
        uploadState: "uploading",
      };
      pendingAttachmentsRef.current = [...pendingAttachmentsRef.current, pending];
      setPendingAttachments((prev) => [...prev, pending]);
      void uploadPendingAttachment(id, blob, mimeType, file.name || undefined);
    }
  };

  const removeAttachment = (id: string) => {
    const attachment = pendingAttachmentsRef.current.find((attachment) => attachment.id === id);
    if (attachment) {
      if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      if (attachment.ref) deleteStagedAttachment(attachment.ref);
    }
    pendingAttachmentsRef.current = pendingAttachmentsRef.current.filter((attachment) => attachment.id !== id);
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  const hasDraggedFiles = (event: ReactDragEvent): boolean => {
    return Array.from(event.dataTransfer.types).includes("Files");
  };

  const handleAttachmentDragEnter = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    attachmentDragDepthRef.current++;
    setIsAttachmentDragActive(true);
  };

  const handleAttachmentDragOver = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = pendingAttachmentsRef.current.length >= MAX_PENDING_ATTACHMENTS ? "none" : "copy";
    setIsAttachmentDragActive(true);
  };

  const handleAttachmentDragLeave = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    attachmentDragDepthRef.current = Math.max(0, attachmentDragDepthRef.current - 1);
    if (attachmentDragDepthRef.current === 0) setIsAttachmentDragActive(false);
  };

  const handleAttachmentDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    if (!hasDraggedFiles(event)) return;
    event.preventDefault();
    attachmentDragDepthRef.current = 0;
    setIsAttachmentDragActive(false);
    void addFiles(event.dataTransfer.files);
  };

  // Ranges the caret addresses as single units: resource capsules and the resolved command. Read
  // from refs so callbacks scheduled off a render (rAF, awaited RPC) see current positions.
  const currentTokenRanges = (): ComposerRange[] => {
    const command = selectedSlashCommandRef.current;
    return [
      ...capsulesRef.current.map(({start, length}) => ({start, length})),
      ...(command ? [{start: command.start, length: command.length}] : []),
      ...formatTokensRef.current.map(({start, length}) => ({start, length})),
    ];
  };

  const capsuleTokenText = (description: ResourceDescription, vendorId?: string) =>
    (vendorId && vendorBranding.get(vendorId)?.logoUrl ? CAPSULE_LOGO_SLOT : "") + description.title;

  // The picker parses at the caret, but only its token matters, so refresh its copy of the caret
  // when that changes rather than on every movement. Plain caret movement then re-renders nothing.
  const syncPickerCaret = (position: number) => {
    const text = inputValueRef.current;
    const key = slashCommandTokenKey(text, position);
    if (key !== pickerCaretRef.current.key || text !== pickerCaretRef.current.text) {
      pickerCaretRef.current = {key, text};
      setCursorPosition(position);
    }
  };

  const moveCaret = (position: number) => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;
    textarea.setSelectionRange(position, position);
    syncPickerCaret(position);
  };

  const removeTokenAt = (range: ComposerRange) => {
    const rangeEnd = range.start + range.length;
    const removal = removeComposerToken(inputValueRef.current, range);
    setInputValue(removal.value);
    setCapsules(previous => previous
      .filter(capsule => capsule.start !== range.start)
      .map(capsule => capsule.start >= rangeEnd
        ? {...capsule, start: capsule.start + removal.delta}
        : capsule));
    setFormatTokens(previous => previous
      .filter(token => token.start !== range.start)
      .map(token => token.start >= rangeEnd
        ? {...token, start: token.start + removal.delta}
        : token));
    setSelectedSlashCommand(previous => {
      if (!previous || previous.start === range.start) return null;
      return previous.start >= rangeEnd
        ? {...previous, start: previous.start + removal.delta}
        : previous;
    });
    requestAnimationFrame(() => moveCaret(removal.caret));
  };

  // Hit-tests the pointer against the mirror's token spans, which lay out identically to the
  // textarea's text.
  const tokenAtPoint = (clientX: number, clientY: number):
      {start: number; edge: number} | null => {
    const mirror = mirrorRef.current?.node;
    // Runs on every pointer move, and `getClientRects()` below forces a layout, so do nothing at
    // all in the common case of a composer with no tokens in it.
    if (!mirror || (capsulesRef.current.length === 0 && !selectedSlashCommandRef.current
        && formatTokensRef.current.length === 0)) {
      return null;
    }
    for (const span of mirror.querySelectorAll<HTMLElement>("[data-token-start]")) {
      // One rect per line the token occupies.
      for (const rect of Array.from(span.getClientRects())) {
        if (clientX < rect.left || clientX > rect.right ||
            clientY < rect.top || clientY > rect.bottom) continue;
        return {
          start: Number(span.dataset.tokenStart),
          edge: clientX < rect.left + rect.width / 2
            ? Number(span.dataset.tokenStart)
            : Number(span.dataset.tokenEnd),
        };
      }
    }
    return null;
  };

  // Completing a command leaves the `/name` text in place (only its color changes) and parks the
  // caret past it so the next keystroke doesn't grow the token.
  const applySlashCommandSelection = useCallback((
      choice: SlashCommandChoice, tokenStart: number, tokenEnd: number) => {
    const splice = spliceComposerToken(
        inputValueRef.current, tokenStart, tokenEnd, `/${choice.name}`);
    setInputValue(splice.value);
    setCapsules(previous => previous.map(capsule =>
      capsule.start >= tokenEnd
        ? {...capsule, start: capsule.start + splice.delta}
        : capsule));
    setSelectedSlashCommand({choice, start: splice.start, length: splice.length});
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      moveCaret(splice.caret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the resolved command anchored to its text when text is inserted or removed before it.
  const shiftSelectedSlashCommand = (position: number, delta: number) => {
    if (delta === 0) return;
    setSelectedSlashCommand(previous => previous && previous.start >= position
      ? {...previous, start: previous.start + delta}
      : previous);
  };

  const slashCommandPicker = useSlashCommandPicker({
    inputValue,
    cursorPosition,
    selectedCommand: selectedSlashCommand?.choice ?? null,
    disabled: isBlocked,
    anchorRef: promptCardRef,
    getOverseer,
    onSelect: applySlashCommandSelection,
    chatExists: !newChat,
  });

  const handleSend = async () => {
    if (sendInFlightRef.current || isSending || isBlocked) return;
    setSendHiccup(null);
    const attachmentsSnapshot = pendingAttachments;
    const readyAttachments = attachmentsSnapshot
      .filter((attachment) => attachment.uploadState === "ready" && attachment.ref)
      .map((attachment) => attachment.ref!);
    const hasUploadingAttachment = attachmentsSnapshot.some((attachment) => attachment.uploadState === "uploading");
    const hasFailedAttachment = attachmentsSnapshot.some((attachment) => attachment.uploadState === "error");

    if (!inputValue.trim() && !selectedSlashCommand && readyAttachments.length === 0) return;
    if (hasUploadingAttachment) {
      toasts.add({ title: "Please wait for attachment uploads to finish", variant: "error" });
      return;
    }
    if (hasFailedAttachment) {
      toasts.add({ title: "Remove failed attachment uploads before sending", variant: "error" });
      return;
    }

    sendInFlightRef.current = true;
    setIsSending(true);
    try {
      let messageInput = inputValue;
      let inputCapsules = capsules;
      let slashCommand = selectedSlashCommand?.choice ?? null;
      // How far a position moves once the format tokens are reduced to their nouns: the invisible
      // logo slot goes away, so everything after each token shifts left. Used to carry the command
      // token and the capsules into the rewritten text's coordinates.
      const formatShiftBefore = (position: number) => {
        let delta = 0;
        for (const token of formatTokens) {
          if (token.start + token.length <= position) {
            delta += token.format.output.noun.length - token.length;
          }
        }
        return delta;
      };

      if (formatTokens.length > 0) {
        // A format token sends the word the user saw: the noun is the request, and the agent's
        // catalog already lists the deployment's formats by these nouns. Only the logo slot is
        // removed, since it exists purely so the mirror has somewhere to paint the icon. Applied
        // back-to-front so earlier offsets stay valid while the text is rewritten.
        let text = messageInput;
        for (const token of [...formatTokens].toSorted((a, b) => b.start - a.start)) {
          text = text.slice(0, token.start) + token.format.output.noun +
              text.slice(token.start + token.length);
        }
        inputCapsules = capsules.map(capsule => {
          const delta = formatShiftBefore(capsule.start);
          return delta === 0 ? capsule : {...capsule, start: Math.max(0, capsule.start + delta)};
        });
        messageInput = text;
      }
      let commandPosition: number | undefined;
      if (selectedSlashCommand) {
        // Strip the command out of the *rewritten* text, not out of `inputValue`: the format pass
        // above may already have moved it.
        let stripped = stripSlashCommandToken(messageInput, {
          start: selectedSlashCommand.start + formatShiftBefore(selectedSlashCommand.start),
          length: selectedSlashCommand.length,
        });
        messageInput = stripped.args;
        commandPosition = stripped.commandPosition;
      } else if (messageInput.startsWith("/") && !messageInput.startsWith("//")) {
        // A leading command that was typed but never resolved: resolve it now or refuse to send.
        // Parsed from the format-rewritten text so a format named later in the line doesn't smuggle
        // its logo slot into the arguments. A format token can't precede the command here: one at
        // position 0 would mean the text no longer starts with "/".
        let parsed = parseSlashCommandInput(messageInput, 1);
        if (!parsed) {
          toasts.add({ title: "Slash command is invalid", variant: "error" });
          return;
        }
        let match: SlashCommandChoice | null;
        try {
          match = await slashCommandPicker.resolveExact(parsed);
        } catch (error) {
          console.error("Failed to resolve slash command:", error);
          toasts.add({ title: "Couldn't load slash commands", variant: "error" });
          return;
        }
        if (!match) {
          toasts.add({ title: "Choose a slash command", variant: "error" });
          return;
        }
        slashCommand = match;
        messageInput = parsed.tail;
        inputCapsules = inputCapsules.flatMap(capsule =>
          capsule.start >= parsed.tailStart
            ? [{...capsule, start: capsule.start - parsed.tailStart}]
            : []);
      } else if (messageInput.startsWith("//")) {
        messageInput = messageInput.slice(1);
        inputCapsules = inputCapsules.map(capsule => ({
          ...capsule,
          start: Math.max(0, capsule.start - 1),
        }));
      }

      if (slashCommand && (inputCapsules.length > 0 || readyAttachments.length > 0)) {
        toasts.add({ title: "Slash commands cannot include resources or attachments", variant: "error" });
        return;
      }
      let message: string | SlashCommandRequest = messageInput;
      if (slashCommand) {
        // `args` is already trimmed when it came from stripSlashCommandToken, which is what
        // `commandPosition` is measured against. The other branches resolve a leading command, so
        // the position is 0.
        message = {
          id: slashCommand.selection,
          args: messageInput.trim(),
          ...(commandPosition ? {commandPosition} : {}),
        };
      }
      let capsuleSpecifiers: CapsuleSpecifier[] | undefined;
      if (typeof message === "string" && inputCapsules.length > 0) {
        // Build processed message: replace each capsule title with [i] placeholder.
        const sortedCapsules = [...inputCapsules].toSorted((a, b) => a.start - b.start);
        let processedMsg = messageInput;
        let cumulativeShift = 0;
        capsuleSpecifiers = [];

        for (let i = 0; i < sortedCapsules.length; i++) {
          const c = sortedCapsules[i];
          const placeholder = `[${i}]`;
          const adjustedStart = c.start + cumulativeShift;
          processedMsg =
            processedMsg.slice(0, adjustedStart) +
            placeholder +
            processedMsg.slice(adjustedStart + c.length);
          capsuleSpecifiers.push({
            position: adjustedStart,
            length: placeholder.length,
            gatekeeperId: c.gatekeeperId,
            description: c.description,
            vendorId: c.vendorId,
          });
          cumulativeShift += placeholder.length - c.length;
        }
        message = processedMsg;
      }

      if (typeof message === "string") {
        let leadingWhitespace = message.length - message.trimStart().length;
        if (leadingWhitespace > 0) {
          capsuleSpecifiers = capsuleSpecifiers?.map(specifier => ({
            ...specifier,
            position: Math.max(0, specifier.position - leadingWhitespace),
          }));
        }
        message = message.trim();
      }

      // Positions are resolved against the text as sent, which for a slash command is its
      // arguments: the part the transcript renders as the user's words.
      const formatRefs = locateMessageFormatRefs(
          typeof message === "string" ? message : message.args,
          [...formatTokens].toSorted((a, b) => a.start - b.start).map(token => token.format));

      await onSend(message, selectedModel,
          capsuleSpecifiers?.length ? capsuleSpecifiers : undefined,
          readyAttachments.length ? readyAttachments : undefined,
          formatRefs);
      for (const attachment of attachmentsSnapshot) {
        if (attachment.previewUrl) URL.revokeObjectURL(attachment.previewUrl);
      }
      setInputValue("");
      setCapsules([]);
      setSelectedSlashCommand(null);
      setFormatTokens([]);
      pendingAttachmentsRef.current = [];
      setPendingAttachments([]);
    } finally {
      sendInFlightRef.current = false;
      if (mountedRef.current) setIsSending(false);
    }
  };

  const submitMessage = () => {
    const submittedChatKey = chatKey;
    void handleSend().catch((err) => {
      if (isTransientRpcError(err)) {
        setSendHiccup({ chatKey: submittedChatKey });
      } else {
        // The onSend handlers log the RPC failures they see; this is the only report for
        // anything handleSend itself throws before reaching them.
        console.error("Failed to send chat message:", err);
      }
    });
  };

  const handleAttachLogs = () => {
    const formatted = onConsumeConsoleLogs();
    setInputValue((prev) => prev + "\n\n" + formatted);
  };

  // Called when the user selects an account in the CapsuleOverlay.
  // Creates a capsule gatekeeper, fetches its description, and replaces the URL
  // in the input text with the resource title highlighted as a capsule.
  const handleCapsuleCreate = async (accountId: number, vendorId: string) => {
    if (!activeUrl) return;

    try {
      // Create the capsule gatekeeper.
      const gk = await createCapsuleGatekeeper(accountId, normalizeResourceUrl(activeUrl.text));
      if (!gk) {
        console.error("Failed to create capsule gatekeeper");
        return;
      }

      try {
        // Fetch ID and description in parallel (promise pipelining).
        const [id, description] = await Promise.all([
          gk.getId(),
          gk.describe(),
        ]);

        // Snapshot the activeUrl position before any state updates.
        const urlStart = activeUrl.start;
        const urlEnd = activeUrl.end;
        const splice = spliceComposerToken(
            inputValueRef.current, urlStart, urlEnd, capsuleTokenText(description, vendorId));

        setInputValue(splice.value);

        // Adjust positions of existing capsules and add the new one.
        shiftSelectedSlashCommand(urlEnd, splice.delta);
        setCapsules((prev) => [
          ...prev.map((c) => c.start >= urlEnd ? { ...c, start: c.start + splice.delta } : c),
          {
            start: splice.start,
            length: splice.length,
            gatekeeperId: id,
            description,
            vendorId,
          },
        ]);

        // Clear activeUrl so the overlay dismisses.
        setActiveUrl(null);

        requestAnimationFrame(() => {
          composerTextareaRef.current?.focus();
          moveCaret(splice.caret);
        });
      } finally {
        gk[Symbol.dispose]();
      }
    } catch (err) {
      console.error("Failed to create capsule:", err);
    }
  };

  // Called when the user selects a prefix-match "refine" row in the CapsuleOverlay.
  // Replaces the URL in the input with the new (extended) URL and selects the first placeholder.
  const handleRefine = (
    newUrl: string,
    placeholderStart: number,
    placeholderEnd: number,
  ) => {
    if (!activeUrl) return;

    const urlStart = activeUrl.start;
    const urlEnd = activeUrl.end;
    const lengthDiff = newUrl.length - (urlEnd - urlStart);

    // Replace the old URL text with the new URL (which includes the suffix + placeholders).
    setInputValue(
      (prev) => prev.slice(0, urlStart) + newUrl + prev.slice(urlEnd),
    );

    // Adjust positions of any capsules that come after the URL.
    shiftSelectedSlashCommand(urlEnd, lengthDiff);
    if (lengthDiff !== 0) {
      setCapsules((prev) => {
        const adjusted = prev.map((c) =>
          c.start >= urlEnd ? { ...c, start: c.start + lengthDiff } : c,
        );
        return adjusted;
      });
    }

    // Update activeUrl to reflect the new URL bounds.
    setActiveUrl({
      text: newUrl,
      start: urlStart,
      end: urlStart + newUrl.length,
    });

    // Reset overlay index so the first item is selected after the picker re-evaluates.
    setOverlayIndex(0);

    // Select the first placeholder in the textarea on the next frame.
    requestAnimationFrame(() => {
      const wrapper = wrapperRef.current;
      if (!wrapper) return;
      const textarea = wrapper.querySelector("textarea");
      if (textarea) {
        textarea.setSelectionRange(
          urlStart + placeholderStart,
          urlStart + placeholderEnd,
        );
        textarea.focus();
      }
    });
  };

  // Opens the attach modal, saving the current cursor position so we can insert there later.
  const handleAttachOpen = () => {
    const wrapper = wrapperRef.current;
    if (wrapper) {
      const textarea = wrapper.querySelector("textarea");
      if (textarea) {
        attachCursorPosRef.current =
          textarea.selectionStart ?? inputValueRef.current.length;
      } else {
        attachCursorPosRef.current = inputValueRef.current.length;
      }
    } else {
      attachCursorPosRef.current = inputValueRef.current.length;
    }
    setAttachModalOpen(true);
  };

  // Insert a capsule chip at the given position and move the caret past it.
  const insertCapsuleAt = (
    insertPos: number,
    id: number,
    description: ResourceDescription,
    vendorId?: string,
  ) => {
    const splice = spliceComposerToken(
        inputValueRef.current, insertPos, insertPos, capsuleTokenText(description, vendorId));

    setInputValue(splice.value);

    // Shift any existing capsules after the insertion point.
    shiftSelectedSlashCommand(insertPos, splice.delta);
    setCapsules((prev) => [
      ...prev.map((c) =>
        c.start >= insertPos ? { ...c, start: c.start + splice.delta } : c),
      { start: splice.start, length: splice.length, gatekeeperId: id, description, vendorId },
    ]);

    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      moveCaret(splice.caret);
    });
  };

  // Called by the GatekeeperModal when a gatekeeper is created via the attach flow.
  // Inserts a capsule at the previously-saved cursor position.
  const handleAttachCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    try {
      // Fetch everything in parallel (promise pipelining).
      const [id, description, creationSpec] = await Promise.all([
        gk.getId(), gk.describe(), gk.getCreationSpec(),
      ]);
      insertCapsuleAt(attachCursorPosRef.current, id, description,
          creationSpec.type === "gatekeeper" ? creationSpec.vendorId : undefined);
      setAttachModalOpen(false);
    } finally {
      gk[Symbol.dispose]();
    }
  };

  // Handle text changes: capsules are atomic, so an edit overlapping one removes it, while an
  // edit overlapping the resolved command only detaches the resolution. Both shift when text is
  // inserted or removed before them.
  const handleInputChange = (newValue: string, editCursorPos?: number) => {
    const oldValue = inputValueRef.current;

    // Find the region that changed by comparing old and new values.
    let diffStart = 0;
    while (
      diffStart < oldValue.length &&
      diffStart < newValue.length &&
      oldValue[diffStart] === newValue[diffStart]
    ) {
      diffStart++;
    }

    let oldEnd = oldValue.length;
    let newEnd = newValue.length;
    while (
      oldEnd > diffStart &&
      newEnd > diffStart &&
      oldValue[oldEnd - 1] === newValue[newEnd - 1]
    ) {
      oldEnd--;
      newEnd--;
    }

    // The edit replaced oldValue[diffStart..oldEnd) with newValue[diffStart..newEnd).

    // Use the cursor position to disambiguate where the edit actually occurred. The
    // text-diff algorithm attributes the edit to the end of the matching prefix, which
    // is wrong when editing within a run of identical characters (e.g., spaces before a
    // capsule whose leading char is also a space). The cursor position after the edit
    // tells us exactly where the edited region ends in the new value.
    if (editCursorPos !== undefined && editCursorPos < newEnd) {
      const insertedLen = newEnd - diffStart;
      const deletedLen = oldEnd - diffStart;
      const cursorBasedStart = editCursorPos - insertedLen;
      if (cursorBasedStart >= 0) {
        diffStart = cursorBasedStart;
        newEnd = editCursorPos;
        oldEnd = cursorBasedStart + deletedLen;
      }
    }

    const isPureInsertion = oldEnd === diffStart;
    const command = selectedSlashCommandRef.current;
    const commandEdited = command !== null &&
      diffStart < command.start + command.length && oldEnd > command.start;
    if (commandEdited) setSelectedSlashCommand(null);

    // Typing through a token removes that format. Only tokens the edit touched are dropped; the
    // rest shift.
    const editedFormats = formatTokensRef.current.filter(token =>
      diffStart < token.start + token.length && oldEnd > token.start);
    if (editedFormats.length > 0) {
      const dropped = new Set(editedFormats.map(token => token.start));
      setFormatTokens(previous => previous.filter(token => !dropped.has(token.start)));
    }
    const survivingFormats = (position: number, delta: number) => {
      if (delta === 0) return;
      const dropped = new Set(editedFormats.map(token => token.start));
      setFormatTokens(previous => previous.flatMap(token => dropped.has(token.start)
        ? []
        : [token.start >= position ? {...token, start: token.start + delta} : token]));
    };

    if (capsulesRef.current.length === 0) {
      if (!commandEdited) shiftSelectedSlashCommand(oldEnd, newEnd - oldEnd);
      survivingFormats(oldEnd, newEnd - oldEnd);
      setInputValue(newValue);
      return;
    }

    // If the insertion (no deletion) landed inside a capsule, reject the edit.
    if (isPureInsertion) {
      for (const capsule of capsulesRef.current) {
        const capsuleEnd = capsule.start + capsule.length;
        if (diffStart > capsule.start && diffStart < capsuleEnd) {
          // Reject the edit: reset the textarea DOM directly and restore cursor.
          const wrapper = wrapperRef.current;
          const textarea = wrapper?.querySelector("textarea");
          if (textarea) {
            textarea.value = oldValue;
            textarea.setSelectionRange(diffStart, diffStart);
          }
          return;
        }
      }
    }

    // First pass: identify broken capsules and remove their remaining text from
    // newValue. Process from end to start so removals don't shift earlier positions.
    const broken: InputCapsule[] = [];
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length;
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        broken.push(capsule);
      }
    }

    // Apply the user's edit shift to map old capsule positions into newValue.
    // Then remove any remaining capsule text that the user didn't already delete.
    let adjusted = newValue;
    const editShift = newEnd - diffStart - (oldEnd - diffStart);
    // Sort broken capsules by start position descending so we can splice from the end.
    broken.sort((a, b) => b.start - a.start);
    let extraShift = 0;
    for (const capsule of broken) {
      // Map capsule range into newValue coordinates.
      let remStart = capsule.start;
      let remEnd = capsule.start + capsule.length;
      // The edit replaced old[diffStart..oldEnd) with new[diffStart..newEnd).
      // Portions of the capsule before diffStart are unchanged.
      // Portions within the edit region were already modified by the user's edit.
      // Portions after oldEnd shifted by editShift.
      // We want to remove the parts of the capsule that survived the user's edit.
      if (remEnd <= diffStart) {
        // Capsule is entirely before the edit — shouldn't be broken, skip.
        continue;
      }
      if (remStart >= oldEnd) {
        // Capsule is entirely after the edit — shifted in newValue.
        remStart += editShift;
        remEnd += editShift;
      } else {
        // Capsule overlaps the edit region. Clamp to the parts outside the edit
        // that still exist in newValue, plus the edited region itself.
        // In newValue, the edit region is [diffStart..newEnd).
        // Before the edit: capsule text in [remStart..diffStart) is unchanged.
        // After the edit: capsule text in [oldEnd..capsuleEnd) shifted to [newEnd..newEnd+(capsuleEnd-oldEnd)).
        remStart = Math.min(remStart, diffStart);
        const afterOldEnd = capsule.start + capsule.length - oldEnd;
        if (afterOldEnd > 0) {
          remEnd = newEnd + afterOldEnd;
        } else {
          remEnd = newEnd;
        }
        // Also include any part before diffStart.
        remStart = Math.min(remStart, diffStart);
      }
      const removeLen = remEnd - remStart;
      if (removeLen > 0 && remStart < adjusted.length) {
        adjusted =
          adjusted.slice(0, remStart) +
          adjusted.slice(Math.min(remEnd, adjusted.length));
        extraShift -= removeLen;
      }
    }

    // Second pass: keep non-broken capsules, adjusting positions.
    const totalShift = editShift + extraShift;
    if (!commandEdited) shiftSelectedSlashCommand(oldEnd, totalShift);
    survivingFormats(oldEnd, totalShift);
    const surviving: InputCapsule[] = [];
    for (const capsule of capsulesRef.current) {
      const capsuleEnd = capsule.start + capsule.length;
      if (diffStart < capsuleEnd && oldEnd > capsule.start) {
        continue; // broken
      }
      if (capsule.start >= oldEnd) {
        surviving.push({ ...capsule, start: capsule.start + totalShift });
      } else {
        surviving.push(capsule);
      }
    }

    // Position cursor where the earliest broken capsule was.
    const cursorPos =
      broken.length > 0
        ? broken[broken.length - 1].start // broken is sorted descending, last = earliest
        : undefined;

    setCapsules(surviving);
    setInputValue(adjusted);

    if (cursorPos !== undefined) {
      requestAnimationFrame(() => {
        const wrapper = wrapperRef.current;
        if (!wrapper) return;
        const textarea = wrapper.querySelector("textarea");
        if (textarea) {
          textarea.setSelectionRange(cursorPos, cursorPos);
        }
      });
    }
  };

  // Detect whether the cursor is currently inside a URL in the input text.
  // Called on every cursor movement (select, click, keyup).
  const handleCursorChange = () => {
    const textarea = composerTextareaRef.current;
    if (!textarea) return;

    // A click, Home/End, or a word jump can land the caret inside a token; bounce it to the
    // closer edge. Ranged selections are left alone.
    let cursorPos = textarea.selectionStart;
    if (cursorPos === textarea.selectionEnd) {
      const snapped = snapCaretOutOfRanges(cursorPos, currentTokenRanges(), "nearest");
      if (snapped !== cursorPos) {
        cursorPos = snapped;
        textarea.setSelectionRange(snapped, snapped);
      }
    }
    syncPickerCaret(cursorPos);

    // One keystroke reaches this through `select`, `keyup`, and the frame after the edit. The scan
    // below only depends on the caret and the text, so do it once per distinct position.
    const text = inputValueRef.current;
    const scanned = lastUrlScanRef.current;
    if (scanned.position === cursorPos && scanned.text === text) return;
    lastUrlScanRef.current = {position: cursorPos, text};

    // Find all URL matches in the current text.
    URL_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = URL_REGEX.exec(text)) !== null) {
      const start = match.index;
      const end = start + match[0].length;

      // Cursor is within this URL (inclusive of both endpoints).
      if (cursorPos >= start && cursorPos <= end) {
        // Skip if this region is already a capsule.
        const isInsideCapsule = capsulesRef.current.some(
          (c) => start >= c.start && end <= c.start + c.length,
        );
        if (isInsideCapsule) break;

        setActiveUrl((prev) =>
          prev &&
          prev.text === match![0] &&
          prev.start === start &&
          prev.end === end
            ? prev
            : { text: match![0], start, end },
        );
        return;
      }
    }

    // Cursor is not inside any URL.
    setActiveUrl(null);
  };

  // Formats named in the message are inline tokens like capsules, addressed by the caret as one
  // unit. There can be several, and where each sits says which part of the request it belongs to,
  // so they stay in the text rather than becoming a separate field.
  const [formatTokens, setFormatTokens] = useState<FormatToken[]>([]);
  const formatTokensRef = useRef(formatTokens);
  formatTokensRef.current = formatTokens;

  // A format is only context on the message, so it coexists with everything else the composer can
  // carry, including a slash command ("/writing-review turn this into a Doc").
  const canChooseFormat = offerFormats;

  // Inserted at the caret, like a capsule, so the noun lands in the sentence that needs it.
  const chooseFormat = async (format: OutputFormatOffer) => {
    const logo = await formatIconDataUrl(format.output.icon);
    const value = inputValueRef.current;
    // The menu takes focus, but the textarea keeps its last selection; falling back to the end is
    // right for the case where it was never focused at all.
    const caret = Math.min(composerTextareaRef.current?.selectionStart ?? value.length, value.length);
    const at = snapCaretOutOfRanges(caret, currentTokenRanges(), "nearest");
    const splice = spliceComposerToken(
        value, at, at, (logo ? CAPSULE_LOGO_SLOT : "") + format.output.noun);
    setInputValue(splice.value);
    setCapsules(previous => previous.map(capsule => capsule.start >= at
      ? {...capsule, start: capsule.start + splice.delta}
      : capsule));
    shiftSelectedSlashCommand(at, splice.delta);
    setFormatTokens(previous => [
      ...previous.map(token => token.start >= at
        ? {...token, start: token.start + splice.delta}
        : token),
      {format, logo, start: splice.start, length: splice.length},
    ]);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      moveCaret(splice.caret);
    });
  };

  // What the mirror paints as objects rather than text. Memoized because the composer re-renders for
  // plenty of reasons that leave the text alone (attachments, agent activity, menus).
  const mirrorTokens = useMemo<MirrorToken[]>(() => [
    ...capsules.map(({start, length, vendorId}) => ({
      kind: "capsule" as const,
      start,
      length,
      // Painted into the em space the token starts with, so it costs no layout.
      logo: inputValue.startsWith(CAPSULE_LOGO_SLOT, start)
        ? cssLogoUrl(vendorId ? vendorBranding.get(vendorId)?.logoUrl : undefined)
        : undefined,
    })),
    ...(selectedSlashCommand ? [{
      kind: "command" as const,
      start: selectedSlashCommand.start,
      length: selectedSlashCommand.length,
    }] : []),
    ...formatTokens.map(({start, length, logo}) => ({
      kind: "capsule" as const,
      start,
      length,
      logo: inputValue.startsWith(CAPSULE_LOGO_SLOT, start) ? cssLogoUrl(logo) : undefined,
    })),
  ], [capsules, formatTokens, inputValue, selectedSlashCommand, vendorBranding]);

  // Console log severity is communicated by the dot colour only; the banner
  // chrome stays neutral so a noisy error doesn't paint a red bar above the
  // input.
  const logBannerClass = "border-kumo-line bg-kumo-elevated text-kumo-subtle";
  const logDotClass =
    consoleLogSeverity === "error"
      ? "bg-kumo-danger"
      : consoleLogSeverity === "warn"
        ? "bg-kumo-warning"
        : "bg-kumo-inactive";
  const logKind = consoleLogSeverity === "error"
    ? "error"
    : consoleLogSeverity === "warn"
      ? "warning"
      : "log";
  const selectedModelLabel = selectedModel == null
    ? "No agent"
    : models.find((model) => model.id === selectedModel)?.name ?? selectedModel;

  const hasReadyAttachment = pendingAttachments.some(
    (attachment) => attachment.uploadState === "ready" && attachment.ref,
  );
  const hasUnreadyAttachment = pendingAttachments.some(
    (attachment) => attachment.uploadState !== "ready",
  );
  const canSend = !isSending && !isAgentActive && !isBlocked &&
    (inputValue.trim().length > 0 || selectedSlashCommand !== null || hasReadyAttachment) &&
    !hasUnreadyAttachment;
  const canAttachMore = pendingAttachments.length < MAX_PENDING_ATTACHMENTS;

  return (
    // isolation: isolate contains z-indexes used inside the composer (the
    // captured-log floating chip with z-10, the textarea/mirror with z-[1])
    // so they can't paint on top of body-level portaled popovers like the
    // model picker dropdown opening above the composer.
    <div className={`px-4 py-4 relative isolate ${styles.chatInputRoot}`}>
      <input
        ref={attachmentInputRef}
        type="file"
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length > 0) void addFiles(files);
        }}
      />
      {/* Captured-log floating chip — sits above the composer like a transient pill */}
      {pendingConsoleLogCount > 0 && (
        <div className="pointer-events-none absolute inset-x-4 -top-10 z-10 flex justify-center">
          <div
            className={`themed-floating-shadow pointer-events-auto flex items-center gap-2 rounded-full border px-3 py-1.5 text-[12px] leading-4 tracking-[-0.2px] ${logBannerClass}`}
          >
            <Tooltip
              content={
                <pre className="m-0 whitespace-pre-wrap text-[11px] max-h-[300px] overflow-auto max-w-[500px]">
                  {consoleLogPreview}
                </pre>
              }
              side="top"
              align="end"
              asChild
            >
              <button
                type="button"
                onClick={handleAttachLogs}
                className="flex min-w-0 items-center gap-2 truncate text-left hover:text-kumo-default"
              >
                <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${logDotClass}`} />
                <span className="truncate">
                  Send {pendingConsoleLogCount} captured {logKind}
                  {pendingConsoleLogCount !== 1 ? "s" : ""} to chat
                </span>
              </button>
            </Tooltip>
            <button
              type="button"
              onClick={onDiscardConsoleLogs}
              className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full opacity-60 transition-opacity hover:bg-kumo-tint hover:opacity-100"
              aria-label="Discard captured logs"
            >
              <X size={10} />
            </button>
          </div>
        </div>
      )}

      {/* Prompt card. Brighter than the page surface (kumo-control vs kumo-base) and gently lifted
          with a soft neutral shadow so the composer reads as a distinct surface instead of blending
          into the canvas; the lift intensifies a touch on focus. */}
      <div
        ref={promptCardRef}
        className="themed-prompt-card-shadow relative overflow-visible rounded-2xl border border-kumo-line bg-kumo-control transition-shadow duration-150 ease-out"
        onDragEnter={handleAttachmentDragEnter}
        onDragOver={handleAttachmentDragOver}
        onDragLeave={handleAttachmentDragLeave}
        onDrop={handleAttachmentDrop}
      >
        {isAttachmentDragActive && (
          <div className={`themed-inset-outline pointer-events-none absolute inset-0 z-20 grid place-items-center rounded-2xl border-2 border-dashed p-4 backdrop-blur-[1px] transition-[opacity,transform] duration-150 ease-out ${canAttachMore ? "border-kumo-brand/55 bg-kumo-brand/10" : "border-kumo-warning/60 bg-kumo-warning/10"}`}>
            <div className={`themed-floating-shadow flex items-center gap-2 rounded-full border bg-kumo-base/90 px-3 py-2 text-[13px] font-medium leading-4 tracking-[-0.2px] text-kumo-default ${canAttachMore ? "border-kumo-brand/25" : "border-kumo-warning/30"}`}>
              <span className={`grid h-7 w-7 place-items-center rounded-full ${canAttachMore ? "bg-kumo-brand/12 text-kumo-brand" : "bg-kumo-warning/15 text-kumo-warning"}`}>
                <FileIcon size={16} weight="duotone" />
              </span>
              {canAttachMore ? "Drop files to attach" : "Messages are limited to 5 attachments"}
            </div>
          </div>
        )}
        {draftUpdateBanner}
        {sendHiccup && sendHiccup.chatKey === chatKey && (
          <div className="px-4 pt-2 text-xs text-kumo-warning">
            {/* Composers without a chatKey (new-chat, home page) have no thread to check. */}
            {chatKey != null
              ? "Connection hiccup — your message may not have been sent. Check the thread, then try again; if it keeps failing, reload the page."
              : "Connection hiccup — your message may not have been sent. Try again; if it keeps failing, reload the page."}
          </div>
        )}
        {/* Textarea */}
        <div className="relative px-4 pb-1 pt-3">
          {slashCommandPicker.popup}
          {/* The resolved command is marked by color alone, so announce it for screen readers. */}
          <div className="sr-only" aria-live="polite">
            {slashCommandPicker.status ||
              (selectedSlashCommand
                ? `Slash command /${selectedSlashCommand.choice.name} from ${selectedSlashCommand.choice.providerLabel} is ready to send`
                : "")}
          </div>
          <div ref={wrapperRef} className={styles.capsuleInputWrapper}>
            {activeUrl && (
              <CapsuleOverlay
                url={activeUrl.text}
                onSelectAccount={(accountId, vendorId) => {
                  handleCapsuleCreate(accountId, vendorId);
                }}
                onRefine={handleRefine}
                onDismiss={() => setActiveUrl(null)}
                lineOffset={urlLineOffset}
                activeIndex={overlayIndex}
                onItems={handleOverlayItems}
                activateRef={overlayActivateRef}
              />
            )}
            <ComposerMirror
              ref={mirrorRef}
              value={inputValue}
              tokens={mirrorTokens}
              disabled={isBlocked}
            />
            <textarea
              value={inputValue}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={slashCommandPicker.open}
              aria-controls={slashCommandPicker.open ? slashCommandPicker.listboxId : undefined}
              aria-activedescendant={slashCommandPicker.activeDescendant}
              onChange={(e) => {
                handleInputChange(e.target.value, e.target.selectionStart ?? 0);
                syncPickerCaret(e.target.selectionStart ?? 0);
                requestAnimationFrame(handleCursorChange);
                // Auto-resize after value change
                autoResizeTextarea(e.target, minRows, newChat ? 10 : 4);
                syncMirrorScroll(e.target);
              }}
              onSelect={handleCursorChange}
              onClick={handleCursorChange}
              onKeyUp={handleCursorChange}

              onMouseDown={(e) => {
                if (e.button !== 0) return;
                const token = tokenAtPoint(e.clientX, e.clientY);
                if (!token) return;
                e.preventDefault();
                e.currentTarget.focus();
                moveCaret(token.edge);
              }}
              onMouseMove={(e) => {
                const token = tokenAtPoint(e.clientX, e.clientY);
                mirrorRef.current?.setHoveredToken(token?.start ?? null);
                const cursor = token ? "default" : "";
                if (e.currentTarget.style.cursor !== cursor) {
                  e.currentTarget.style.cursor = cursor;
                }
              }}
              onMouseLeave={(e) => {
                mirrorRef.current?.setHoveredToken(null);
                e.currentTarget.style.cursor = "";
              }}
              onScroll={(e) => {
                syncMirrorScroll(e.currentTarget);
              }}
              disabled={isBlocked}
              placeholder={
                isBlocked
                  ? blockedReason
                  : isAgentActive
                    ? "Waiting for agent…"
                    : newChat
                      ? "Start a new conversation…"
                      : "Ask a follow-up…"
              }
              autoFocus={autoFocus}
              rows={minRows}
              onPaste={(e) => {
                const files = Array.from(e.clipboardData.items)
                  .filter((item) => item.kind === "file")
                  .map((item) => item.getAsFile())
                  .filter((file): file is File => file !== null);
                if (files.length > 0) {
                  e.preventDefault();
                  void addFiles(files);
                }
              }}
              onKeyDown={(e) => {
                if (slashCommandPicker.open && e.key === "Escape") {
                  e.preventDefault();
                  slashCommandPicker.dismiss();
                  return;
                }
                if (slashCommandPicker.open && e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (slashCommandPicker.selectable && slashCommandPicker.activeChoice) {
                    slashCommandPicker.select(slashCommandPicker.activeChoice);
                  }
                  return;
                }
                if (slashCommandPicker.open && e.key === "Tab" &&
                    slashCommandPicker.selectable && slashCommandPicker.activeChoice) {
                  e.preventDefault();
                  slashCommandPicker.select(slashCommandPicker.activeChoice);
                  return;
                }
                if (slashCommandPicker.open && slashCommandPicker.selectable && slashCommandPicker.choices.length > 0 &&
                    (e.key === "ArrowDown" || e.key === "ArrowUp")) {
                  e.preventDefault();
                  const direction = e.key === "ArrowDown" ? 1 : -1;
                  slashCommandPicker.setIndex((current) =>
                    (current + direction + slashCommandPicker.choices.length) % slashCommandPicker.choices.length);
                  return;
                }
                // Delete a whole capsule or command rather than eating into it.
                if ((e.key === "Backspace" || e.key === "Delete") &&
                    !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
                    e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                  const caret = e.currentTarget.selectionStart;
                  const range = currentTokenRanges().find(({start, length}) =>
                    e.key === "Backspace" ? caret === start + length : caret === start);
                  if (range) {
                    e.preventDefault();
                    removeTokenAt(range);
                    return;
                  }
                }
                // Step over a whole capsule or command rather than through its characters.
                if ((e.key === "ArrowLeft" || e.key === "ArrowRight") &&
                    !e.shiftKey && !e.metaKey && !e.altKey && !e.ctrlKey &&
                    e.currentTarget.selectionStart === e.currentTarget.selectionEnd) {
                  const direction = e.key === "ArrowRight" ? 1 : -1;
                  const target = e.currentTarget.selectionStart + direction;
                  const snapped = snapCaretOutOfRanges(
                      target, currentTokenRanges(), direction > 0 ? "right" : "left");
                  if (snapped !== target) {
                    e.preventDefault();
                    moveCaret(snapped);
                    return;
                  }
                }
                // Enter sends message (unless Shift is held)
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (!isAgentActive && !isBlocked) submitMessage();
                  return;
                }
                if (activeUrl) {
                  handlePickerKeyDown(
                    e,
                    activeUrl.text,
                    activeUrl.start,
                    overlayIndex,
                    navigateOverlay,
                    overlayItemsRef,
                    overlayActivateRef,
                  );
                }
              }}
              ref={(el) => {
                composerTextareaRef.current = el;
                // Initial auto-resize on mount
                if (el) {
                  autoResizeTextarea(el, minRows, newChat ? 10 : 4);
                  syncMirrorScroll(el);
                }
              }}
              className={`relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[14px] leading-[22px] tracking-[-0.25px] outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed ${composerTextareaClass}`}
            />
          </div>
        </div>

        {pendingAttachments.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-3 pb-2 pt-1">
            {pendingAttachments.map((attachment) => (
              <div key={attachment.id} className="relative flex h-14 w-14 items-center justify-center overflow-hidden rounded-lg border border-kumo-line/70 bg-kumo-elevated">
                {attachment.previewUrl ? (
                  <img src={attachment.previewUrl} alt={attachment.name ?? "Attached file"} className="h-full w-full object-cover" />
                ) : (
                  <FileIcon size={22} className="text-kumo-inactive" />
                )}
                {attachment.uploadState === "uploading" && (
                  <div className="absolute inset-0 grid place-items-center rounded-lg bg-black/35 text-[10px] text-white">Uploading</div>
                )}
                {attachment.uploadState === "error" && (
                  <div className="absolute inset-0 grid place-items-center rounded-lg bg-kumo-danger/80 px-1 text-center text-[9px] leading-3 text-white">Failed</div>
                )}
                <button
                  type="button"
                  aria-label="Remove attachment"
                  onClick={() => removeAttachment(attachment.id)}
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded-full bg-black/55 text-white hover:bg-black/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/80"
                >
                  <X size={10} weight="bold" />
                </button>
              </div>
            ))}
          </div>
        )}

        {/* Footer row: connection/options left, model + send right */}
        <div className="flex items-center justify-between gap-1.5 px-3 pb-1.5">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
            <DropdownMenu>
              <DropdownMenu.Trigger
                render={
                  <button
                    type="button"
                    className="group flex h-8 w-8 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.96] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-subtle"
                    aria-label="Open chat options"
                  >
                    <Plus size={18} />
                  </button>
                }
              />
              <DropdownMenu.Content collisionPadding={16} className="themed-floating-shadow-lg !z-[1100] !min-w-[170px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
                {/* The deployment's standard formats. Picking one drops its name into the message at
                    the caret; the agent is told what to build from it. */}
                {canChooseFormat && (
                  <ComposerFormatMenuItems onSelect={(format) => void chooseFormat(format)} />
                )}
                {onToggleThinkingTraces && (
                  <DropdownMenu.Item
                    onClick={onToggleThinkingTraces}
                    className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                  >
                    <span className="mr-2 inline-flex h-4 w-4 items-center justify-center text-kumo-inactive">
                      <Brain size={14} />
                    </span>
                    <span className="flex-1">
                      {showThinkingTraces ? "Hide thinking" : "Show thinking"}
                    </span>
                  </DropdownMenu.Item>
                )}
                <DropdownMenu.Item
                  onClick={() => attachmentInputRef.current?.click()}
                  className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                >
                  <span className="mr-2 inline-flex h-4 w-4 items-center justify-center text-kumo-inactive">
                    <FileIcon size={14} />
                  </span>
                  <span className="flex-1">Upload file</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu>
            <button
              type="button"
              onClick={handleAttachOpen}
              className="inline-flex h-8 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-none tracking-[-0.25px] text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.97]"
            >
              <Plug size={15} className="flex-shrink-0" />
              <span className={`leading-none ${styles.attachLabelText}`}>{attachLabel ?? "Add resource"}</span>
            </button>
          </div>

          {/* Right actions */}
          <div className="ml-auto flex min-w-0 flex-shrink items-center gap-1.5">
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={
                    <button
                      type="button"
                      className="group inline-flex h-8 min-w-0 max-w-[180px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[13px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default"
                      aria-label="Select model"
                    >
                      <span className="min-w-0 truncate">{selectedModelLabel}</span>
                      <CaretDown
                        size={12}
                        weight="bold"
                        className="flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                      />
                    </button>
                  }
                />
                <DropdownMenu.Content className="themed-floating-shadow-lg !z-[1100] !min-w-[190px] rounded-2xl border border-kumo-line/70 bg-kumo-base p-1">
                  {models.map((model) => {
                    const active = selectedModel === model.id;
                    return (
                      <DropdownMenu.Item
                        key={model.id}
                        onClick={() => onModelChange(model.id)}
                        className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                      >
                        <span className="min-w-0 flex-1 truncate">{model.name}</span>
                        {active && (
                          <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
                        )}
                      </DropdownMenu.Item>
                    );
                  })}
                  <div className="my-1 border-t border-kumo-line/70" />
                  <DropdownMenu.Item
                    onClick={() => onModelChange(null)}
                    className="!h-auto rounded-xl !px-2 !py-1.5 text-[12px] leading-4 font-normal tracking-[-0.15px] text-kumo-subtle transition-colors data-highlighted:bg-kumo-tint/70 data-highlighted:text-kumo-default"
                  >
                    <span className="min-w-0 flex-1 truncate">No agent</span>
                    {selectedModel == null && (
                      <Check size={12} weight="bold" className="ml-3 flex-shrink-0 text-kumo-inactive" />
                    )}
                  </DropdownMenu.Item>
                </DropdownMenu.Content>
              </DropdownMenu>
              {isAgentActive && onStop ? (
                <WorkshopIconButton
                  onClick={onStop}
                  tone="primary"
                  className="!h-8 !w-8"
                  aria-label="Stop agent"
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <rect x="5" y="5" width="14" height="14" rx="2" />
                  </svg>
                </WorkshopIconButton>
              ) : (
                <WorkshopIconButton
                  onClick={submitMessage}
                  disabled={!canSend}
                  tone="primary"
                  className="!h-8 !w-8 disabled:cursor-not-allowed disabled:opacity-30"
                  aria-label="Send message"
                >
                  {/* Arrow-up icon */}
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                  >
                    <line x1="12" y1="19" x2="12" y2="5" />
                    <polyline points="5 12 12 5 19 12" />
                  </svg>
                </WorkshopIconButton>
              )}
          </div>
        </div>
      </div>

      <GatekeeperModal
        open={attachModalOpen}
        onClose={() => setAttachModalOpen(false)}
        getOverseer={getOverseer}
        onCreated={handleAttachCreated}
      />
    </div>
  );
};

// Helper to compute the state of messages (merged/reverted status and active changes)
interface MessageState {
  // Map from sequence number to status for change messages
  changeStatus: Map<number, "pending" | "merged" | "reverted">;

  // Map from merge/revert sequence to the timestamp they reference
  mergeTimestamps: Map<number, Date>; // sequence -> timestamp of merged-through message
  revertTimestamps: Map<number, Date>; // sequence -> timestamp of reverted-from message

  // The accumulated unmerged/unreverted changes (for the proposed changes view). An entry's
  // `update` is absent for batches that record only gadget creations/binding additions; such
  // batches still count as proposed changes (they are accepted and reverted like code edits).
  activeChanges: { sequence: number; update?: Uint8Array }[];
}

type ChatDisplayEntry =
  | {
      // Announces a compaction. Sits at the user's request when one produced it -- carrying who
      // asked, since the row reads as their action -- and at the cut otherwise.
      type: "compactionBoundary";
      key: string;
      boundary: CompactionBoundary;
      requestedBy?: AiChatAuthorInfo;
      // How much of the thread the cut spared, counted in rows between it and this announcement.
      keptRows?: number;
    }
  | {
      // Where the messages the agent still holds verbatim begin, for a boundary announced further
      // down. Shown only while that summary is open, so the two halves are read together.
      type: "compactionCut";
      key: string;
      boundary: CompactionBoundary;
    }
  | {
      type: "modelChange";
      key: string;
      author: AiChatAuthorInfo;
      sequence: number;
    }
  | {
      type: "message";
      key: string;
      message: AiChatMessage;
      slashCommand?: Extract<AiChatMessage, {type: "slashCommand"}>;
      toolCalls?: AiToolCall[];
      toolCallGroups?: ToolCallGroup[];
      lastMessageSequence?: number;
    }
  | {
      type: "workRun";
      key: string;
      toolCalls: AiToolCall[];
      observations: ObservationChatMessage[];
      toolCallGroups: ToolCallGroup[];
      lastMessageSequence: number;
      lastMessageTimestamp: Date;
    }
  | {
      type: "savedChanges";
      key: string;
      message: ChangeChatMessage;
    };

function isObservationActionMessage(msg: AiChatMessage): msg is ObservationChatMessage {
  return msg.type === "action" && msg.actionLog?.type === "observation";
}

type WorkMessageParts = {
  toolCalls: AiToolCall[];
  observations: ObservationChatMessage[];
  lastAgentMessageSequence: number | null;
  lastWorkSequence: number;
  lastWorkTimestamp: Date;
};

function isAssistantMessageWithoutVisibleText(msg: AiChatMessage): msg is Extract<AiChatMessage, { type: "message" }> {
  return (
    msg.type === "message" &&
    msg.author.type !== "user" &&
    !msg.message.trim() &&
    !msg.reasoning?.trim()
  );
}

// Tool-only turns can leave behind empty assistant messages. Don't render them as transcript rows.
function isEmptyAssistantMessage(msg: AiChatMessage): boolean {
  return isAssistantMessageWithoutVisibleText(msg) && (!msg.toolCalls || msg.toolCalls.length === 0);
}

// Assistant messages with tool calls but no text are displayed as work rows.
function getWorkOnlyMessageParts(msg: AiChatMessage): WorkMessageParts | null {
  if (isObservationActionMessage(msg)) {
    return {
      toolCalls: [],
      observations: [msg],
      lastAgentMessageSequence: null,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  if (
    isAssistantMessageWithoutVisibleText(msg) &&
    !!msg.toolCalls &&
    msg.toolCalls.length > 0
  ) {
    return {
      toolCalls: msg.toolCalls,
      observations: [],
      lastAgentMessageSequence: msg.sequence,
      lastWorkSequence: msg.sequence,
      lastWorkTimestamp: msg.timestamp,
    };
  }

  return null;
}

function appendWorkParts(target: WorkMessageParts, source: WorkMessageParts) {
  target.toolCalls.push(...source.toolCalls);
  target.observations.push(...source.observations);
  target.lastWorkSequence = source.lastWorkSequence;
  target.lastWorkTimestamp = source.lastWorkTimestamp;
  if (source.lastAgentMessageSequence !== null) {
    target.lastAgentMessageSequence = source.lastAgentMessageSequence;
  }
}

// Suffix appended to discard labels when the discarded changes include gadget creations, since
// reverting also deletes the created gadgets.
function describeCreatedGadgetDeletion(titles: string[] | undefined): string {
  if (!titles || titles.length === 0) return "";
  const names = titles.map((t) => `“${t}”`).join(", ");
  return ` (deletes ${titles.length === 1 ? "gadget" : "gadgets"} ${names})`;
}

// Label for the per-turn discard-changes button.
function getDiscardLabel(
  isTrailing: boolean | undefined,
  createdGadgetTitles?: string[],
): string {
  const base = isTrailing
    ? "Discard changes from this response"
    : "Discard changes from this response and later responses";
  return base + describeCreatedGadgetDeletion(createdGadgetTitles);
}

function getSavedEditsDiscardLabel(
  isTrailing: boolean | undefined,
  createdGadgetTitles?: string[],
): string {
  const base = isTrailing
    ? "Discard saved edits"
    : "Discard saved edits and later changes";
  return base + describeCreatedGadgetDeletion(createdGadgetTitles);
}

function DiscardPendingChangesPopover({
  open,
  disabled,
  isDiscarding,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  disabled: boolean;
  isDiscarding: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger
        render={
          <button
            type="button"
            disabled={disabled}
            className="inline-flex h-[30px] cursor-pointer items-center justify-center rounded-md border border-kumo-fill bg-kumo-base px-2.5 text-[12px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Discard…
          </button>
        }
      />
      <Popover.Content
        align="center"
        side="top"
        sideOffset={8}
        positionMethod="fixed"
        className="themed-floating-shadow !z-[1100] !w-[min(300px,calc(100vw-24px))] !min-w-0 overflow-hidden rounded-xl border border-kumo-line bg-kumo-base !p-0 !outline-none [&>:first-child]:hidden"
      >
        <div className="px-3.5 pb-2.5 pt-3">
          <Popover.Title className="text-[13px] font-medium leading-[18px] tracking-[-0.25px] text-kumo-default">
            Discard all pending changes?
          </Popover.Title>
          <p className="mt-0.5 text-[11.5px] leading-4 tracking-[-0.15px] text-kumo-subtle">
            Return to the last accepted version. Any gadgets created by these changes will be
            permanently deleted. Pending changes can&apos;t be restored.
          </p>
          <p className="mt-2 border-t border-kumo-line pt-2 text-[11px] leading-[15px] tracking-[-0.1px] text-kumo-inactive">
            Use the <ArrowUUpLeft size={12} className="mx-0.5 inline-block align-[-2px]" aria-hidden="true" /><span className="sr-only">undo arrow</span> under any agent response to discard from that turn onward.
          </p>
        </div>
        <div className="flex items-center justify-end gap-0.5 border-t border-kumo-line px-2 py-1.5">
          <button
            type="button"
            disabled={isDiscarding}
            onClick={() => onOpenChange(false)}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-inactive transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-default focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            Cancel
          </button>
          <button
            type="button"
            disabled={disabled || isDiscarding}
            onClick={onConfirm}
            className="flex h-6 cursor-pointer items-center rounded-md px-2 text-[12px] font-medium tracking-[-0.15px] text-kumo-default transition-colors enabled:hover:bg-kumo-tint enabled:hover:text-kumo-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring disabled:cursor-not-allowed disabled:opacity-40"
          >
            {isDiscarding ? "Discarding..." : "Discard changes"}
          </button>
        </div>
      </Popover.Content>
    </Popover>
  );
}

// Collapse adjacent work rows; fold trailing work into the preceding assistant
// message so one turn reads as one tool/resource run.
function transcriptToolCalls(toolCalls: AiToolCall[]): AiToolCall[] {
  // Successful creations render as cards; failed calls retain their error summary.
  return toolCalls.filter((tc) =>
    tc.toolName !== "createGadget" || tc.output === undefined || Boolean(tc.error));
}

export function buildChatDisplayEntries(
  messages: AiChatMessage[],
  changeStatus: ReadonlyMap<number, "pending" | "merged" | "reverted">,
  // Loaded compaction boundaries, oldest first.
  boundaries: readonly CompactionBoundary[] = [],
  outputOf?: ToolOutputResolver,
): ChatDisplayEntry[] {
  const result: ChatDisplayEntry[] = [];
  let lastAgentAuthorId: string | null = null;

  // Where each boundary is announced. A cut is chosen to leave a working tail, so it lands some way
  // back from where the user typed `/compact` -- announcing it there would drop the acknowledgement
  // off screen. So a boundary is announced at the request that produced it: the `/compact` between
  // this cut and the next, since a later request can only produce a later cut. Compaction that ran
  // on its own has no request to announce at, and is announced at the cut.
  const requestFor = new Map<number, number>();
  boundaries.forEach((boundary, index) => {
    const until = boundaries[index + 1]?.to ?? Infinity;
    const request = messages.find(msg => msg.sequence >= boundary.to && msg.sequence < until &&
        msg.type === "slashCommand" && msg.request.id.builtin === true);
    if (request) requestFor.set(boundary.to, request.sequence);
  });

  // Where each cut was drawn, so the announcement can say how much of the thread survived it. Rows
  // rather than records, since rows are what the reader can count against.
  const rowsAtCut = new Map<number, number>();

  let nextBoundary = 0;
  const maybePushBoundaries = (sequence: number) => {
    while (nextBoundary < boundaries.length && boundaries[nextBoundary].to <= sequence) {
      const boundary = boundaries[nextBoundary++];
      rowsAtCut.set(boundary.to, result.length);
      // Announced at a request further down, so all that belongs here is the line showing where the
      // messages the agent still holds verbatim begin -- revealed only while the summary is open.
      result.push(requestFor.has(boundary.to)
        ? {type: "compactionCut", key: `cut-${boundary.to}`, boundary}
        : {type: "compactionBoundary", key: `compacted-${boundary.to}`, boundary});
    }
  };

  const maybePushModelChange = (msg: AiChatMessage) => {
    if (msg.type !== "message" || msg.author.type !== "agent" || isEmptyAssistantMessage(msg)) return;
    if (lastAgentAuthorId === null) {
      lastAgentAuthorId = msg.author.id;
      return;
    }
    if (msg.author.id === lastAgentAuthorId) return;
    lastAgentAuthorId = msg.author.id;
    result.push({
      type: "modelChange",
      key: `model-${msg.chatId}-${msg.sequence}`,
      author: msg.author,
      sequence: msg.sequence,
    });
  };

  const isVisibleSavedChangesMessage = (msg: AiChatMessage): msg is ChangeChatMessage =>
    msg.type === "changes" &&
    msg.author.type === "user" &&
    (changeStatus.get(msg.sequence) ?? "pending") === "pending";

  for (let i = 0; i < messages.length; ) {
    const msg = messages[i];
    maybePushBoundaries(msg.sequence);
    maybePushModelChange(msg);

    if (msg.type === "slashCommand") {
      // A built-in command is handled by the Workshop itself, so it has no prompt to show and gets
      // no provider reply. What it leaves behind is its boundary, announced here. A request that
      // compacted nothing has no boundary and so shows nothing, which is what happened.
      if (msg.request.id.builtin === true) {
        const announced = boundaries.find(({to}) => requestFor.get(to) === msg.sequence);
        if (announced) {
          // Everything between the cut and here survived: the tail the agent kept reading verbatim.
          // The cut's own row does not count towards it.
          const atCut = rowsAtCut.get(announced.to);
          result.push({
            type: "compactionBoundary",
            key: `compacted-${announced.to}`,
            boundary: announced,
            requestedBy: msg.author,
            keptRows: atCut === undefined ? 0 : result.length - atCut - 1,
          });
        }
        i++;
        continue;
      }
      let next = messages[i + 1];
      if (next?.type === "message" && next.generatedBySlashCommandSequence === msg.sequence) {
        result.push({
          type: "message",
          key: `slash-${msg.chatId}-${msg.sequence}`,
          message: next,
          slashCommand: msg,
        });
        i += 2;
      } else {
        result.push({
          type: "message",
          key: `slash-${msg.chatId}-${msg.sequence}`,
          message: msg,
          slashCommand: msg,
        });
        i++;
      }
      continue;
    }

    if (msg.type === "changes") {
      if (isVisibleSavedChangesMessage(msg)) {
        result.push({
          type: "savedChanges",
          key: `saved-changes-${msg.chatId}-${msg.sequence}`,
          message: msg,
        });
      }
      i++;
      continue;
    }

    if (isEmptyAssistantMessage(msg)) {
      i++;
      continue;
    }

    const initialWorkParts = getWorkOnlyMessageParts(msg);
    if (initialWorkParts) {
      const workParts: WorkMessageParts = {
        toolCalls: [...initialWorkParts.toolCalls],
        observations: [...initialWorkParts.observations],
        lastAgentMessageSequence: initialWorkParts.lastAgentMessageSequence,
        lastWorkSequence: initialWorkParts.lastWorkSequence,
        lastWorkTimestamp: initialWorkParts.lastWorkTimestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (isVisibleSavedChangesMessage(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      result.push({
        type: "workRun",
        key: `work-${msg.chatId}-${msg.sequence}`,
        toolCalls: workParts.toolCalls,
        observations: workParts.observations,
        toolCallGroups: buildToolCallGroups(
          transcriptToolCalls(workParts.toolCalls),
          workParts.observations,
          outputOf,
        ),
        lastMessageSequence: workParts.lastAgentMessageSequence ?? workParts.lastWorkSequence,
        lastMessageTimestamp: workParts.lastWorkTimestamp,
      });

      i = j;
      continue;
    }

    if (msg.type === "message" && msg.author.type !== "user") {
      const workParts: WorkMessageParts = {
        toolCalls: msg.toolCalls ? [...msg.toolCalls] : [],
        observations: [],
        lastAgentMessageSequence: msg.sequence,
        lastWorkSequence: msg.sequence,
        lastWorkTimestamp: msg.timestamp,
      };
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        if (nextMsg.type === "changes") {
          if (isVisibleSavedChangesMessage(nextMsg)) break;
          j++;
          continue;
        }
        const nextWorkParts = getWorkOnlyMessageParts(nextMsg);
        if (!nextWorkParts) break;
        appendWorkParts(workParts, nextWorkParts);
        j++;
      }

      if (workParts.toolCalls.length > 0 || workParts.observations.length > 0) {
        result.push({
          type: "message",
          key: `msg-${msg.chatId}-${msg.sequence}`,
          message: msg,
          toolCalls: workParts.toolCalls,
          toolCallGroups: buildToolCallGroups(
            transcriptToolCalls(workParts.toolCalls),
            workParts.observations,
            outputOf,
          ),
          lastMessageSequence: workParts.lastAgentMessageSequence ?? msg.sequence,
        });
        i = j;
        continue;
      }
    }

    result.push({
      type: "message",
      key: `msg-${msg.chatId}-${msg.sequence}`,
      message: msg,
    });
    i++;
  }

  return result;
}

// Transcript spacing helpers.

function isUserMessageEntry(entry: ChatDisplayEntry): boolean {
  return (
    entry.type === "message" &&
    (entry.message.type === "slashCommand" ||
      (entry.message.type === "message" && entry.message.author.type === "user"))
  );
}

// How close to the top of the transcript pulls in the previous page. Roughly a screenful of slack,
// so the messages are there by the time the user scrolls to them.
const EARLIER_PAGE_PREFETCH_PX = 600;

function isPureWorkRowEntry(entry: ChatDisplayEntry): boolean {
  if (entry.type === "workRun") return true;
  if (entry.type === "modelChange" || entry.type === "compactionBoundary" ||
      entry.type === "compactionCut") return false;
  const m = entry.message;
  return (
    m.type === "action" ||
    m.type === "useGadget" ||
    m.type === "agentCallback" ||
    m.type === "merge" ||
    m.type === "revert"
  );
}

// Assistant messages with grouped work visually end in work rows.
function entryEndsInWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  return entry.toolCallGroups !== undefined && entry.toolCallGroups.length > 0;
}

function entryStartsWithWorkRow(entry: ChatDisplayEntry): boolean {
  if (isPureWorkRowEntry(entry)) return true;
  if (entry.type !== "message") return false;
  const m = entry.message;
  return (
    m.type === "message" &&
    m.author.type !== "user" &&
    !m.message &&
    entry.toolCallGroups !== undefined &&
    entry.toolCallGroups.length > 0
  );
}

function rhythmTopClass(
  prev: ChatDisplayEntry | null,
  curr: ChatDisplayEntry,
): string {
  if (!prev) return "";
  if (curr.type === "modelChange") return "mt-4";
  if (prev.type === "modelChange") return "mt-2";
  if (isUserMessageEntry(prev) || isUserMessageEntry(curr)) return "mt-5";
  if (entryEndsInWorkRow(prev) && entryStartsWithWorkRow(curr)) return "mt-2";
  return "mt-4";
}

export function computeMessageStates(
  messages: AiChatMessage[],
  // Compaction boundary bounding the oldest loaded page, if the chat has one.
  compacted?: CompactionBoundary,
): MessageState {
  const changeStatus = new Map<number, "pending" | "merged" | "reverted">();
  const mergeTimestamps = new Map<number, Date>();
  const revertTimestamps = new Map<number, Date>();

  // Track active updates as we scan (for proposed changes computation)
  let updates: { sequence: number; update?: Uint8Array }[] = [];

  // The boundary carries the still-proposed pre-boundary changes merged into one update. Fold it
  // in at the last pre-boundary sequence, so it counts as proposed and a later merge or revert
  // reaching across the boundary still resolves it. Skipped once the page before the boundary has
  // loaded, since its own "changes" messages would then count the same edits again.
  //
  // Only the bytes appear here, because that is all these entries are read for: reconstructing the
  // proposed code. A prefix that only created gadgets carries none, and stays reachable through the
  // server's own cut -- see the accept-changes banner.
  if (
    compacted?.proposedChanges !== undefined &&
    (messages.length === 0 || messages[0].sequence >= compacted.to)
  ) {
    updates.push({ sequence: compacted.to - 1, update: compacted.proposedChanges });
  }

  for (let msg of messages) {
    if (msg.type === "changes") {
      updates.push({ sequence: msg.sequence, update: msg.update });
      changeStatus.set(msg.sequence, "pending");
    } else if (msg.type === "merge") {
      // Mark changes as merged and drop from active set
      while (updates.length > 0 && updates[0].sequence <= msg.mergeThrough) {
        const merged = updates.shift()!;
        changeStatus.set(merged.sequence, "merged");
      }
      // Find timestamp for the merged-through message
      const refMsg = messages.find((m) => m.sequence === msg.mergeThrough);
      if (refMsg) {
        mergeTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    } else if (msg.type === "revert") {
      // Mark changes as reverted and drop from active set
      while (
        updates.length > 0 &&
        updates[updates.length - 1].sequence >= msg.revertFrom
      ) {
        const reverted = updates.pop()!;
        changeStatus.set(reverted.sequence, "reverted");
      }
      // Find timestamp for the reverted-from message
      const refMsg = messages.find((m) => m.sequence === msg.revertFrom);
      if (refMsg) {
        revertTimestamps.set(msg.sequence, refMsg.timestamp);
      }
    }
  }

  return {
    changeStatus,
    mergeTimestamps,
    revertTimestamps,
    activeChanges: updates,
  };
}

function inferSelectedModelFromMessages(messages: AiChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];

    if (msg.type === "error") {
      if (msg.author.type === "agent") {
        return msg.author.id;
      }
      continue;
    }

    if (msg.type === "message") {
      return msg.author.type === "agent" ? msg.author.id : null;
    }
  }

  return null;
}

function fallbackToStoredModelSelection(
  modelId: string | null,
  availableModels: AiChatAuthorInfo[],
): string | null {
  if (modelId !== null || availableModels.length > 0) {
    return modelId;
  }

  return getStoredSelectedModel(availableModels);
}

interface ChatInterfaceProps {
  overseer: RpcStub<Overseer>;
  selectedChatId: number | null;
  onNavigateToChat: (
    chatId: number | null,
    options?: { replace?: boolean },
  ) => void;
  onProposedChangesChange?: (proposedChanges: Uint8Array | undefined) => void;
  onDraftProposedChangesChange?: (
    updates: StreamingProposedChanges | undefined,
  ) => void;
  onStreamingProposedChangesChange?: (
    updates: StreamingProposedChanges | undefined,
  ) => void;
  onStreamingActiveFileChange?: (chatId: number, file: ActiveFileTarget | null | undefined) => void;
  pendingConsoleLogCount: number;
  consoleLogPreview: string;
  consoleLogSeverity: "error" | "warn" | "info";
  onConsumeConsoleLogs: () => string;
  onDiscardConsoleLogs: () => void;
  onChatCountChange?: (count: number, hasChatZero: boolean) => void;
  onAgentActiveChange?: (chatId: number, isActive: boolean) => void;
  // Called after an auto-approval rule is enabled from the chat thread, so the Activity pane's
  // Auto-approval list reflects it without a reload.
  onAutoApproveChange?: () => void;
  sidebarMode?: boolean;
  sidebarWidth?: number;
  onSidebarResize?: (width: number) => void;
  renderExtraTab?: () => React.ReactNode;
  onHasAnyCodeChange?: (hasAnyCode: boolean) => void;
  onSelectedChatHasProposedChangesChange?: (hasProposedChanges: boolean) => void;
  constrainChatWidth?: boolean;
  onOpenGadget: (gadgetId: WorkpieceId) => void;

  // The output format a workpiece was built as, so a created-app card can name and draw it as the
  // Document (or whatever) it is rather than a generic app.
  outputOfWorkpiece: (gadgetId: WorkpieceId) => BlueprintOutput | undefined;
}

// Bucket a chat's lastActive into a time grouping for the chat list.
type ChatTimeBucket = "today" | "yesterday" | "thisWeek" | "earlier";

const CHAT_TIME_BUCKET_LABELS: Record<ChatTimeBucket, string> = {
  today: "Today",
  yesterday: "Yesterday",
  thisWeek: "Earlier this week",
  earlier: "Earlier",
};
const CHAT_TIME_BUCKET_ORDER: ChatTimeBucket[] = [
  "today",
  "yesterday",
  "thisWeek",
  "earlier",
];

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function getChatTimeBucket(date: Date, now: Date): ChatTimeBucket {
  const diffDays = Math.round(
    (startOfDay(now).getTime() - startOfDay(date).getTime()) / 86_400_000,
  );
  if (diffDays <= 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return "thisWeek";
  return "earlier";
}

// Format a chat's lastActive for display in a row, given its bucket. Buckets
// own the "date" half of the label (via the section header), so rows only show
// what the header doesn't.
function formatChatRowTime(date: Date, bucket: ChatTimeBucket, now: Date): string {
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (bucket === "today" || bucket === "yesterday") {
    return time;
  }
  if (bucket === "thisWeek") {
    const day = date.toLocaleDateString([], { weekday: "short" });
    return `${day} ${time}`;
  }
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(
    [],
    sameYear
      ? { month: "short", day: "numeric" }
      : { month: "short", day: "numeric", year: "numeric" },
  );
}

// A compaction checkpoint reported with a history page.
export type CompactionBoundary = NonNullable<AiChatHistoryPage["compacted"]>;

// Client-side cache for chats and messages (survives reconnects)
interface ChatCache {
  chats: Map<number, AiChatMetadata>;
  messages: Map<number, AiChatMessage[]>;
  // Compaction boundaries seen so far for each chat, oldest first. Every loaded page contributes
  // one, so a thread compacted several times shows a marker at each cut.
  compacted: Map<number, CompactionBoundary[]>;
  actionMessages: Map<number, Map<string, { chatId: number; sequence: number }>>;
  lastMessageTimestamp: Date | null;
}

type ProvisionalToolCallState = {
  toolCallId: string;
  toolName: AiToolCall["toolName"] | null;
  // Human-readable target (e.g. filename) once known from the streaming input.
  target?: string;
  // For createGadget: what it is producing, once the server has resolved the blueprint. Tool inputs
  // aren't streamed, so this is the only way the row can name a Doc while it is still being made.
  outputFormat?: BlueprintOutput;
  code: string;
  output: string;
  finished: boolean;
};

type ProvisionalChatState = {
  text: string;
  reasoning: string;
  // The turn is summarizing older context and can't produce output until it finishes.
  compacting: boolean;
  toolCalls: ProvisionalToolCallState[];
  toolCallsById: Map<string, ProvisionalToolCallState>;
  codeUpdates: Uint8Array[];
  activeEditingFile: ActiveFileTarget | null | undefined;
};

function createProvisionalChatState(): ProvisionalChatState {
  return {
    text: "",
    reasoning: "",
    compacting: false,
    toolCalls: [],
    toolCallsById: new Map(),
    codeUpdates: [],
    activeEditingFile: undefined,
  };
}

function clearProvisionalTextState(state: ProvisionalChatState) {
  state.text = "";
  state.reasoning = "";
  state.toolCalls = [];
  state.toolCallsById.clear();
  // Note: This function only clears chat streaming state, not code streaming state. Chat streaming
  // is reset when a message arrives (once per step), whereas code streaming is reset when code
  // changes arrive (at the end of a turn).
}

function clearProvisionalCodeState(state: ProvisionalChatState) {
  state.codeUpdates = [];
  state.activeEditingFile = undefined;
}

function isProvisionalChatStateEmpty(state: ProvisionalChatState) {
  return (
    state.text === "" &&
    state.reasoning === "" &&
    !state.compacting &&
    state.toolCalls.length === 0 &&
    state.codeUpdates.length === 0 &&
    state.activeEditingFile === undefined
  );
}

function getOrCreateProvisionalToolCall(
  state: ProvisionalChatState,
  toolCallId: string,
  toolName: AiToolCall["toolName"] | null,
) {
  let toolCall = state.toolCallsById.get(toolCallId);
  if (toolCall) {
    if (toolName !== null) {
      toolCall.toolName = toolName;
    }
    return toolCall;
  }

  toolCall = {
    toolCallId,
    toolName,
    code: "",
    output: "",
    finished: false,
  };
  state.toolCallsById.set(toolCallId, toolCall);
  state.toolCalls.push(toolCall);
  return toolCall;
}

function ChatInterface({
  overseer,
  selectedChatId,
  onNavigateToChat,
  onProposedChangesChange,
  onDraftProposedChangesChange,
  onStreamingProposedChangesChange,
  onStreamingActiveFileChange,
  pendingConsoleLogCount,
  consoleLogPreview,
  consoleLogSeverity,
  onConsumeConsoleLogs,
  onDiscardConsoleLogs,
  onChatCountChange,
  onAgentActiveChange,
  onAutoApproveChange,
  sidebarMode,
  sidebarWidth = 280,
  onSidebarResize,
  renderExtraTab,
  onHasAnyCodeChange,
  onSelectedChatHasProposedChangesChange,
  constrainChatWidth,
  onOpenGadget,
  outputOfWorkpiece,
}: ChatInterfaceProps) {
  // Persistent cache that survives reconnects
  const toasts = useKumoToastManager();
  const { currentUser } = useAuthenticatedApi();
  const getOverseer = useCallback(() => overseer, [overseer]);
  const cacheRef = useRef<ChatCache>({
    chats: new Map(),
    messages: new Map(),
    compacted: new Map(),
    actionMessages: new Map(),
    lastMessageTimestamp: null,
  });
  const provisionalRef = useRef<Map<number, ProvisionalChatState>>(new Map());
  const draftRef = useRef<Map<number, DraftChatState>>(new Map());
  // Last server-instance generation seen (survives reconnects). Used to detect a full DO restart,
  // in which case in-flight provisional streams were lost and must be discarded. See
  // AiChatSubscriber.streamGeneration.
  const lastStreamGenerationRef = useRef<number | undefined>(undefined);

  // UI state
  const [_isSubscribed, setIsSubscribed] = useState(false);
  const [chatListReady, setChatListReady] = useState(false);
  // Out-of-credits modal (free-tier limit reached). `usageModalShownFor` tracks the error sequence
  // we've already auto-opened for, so dismissing it doesn't immediately reopen.
  const [usageModalOpen, setUsageModalOpen] = useState(false);
  const usageModalShownForRef = useRef<number | null>(null);
  const [chatListScope, setChatListScope] = useState<ChatListScope>("all");
  const [chatListVersion, setChatListVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);
  // Fetching the page before the selected chat's compaction boundary.
  const [isLoadingEarlier, setIsLoadingEarlier] = useState(false);
  const [updateCounter, setUpdateCounter] = useState(0); // Force re-render when cache updates
  const [proposedChangesVersion, setProposedChangesVersion] = useState(0); // Incremented only for change-affecting messages
  const [draftChangesVersion, setDraftChangesVersion] = useState(0);
  const [isEditingTitle, setIsEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [renamingChatId, setRenamingChatId] = useState<number | null>(null);
  const renamingChatIdRef = useRef<number | null>(null);
  const [renamingInput, setRenamingInput] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<{
    id: number;
    title: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [discardChangesTarget, setDiscardChangesTarget] = useState<{
    chatId: number;
  } | null>(null);
  const [discardingChangesChatIds, setDiscardingChangesChatIds] = useState(
    () => new Set<number>(),
  );

  const [expandedToolCalls, setExpandedToolCalls] = useState<Set<string>>(
    new Set(),
  );
  const [showThinkingTraces, setShowThinkingTraces] = useState(
    () => getStoredShowThinkingTraces(),
  );
  const [expandedActions, setExpandedActions] = useState<Set<number>>(
    new Set(),
  );
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());
  const [expandedCompactions, setExpandedCompactions] = useState<Set<number>>(new Set());
  const [processingActions, setProcessingActions] = useState<Set<number>>(
    new Set(),
  );
  // Connection-request (agent requestConnection) accept flow. When set, the GatekeeperModal opens
  // pre-seeded with the agent's vendor/resource; on creation we finalize acceptConnectionRequest.
  const [connectionAccept, setConnectionAccept] = useState<{
    requestId: string;
    vendorId: string;
    resourceUrl?: string;
    resourceUrlPattern?: string;
  } | null>(null);
  // Read via this ref inside handleConnectionCreated to avoid a stale closure: that callback is
  // passed as the `onCreated` prop to GatekeeperModal, so it would otherwise capture an outdated
  // `connectionAccept`.
  const connectionAcceptRef = useRef<typeof connectionAccept>(null);
  connectionAcceptRef.current = connectionAccept;
  const [processingConnections, setProcessingConnections] = useState<Set<string>>(
    new Set(),
  );
  const [availableModels, setAvailableModels] = useState<AiChatAuthorInfo[]>(
    [],
  );
  const [selectedModel, setSelectedModel] = useState<string | null>(null);
  const [sidebarActiveTab, setSidebarActiveTab] = useState<
    "chat" | "connections"
  >("chat");
  const [isSidebarResizing, setIsSidebarResizing] = useState(false);

  // Sidebar resize handling.
  //
  // We use Pointer Events with setPointerCapture rather than global mousemove/
  // mouseup listeners. The gadget runs in an iframe; if the user drags the
  // resize handle and the cursor crosses into the iframe, the iframe captures
  // mouse events and the parent window never receives mouseup. The drag would
  // then "stick" to the cursor even after release. Pointer capture routes all
  // pointermove/pointerup events to the handle until release, regardless of
  // what's under the cursor — including iframes.
  const handleSidebarPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      setIsSidebarResizing(true);
    },
    [],
  );
  const handleSidebarPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
      const newWidth = Math.max(200, Math.min(500, e.clientX));
      onSidebarResize?.(newWidth);
    },
    [onSidebarResize],
  );
  const handleSidebarPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      setIsSidebarResizing(false);
    },
    [],
  );

  const indexActionMessage = (msg: AiChatMessage) => {
    if (msg.type !== "action") return;
    let locations = cacheRef.current.actionMessages.get(msg.actionId);
    if (!locations) {
      locations = new Map();
      cacheRef.current.actionMessages.set(msg.actionId, locations);
    }
    locations.set(`${msg.chatId}:${msg.sequence}`, {
      chatId: msg.chatId,
      sequence: msg.sequence,
    });
  };

  const removeChatFromActionMessageIndex = (chatId: number) => {
    for (const [actionId, locations] of cacheRef.current.actionMessages) {
      for (const [key, location] of locations) {
        if (location.chatId === chatId) locations.delete(key);
      }
      if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    }
  };

  // Fold one history page into the cache. Messages are stored at their sequence index, so filling
  // in an older page and re-receiving a message the subscription already delivered are both
  // harmless. The page's boundary joins the ones already known, keyed by its cut so the same page
  // fetched twice contributes one marker.
  const cacheHistoryPage = (chatId: number, page: AiChatHistoryPage) => {
    let messages = cacheRef.current.messages.get(chatId);
    if (!messages) {
      messages = [];
      cacheRef.current.messages.set(chatId, messages);
    }

    for (const msg of page.messages) {
      messages[msg.sequence] = msg;
      indexActionMessage(msg);
    }

    if (page.compacted) {
      let boundaries = cacheRef.current.compacted.get(chatId) ?? [];
      cacheRef.current.compacted.set(chatId, [
        ...boundaries.filter(({to}) => to !== page.compacted!.to), page.compacted,
      ].toSorted((a, b) => a.to - b.to));
    }
  };

  // Held in a ref for the same reason as `refreshBoundaryRef` below: the subscriber outlives the
  // render that created it, and the toast manager is a fresh object each render.
  const toastsRef = useRef(toasts);
  toastsRef.current = toasts;

  // Refetches a loaded chat's newest page. Held in a ref because the chat subscriber is constructed
  // once, while `overseer` and `cacheHistoryPage` are recreated each render.
  const refreshBoundaryRef = useRef<(chatId: number) => void>(() => {});
  refreshBoundaryRef.current = (chatId: number) => {
    void (async () => {
      try {
        cacheHistoryPage(chatId, await overseer.getChatHistory(chatId));
        forceUpdate();
      } catch (err) {
        reportIssue("chat.compaction-boundary-refresh", err, {handled: true});
      }
    })();
  };

  // Apply page-level cursor + user-select only while a resize is in progress.
  useEffect(() => {
    if (!isSidebarResizing) return;
    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isSidebarResizing]);

  // Refs for accessing current values in subscriber callbacks
  const selectedChatIdRef = useRef<number | null>(null);
  const onNavigateToChatRef = useRef(onNavigateToChat);
  onNavigateToChatRef.current = onNavigateToChat;

  // Subscription stub (wrapped in object for useState)
  const subscriptionRef = useRef<RpcStub<{}> | null>(null);

  // Ref for auto-scrolling messages
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isScrolledToBottomRef = useRef(true);

  const scrollMessagesToBottom = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
  }, []);

  // Force a re-render when cache is updated
  const forceUpdate = () => setUpdateCounter((prev) => prev + 1);
  const bumpChatListVersion = () => setChatListVersion((prev) => prev + 1);

  // Batched version of forceUpdate for high-frequency stream events.
  // Coalesces multiple updates within a single animation frame.
  const pendingUpdateRef = useRef(false);
  const scheduleUpdate = () => {
    if (!pendingUpdateRef.current) {
      pendingUpdateRef.current = true;
      requestAnimationFrame(() => {
        pendingUpdateRef.current = false;
        forceUpdate();
      });
    }
  };

  // Get sorted list of chats from cache
  const chatList = useMemo(
    () => Array.from(cacheRef.current.chats.values()).sort(
      (a, b) => b.lastActive.getTime() - a.lastActive.getTime(),
    ),
    [chatListVersion],
  );
  const {
    visibleChatList,
    chatListNow,
    bucketedVisibleChats,
    chatListScopes,
  } = useMemo(() => {
    const directCount = chatList.filter((chat) => !chat.spawnerName).length;
    const agentCount = chatList.length - directCount;
    const visible = chatList.filter((chat) => {
      if (chatListScope === "direct") return !chat.spawnerName;
      if (chatListScope === "agents") return Boolean(chat.spawnerName);
      return true;
    });
    const now = new Date();
    const buckets = new Map<ChatTimeBucket, AiChatMetadata[]>();
    for (const chat of visible) {
      const bucket = getChatTimeBucket(chat.lastActive, now);
      let arr = buckets.get(bucket);
      if (!arr) {
        arr = [];
        buckets.set(bucket, arr);
      }
      arr.push(chat);
    }

    return {
      visibleChatList: visible,
      chatListNow: now,
      bucketedVisibleChats: CHAT_TIME_BUCKET_ORDER.flatMap((bucket) => {
        const items = buckets.get(bucket);
        if (!items || items.length === 0) return [];
        return [{ bucket, items }];
      }),
      chatListScopes: [
        { value: "all" as const, count: chatList.length },
        { value: "direct" as const, count: directCount },
        { value: "agents" as const, count: agentCount },
      ],
    };
  }, [chatList, chatListScope]);

  // Notify parent when chat list changes. Gated on chatListReady so that we
  // don't report 0 from the empty initial cache before listChats() has completed.
  const onChatCountChangeRef = useRef(onChatCountChange);
  onChatCountChangeRef.current = onChatCountChange;
  const hasChatZero = cacheRef.current.chats.has(0);
  useEffect(() => {
    if (chatListReady) {
      onChatCountChangeRef.current?.(chatList.length, hasChatZero);
    }
  }, [chatList.length, chatListReady, hasChatZero]);

  // Notify parent when any chat has proposed changes (code written but not merged).
  const onHasAnyCodeChangeRef = useRef(onHasAnyCodeChange);
  onHasAnyCodeChangeRef.current = onHasAnyCodeChange;
  const anyHasProposedChanges = chatList.some(c => c.hasProposedChanges);
  useEffect(() => {
    if (chatListReady) {
      onHasAnyCodeChangeRef.current?.(anyHasProposedChanges);
    }
  }, [anyHasProposedChanges, chatListReady]);

  // In sidebar mode, auto-select the most recent chat when none is selected.
  useEffect(() => {
    if (
      sidebarMode &&
      selectedChatId === null &&
      chatListReady &&
      chatList.length > 0
    ) {
      onNavigateToChatRef.current(chatList[0].id, { replace: true });
    }
  }, [sidebarMode, selectedChatId, chatListReady, chatList]);

  // Get messages for selected chat (filter out any undefined slots in sparse array)
  // Memoized to prevent creating new array on every render
  const currentMessages = useMemo(() => {
    if (selectedChatId === null) return [];
    return (cacheRef.current.messages.get(selectedChatId) || []).filter(
      (msg) => msg !== undefined,
    );
  }, [selectedChatId, updateCounter]);
  const currentCompactions = useMemo(() => {
    if (selectedChatId === null) return [];
    return cacheRef.current.compacted.get(selectedChatId) ?? [];
  }, [selectedChatId, updateCounter]);
  const messageStates = useMemo(
    // The oldest boundary is the one whose proposed changes no loaded message accounts for.
    () => computeMessageStates(currentMessages, currentCompactions[0]),
    [currentMessages, currentCompactions],
  );
  // A pending agent connection request blocks the composer: the user must accept ("Set up") or deny
  // it before continuing the conversation.
  const hasPendingConnectionRequest = useMemo(
    () => currentMessages.some(
      (msg) => msg.type === "connectionRequest" && msg.state === "pending",
    ),
    [currentMessages],
  );
  // A pending awaitDecision action also blocks the composer: the agent turn is suspended until the
  // user approves or rejects it, so (like a connection request) further input must wait.
  const hasPendingAwaitedAction = useMemo(
    () => currentMessages.some(
      (msg) => msg.type === "action" &&
        msg.actionLog?.type === "action" &&
        msg.actionLog.state === "pending" &&
        msg.actionLog.description.awaitDecision === true,
    ),
    [currentMessages],
  );
  // A gadget's stamped format, looked up by the id a finished createGadget call reports, so the
  // transcript can say "Created Doc" with the Doc icon.
  const resolveToolOutput = useCallback(
    (tc: AiToolCall) => resolveToolCallOutput(tc, outputOfWorkpiece),
    [outputOfWorkpiece],
  );

  const displayEntries = useMemo(
    () =>
      // Hide agent checkpoints; surface them as turn-level discard actions. User-saved
      // checkpoints get their own compact row so the discard action is attached to the
      // edit that actually created it.
      buildChatDisplayEntries(
          currentMessages, messageStates.changeStatus, currentCompactions, resolveToolOutput),
    [currentMessages, messageStates, currentCompactions, resolveToolOutput],
  );

  const entryTopClasses = useMemo(() => {
    const out: string[] = Array.from({ length: displayEntries.length });
    for (let i = 0; i < displayEntries.length; i++) {
      out[i] = rhythmTopClass(i > 0 ? displayEntries[i - 1] : null, displayEntries[i]);
    }
    return out;
  }, [displayEntries]);

  // Hide the user name on user message rows when the only human in the chat is the
  // currently-logged-in user (it would just say "you" on every message). If anyone else has ever
  // posted in this chat, names stay so it's clear who said what.
  const hideOwnUserName = useMemo(() => {
    if (!currentUser) return false;
    let sawSelf = false;
    for (const msg of currentMessages) {
      if (msg.type !== "message" || msg.author.type !== "user") continue;
      if (msg.author.id !== currentUser.id) return false;
      sawSelf = true;
    }
    return sawSelf;
  }, [currentMessages, currentUser]);

  const lastMessageSequence = currentMessages[currentMessages.length - 1]?.sequence;

  // Auto-open the out-of-credits modal once when the latest message is a usage-limit error.
  const lastMessage = currentMessages[currentMessages.length - 1];
  useEffect(() => {
    if (
      lastMessage &&
      lastMessage.type === "error" &&
      lastMessage.code === "usage_limit" &&
      usageModalShownForRef.current !== lastMessage.sequence
    ) {
      usageModalShownForRef.current = lastMessage.sequence;
      setUsageModalOpen(true);
    }
  }, [lastMessage]);

  // Get metadata for selected chat
  const currentChatMetadata =
    selectedChatId !== null ? cacheRef.current.chats.get(selectedChatId) : null;

  // Download a committed chat attachment. Image bytes are already inlined on the message; other
  // attachments are fetched on demand over the authenticated RPC connection.
  const downloadChatAttachment = useCallback(async (chatId: number, attachment: ChatAttachmentRef) => {
    try {
      let bytes = attachment.content;
      const mimeType = attachment.mimeType;
      const name = attachment.name;
      if (!bytes) {
        bytes = await overseer.getChatAttachmentContent(chatId, attachment.id);
      }
      const url = URL.createObjectURL(
        new Blob([bytes as BlobPart], {type: mimeType || "application/octet-stream"}));
      try {
        const a = document.createElement("a");
        a.href = url;
        a.download = name ?? "attachment";
        a.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(url), 0);
      }
    } catch (err: any) {
      console.error("Failed to download chat attachment:", err);
      toasts.add({ title: err?.message || "Failed to download attachment", variant: "error" });
    }
  }, [overseer, toasts]);

  const onSelectedChatHasProposedChangesChangeRef = useRef(onSelectedChatHasProposedChangesChange);
  onSelectedChatHasProposedChangesChangeRef.current = onSelectedChatHasProposedChangesChange;
  useEffect(() => {
    if (selectedChatId !== null && currentChatMetadata === undefined) {
      return;
    }

    onSelectedChatHasProposedChangesChangeRef.current?.(
      currentChatMetadata?.hasProposedChanges === true,
    );
  }, [currentChatMetadata?.hasProposedChanges, currentChatMetadata, selectedChatId]);

  const currentProvisionalState =
    selectedChatId !== null
      ? (provisionalRef.current.get(selectedChatId) ?? null)
      : null;

  const currentDraftState =
    selectedChatId !== null ? (draftRef.current.get(selectedChatId) ?? null) : null;
  const currentDraftChangesCount = currentDraftState?.entries.length ?? 0;

  const provisionalToolCalls = currentProvisionalState?.toolCalls ?? [];
  const useConstrainedChatWidth = sidebarMode || constrainChatWidth;

  const currentStreamingChanges = currentProvisionalState?.codeUpdates;
  const currentStreamingChangesCount = currentStreamingChanges?.length ?? 0;
  const currentStreamingActiveFile = currentProvisionalState?.activeEditingFile;
  const currentDraftChangesState = useMemo(():
    | StreamingProposedChanges
    | undefined => {
    if (!currentDraftState || currentDraftChangesCount === 0) {
      return undefined;
    }
    return {
      updates: currentDraftState.entries.map((entry) => entry.update),
      count: currentDraftChangesCount,
    };
  }, [currentDraftChangesCount, currentDraftState, draftChangesVersion, selectedChatId]);
  const currentStreamingState = useMemo(():
    | StreamingProposedChanges
    | undefined => {
    if (!currentStreamingChanges || currentStreamingChangesCount === 0) {
      return undefined;
    }
    return {
      updates: currentStreamingChanges,
      count: currentStreamingChangesCount,
    };
  }, [selectedChatId, currentStreamingChanges, currentStreamingChangesCount]);

  const isCompacting = currentProvisionalState?.compacting === true;

  const hasVisibleProvisionalContent =
    !!currentProvisionalState &&
    (currentProvisionalState.text !== "" ||
      currentProvisionalState.reasoning !== "" ||
      currentProvisionalState.compacting ||
      provisionalToolCalls.length > 0);

  const isAgentActive = !!currentChatMetadata?.activeAgent;
  const activeAgent = currentChatMetadata?.activeAgent;

  // Notify parent when agent active state changes
  const onAgentActiveChangeRef = useRef(onAgentActiveChange);
  onAgentActiveChangeRef.current = onAgentActiveChange;
  const previousAgentStateRef = useRef({chatId: selectedChatId, active: isAgentActive});
  useEffect(() => {
    let previous = previousAgentStateRef.current;
    if (selectedChatId !== null &&
        (selectedChatId !== previous.chatId || isAgentActive !== previous.active)) {
      onAgentActiveChangeRef.current?.(selectedChatId, isAgentActive);
    }
    previousAgentStateRef.current = {chatId: selectedChatId, active: isAgentActive};
  }, [isAgentActive, selectedChatId]);

  // Loads the page before the oldest message on screen. Held in a ref because the scroll handler is
  // built once, while the loader closes over state that changes each render.
  const loadEarlierRef = useRef<() => void>(() => {});

  // Height of the message area just before an earlier page is prepended. Restoring against it keeps
  // the user on what they were reading instead of jumping them backwards.
  const prependAnchorRef = useRef<number | undefined>(undefined);

  // Track whether user is scrolled to the bottom of the messages area.
  const handleMessagesScroll = useCallback(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    // Allow a small tolerance for fractional scroll positions and layout rounding.
    isScrolledToBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= 8;
    // Approaching the top pulls in the previous page, so a compacted thread reads as one continuous
    // scroll rather than making the user ask for their own history.
    if (el.scrollTop <= EARLIER_PAGE_PREFETCH_PX) loadEarlierRef.current();
  }, []);

  useLayoutEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;
    if (prependAnchorRef.current !== undefined) {
      el.scrollTop += el.scrollHeight - prependAnchorRef.current;
      prependAnchorRef.current = undefined;
    } else if (el.scrollHeight <= el.clientHeight) {
      // A short page leaves nothing to scroll, so no scroll event would ever ask for the rest.
      loadEarlierRef.current();
    }
  });

  // Auto-scroll to bottom when messages change, but only if already at bottom
  useLayoutEffect(() => {
    if (isScrolledToBottomRef.current) {
      scrollMessagesToBottom();
    }
  }, [
    currentMessages,
    hasVisibleProvisionalContent,
    currentStreamingChangesCount,
    isAgentActive,
    scrollMessagesToBottom,
  ]);

  // Always scroll to bottom and close transient chat UI when switching chats.
  useLayoutEffect(() => {
    isScrolledToBottomRef.current = true;
    scrollMessagesToBottom();
  }, [selectedChatId, scrollMessagesToBottom]);
  useEffect(() => {
    setDiscardChangesTarget(null);
  }, [selectedChatId]);

  // Initialize title input when selecting a chat
  useEffect(() => {
    if (currentChatMetadata) {
      setTitleInput(currentChatMetadata.title);
    }
  }, [currentChatMetadata?.title]);

  // Update selected model when switching chats
  useEffect(() => {
    if (selectedChatId === null) {
      setSelectedModel(getStoredSelectedModel(availableModels));
    } else {
      // For existing threads:
      // 1. If an AI agent is currently active, use that agent's model
      if (activeAgent) {
        setSelectedModel(activeAgent.id);
      } else {
        // 2. Otherwise, derive the model from the most recent agent message or agent error.
        setSelectedModel(
          fallbackToStoredModelSelection(
            inferSelectedModelFromMessages(currentMessages),
            availableModels,
          ),
        );
      }
    }
  }, [selectedChatId, availableModels, currentMessages, activeAgent]);

  // Keep the ref in sync with selectedChatId state
  useEffect(() => {
    selectedChatIdRef.current = selectedChatId;
  }, [selectedChatId]);

  // Notify parent when proposed changes change for the selected chat.
  // Only recomputes when proposedChangesVersion changes (i.e. a "changes", "merge",
  // or "revert" message arrives), NOT on every message.
  useEffect(() => {
    if (!currentChatMetadata?.hasProposedChanges) {
      onProposedChangesChange?.(undefined);
      return;
    }

    // Read messages directly from the cache (always current) rather than using the
    // memoized currentMessages, so we don't need it as a dependency.
    const messages =
      selectedChatId !== null
        ? (cacheRef.current.messages.get(selectedChatId) || []).filter(
            (msg) => msg !== undefined,
          )
        : [];
    const { activeChanges } = computeMessageStates(
      messages,
      selectedChatId !== null
        ? cacheRef.current.compacted.get(selectedChatId)?.[0]
        : undefined,
    );

    if (activeChanges.length === 0) {
      onProposedChangesChange?.(undefined);
      return;
    }

    const updatePayloads = activeChanges
      .map((c) => c.update)
      .filter((u): u is Uint8Array => u !== undefined);

    // Creation/binding-only batches carry no code update; preserve the "proposed changes exist"
    // signal with an empty update in that case.
    const mergedUpdate =
      updatePayloads.length === 1
        ? updatePayloads[0]
        : updatePayloads.length > 0
          ? Y.mergeUpdatesV2(updatePayloads)
          : Y.encodeStateAsUpdateV2(new Y.Doc());

    onProposedChangesChange?.(mergedUpdate);
  }, [
    currentChatMetadata?.hasProposedChanges,
    proposedChangesVersion,
    selectedChatId,
    onProposedChangesChange,
  ]);

  useEffect(() => {
    onStreamingProposedChangesChange?.(currentStreamingState);
  }, [currentStreamingState, onStreamingProposedChangesChange]);

  useEffect(() => {
    onDraftProposedChangesChange?.(currentDraftChangesState);
  }, [currentDraftChangesState, onDraftProposedChangesChange]);

  const onStreamingActiveFileChangeRef = useRef(onStreamingActiveFileChange);
  onStreamingActiveFileChangeRef.current = onStreamingActiveFileChange;
  useEffect(() => {
    if (selectedChatId !== null) {
      onStreamingActiveFileChangeRef.current?.(selectedChatId, currentStreamingActiveFile);
    }
  }, [currentStreamingActiveFile, selectedChatId]);

  // Proper class implementation of AiChatSubscriber
  // This is necessary so the server receives a single stub for the object,
  // not separate stubs for each method
  class ChatSubscriberImpl extends RpcTarget implements AiChatSubscriber {
    streamGeneration(generation: number) {
      if (
        lastStreamGenerationRef.current !== undefined &&
        lastStreamGenerationRef.current !== generation
      ) {
        // The DO fully restarted since our last subscription; any in-flight provisional streams
        // were lost and will be re-streamed from scratch. Discard stale provisional state so the
        // re-streamed content isn't appended to it. Clearing all chats is safe: provisional state
        // is purely ephemeral display state, and idle chats already have none.
        provisionalRef.current.clear();
        forceUpdate();
      }
      lastStreamGenerationRef.current = generation;
    }

    metadata(chat: AiChatMetadata) {
      // When the agent stops running (activeAgent becomes unset), do a final full clear of this
      // chat's provisional streaming state. This generally shouldn't be necessary because chat
      // stream state is cleared when the final message arrives and code stream state is cleared
      // when the finalized changes arrive, but doing this final clear will "mop up" if there
      // were any inconsistencies in the streaming.
      const prevChat = cacheRef.current.chats.get(chat.id);
      if (prevChat?.activeAgent && !chat.activeAgent) {
        provisionalRef.current.delete(chat.id);
      }

      // A revert reaching across a boundary rolls compaction back, lowering or clearing
      // `compactedTo` and deleting the checkpoints above it. Drop those here so their markers stop
      // claiming history that is whole again.
      let boundaries = cacheRef.current.compacted.get(chat.id);
      if (boundaries !== undefined) {
        let live = boundaries.filter(({to}) => to <= (chat.compactedTo ?? -1));
        if (live.length < boundaries.length) cacheRef.current.compacted.set(chat.id, live);
      }

      // A compaction that lands while the chat is open publishes a boundary the client only gets
      // with a page, so refetch instead of waiting for a reload. Asking whether that boundary is
      // already loaded makes this idempotent: paging back adds boundaries rather than replacing
      // them, so an extra fetch can neither miss a compaction nor undo an expansion. Rolling the
      // last boundary away needs the same fetch, since the history it used to hide is live again.
      if (cacheRef.current.messages.has(chat.id) && (chat.compactedTo === undefined
          ? prevChat?.compactedTo !== undefined
          : !cacheRef.current.compacted.get(chat.id)?.some(({to}) => to === chat.compactedTo))) {
        refreshBoundaryRef.current(chat.id);
      }

      cacheRef.current.chats.set(chat.id, chat);
      bumpChatListVersion();
      forceUpdate();
    }

    deleted(chatId: number) {
      // Remove from cache
      cacheRef.current.chats.delete(chatId);
      cacheRef.current.messages.delete(chatId);
      cacheRef.current.compacted.delete(chatId);
      removeChatFromActionMessageIndex(chatId);
      provisionalRef.current.delete(chatId);
      draftRef.current.delete(chatId);
      bumpChatListVersion();

      // If currently viewing this chat, go back to list
      // Use replace to prevent browser-back returning to the deleted chat
      if (selectedChatIdRef.current === chatId) {
        onNavigateToChatRef.current(null, { replace: true });
      }

      forceUpdate();
    }

    draftUpdate(
      chatId: number,
      timestamp: Date,
      author: AiChatAuthorInfo,
      update: Uint8Array,
    ) {
      let draft = getOrCreateDraftChatState(draftRef.current, chatId);
      let existingIndex = draft.entries.findIndex(
        (entry) => entry.timestamp.getTime() === timestamp.getTime(),
      );

      if (existingIndex >= 0) {
        draft.entries[existingIndex] = { timestamp, author, update };
      } else {
        draft.entries.push({ timestamp, author, update });
        draft.entries.sort(
          (left, right) => left.timestamp.getTime() - right.timestamp.getTime(),
        );
      }

      refreshDraftLatestAuthor(draft);
      if (existingIndex >= 0) {
        setDraftChangesVersion((prev) => prev + 1);
      }
      scheduleUpdate();
    }

    draftCleared(chatId: number) {
      if (draftRef.current.delete(chatId)) {
        scheduleUpdate();
      }
    }

    message(msg: AiChatMessage) {
      // Use sequence number as index to make this idempotent
      // This handles both duplicate subscriptions (React strict mode) and race conditions

      // Get or initialize messages array for this chat
      let messages = cacheRef.current.messages.get(msg.chatId);
      if (!messages) {
        messages = [];
        cacheRef.current.messages.set(msg.chatId, messages);
      }

      // Set message at sequence index (idempotent)
      messages[msg.sequence] = msg;
      indexActionMessage(msg);

      // Update last message timestamp
      if (
        !cacheRef.current.lastMessageTimestamp ||
        msg.timestamp > cacheRef.current.lastMessageTimestamp
      ) {
        cacheRef.current.lastMessageTimestamp = msg.timestamp;
      }

      // Only trigger proposed-changes recomputation for message types that affect the code.
      // "merge" is excluded: it reclassifies changes from proposed to committed but doesn't
      // change the total code (committed + proposed). The hasProposedChanges metadata
      // dependency handles the transition when all changes are merged.
      if (msg.type === "changes" || msg.type === "revert") {
        setProposedChangesVersion((prev) => prev + 1);
      }

      if (msg.type === "changes" && msg.author.type === "user") {
        pruneDraftEntriesBefore(draftRef.current, msg.chatId, msg.timestamp);
      }

      const provisional = provisionalRef.current.get(msg.chatId);
      if (provisional) {
        if (msg.type === "message") {
          clearProvisionalTextState(provisional);
        } else if (msg.type === "changes") {
          clearProvisionalCodeState(provisional);
        } else if (msg.type === "error") {
          clearProvisionalTextState(provisional);
          clearProvisionalCodeState(provisional);
        }

        if (isProvisionalChatStateEmpty(provisional)) {
          provisionalRef.current.delete(msg.chatId);
        }
      }

      forceUpdate();
    }

    stream(chatId: number, event: AiChatStreamEvent) {
      let provisional = provisionalRef.current.get(chatId);

      if (!provisional) {
        provisional = createProvisionalChatState();
        provisionalRef.current.set(chatId, provisional);
      }

      switch (event.type) {
        case "compacting":
          provisional.compacting = true;
          break;
        case "compacted":
          provisional.compacting = false;
          if (event.nothingToCompact) {
            toastsRef.current.add({
              title: "Nothing to compact — there are no earlier messages to summarize.",
            });
          }
          break;
        case "textDelta":
          provisional.text += event.delta;
          break;
        case "reasoningDelta":
          provisional.reasoning += event.delta;
          break;
        case "toolCallStarted": {
          getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            event.toolName,
          );
          break;
        }
        case "toolCodeDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.code += event.delta;
          break;
        }
        case "toolOutputDelta": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.output += event.delta;
          break;
        }
        case "toolCallFinished": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.finished = true;
          break;
        }
        case "setActiveFile":
          provisional.activeEditingFile = event.file ?? null;
          // Also tell the editor straight away. The effect above only runs on re-render, which is
          // too late for the tab to follow the very first file of a turn.
          if (chatId === selectedChatIdRef.current) {
            onStreamingActiveFileChangeRef.current?.(chatId, event.file ?? null);
          }
          break;
        case "toolCallOutputFormat": {
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.outputFormat = event.output;
          break;
        }
        case "toolCallTarget": {
          // Surfaces the file name during streaming for writes and edits so the frontend can update.
          const toolCall = getOrCreateProvisionalToolCall(
            provisional,
            event.toolCallId,
            null,
          );
          toolCall.target = event.file.filename;
          break;
        }
        case "codeReset":
          provisional.codeUpdates = [];
          break;
        case "codeUpdate":
          provisional.codeUpdates.push(event.update);
          break;
      }

      if (isProvisionalChatStateEmpty(provisional)) {
        provisionalRef.current.delete(chatId);
      }

      scheduleUpdate();
    }
  }

  // Keep stable subscriber instance across re-renders
  const subscriberRef = useRef(new ChatSubscriberImpl());

  // Subscribe to chat updates
  useEffect(() => {
    let isMounted = true;

    const subscribe = async () => {
      try {
        // Subscribe using startAfter if we have a last message timestamp
        const startAfter = cacheRef.current.lastMessageTimestamp || undefined;

        // Don't await - subscribeToChat returns a promise that doesn't resolve until disconnect
        // Store the promise itself as the subscription
        // Pass the subscriber instance (which is now a proper class instance)
        const subscription = overseer.subscribeToChat(
          subscriberRef.current,
          startAfter,
        );

        subscriptionRef.current = subscription;

        if (isMounted) {
          setIsSubscribed(true);

          // After subscribing, load the list of chats and models
          // This is safe because subscription will catch any new activity
          const [chats, models] = await Promise.all([
            overseer.listChats(),
            overseer.listModels(),
          ]);

          chats.forEach((chat) => {
            cacheRef.current.chats.set(chat.id, chat);
          });
          bumpChatListVersion();
          setChatListReady(true);

          setAvailableModels(models);

          setSelectedModel(getStoredSelectedModel(models));

          forceUpdate();
        }
      } catch (err) {
        if (!logRpcFailure("Failed to subscribe to chats:", err)) {
          reportIssue('chat.subscription-load', err)
          toasts.add({ title: "Unable to load conversations", variant: "error" });
        }
      }
    };

    subscribe();

    // Set up reconnection handling
    overseer.onRpcBroken?.((error) => {
      console.warn("RPC connection broken:", error);
      setIsSubscribed(false);
      // Cache persists, component will get new overseer prop and resubscribe
    });

    return () => {
      isMounted = false;
      if (subscriptionRef.current) {
        subscriptionRef.current[Symbol.dispose]();
      }
      // Note: subscriberRef.current stays alive for potential resubscription
    };
  }, [overseer]);

  // Patch cached chat messages on action upserts.
  useActionEntries(overseer, (record) => {
    if (applyActionLogUpdateToCachedMessages(record)) scheduleUpdate();
  });

  // Reset per-chat UI state when selectedChatId changes
  useEffect(() => {
    setExpandedToolCalls(new Set());
    setExpandedActions(new Set());
    setExpandedErrors(new Set());
    setIsLoadingEarlier(false);
    setIsEditingTitle(false);
    setSidebarActiveTab("chat");
  }, [selectedChatId]);


  // Load chat history when selectedChatId changes to a non-null value
  useEffect(() => {
    if (selectedChatId === null) return;

    // If we don't have messages for this chat yet, load them
    if (!cacheRef.current.messages.has(selectedChatId)) {
      let cancelled = false;
      setIsLoading(true);
      (async () => {
        try {
          const page = await overseer.getChatHistory(selectedChatId);
          if (cancelled) return;

          cacheHistoryPage(selectedChatId, page);

          // Update last message timestamp if needed
          if (page.messages.length > 0) {
            const lastMsg = page.messages[page.messages.length - 1];
            if (
              !cacheRef.current.lastMessageTimestamp ||
              lastMsg.timestamp > cacheRef.current.lastMessageTimestamp
            ) {
              cacheRef.current.lastMessageTimestamp = lastMsg.timestamp;
            }
          }

          // History may contain change-affecting messages that the subscriber
          // didn't deliver (they predated the subscription). Bump the version so
          // the proposed-changes effect re-evaluates with the loaded messages.
          setProposedChangesVersion((prev) => prev + 1);
          forceUpdate();
        } catch (err) {
          console.error("Failed to load chat history:", err);
          // If loading fails (e.g., invalid chat ID), navigate back to chat list
          if (!cancelled) {
            onNavigateToChatRef.current(null, { replace: true });
          }
        } finally {
          if (!cancelled) {
            setIsLoading(false);
          }
        }
      })();

      return () => {
        cancelled = true;
      };
    }
    // LSP reports an error here, but tsc does not.
    // The LSP error is due to bugs that need to be fixed in Cap'n Web.
  }, [selectedChatId, overseer]);

  // Sequence of the oldest message loaded, or undefined once the thread's start is loaded. Paging
  // asks for what precedes it, so the control disappears exactly when there is nothing earlier.
  const oldestLoadedSequence = currentMessages[0]?.sequence;
  const hasEarlierMessages = oldestLoadedSequence !== undefined && oldestLoadedSequence > 0;

  // Load the page before the oldest message on screen. Those messages are all older than anything
  // the subscription delivers, so lastMessageTimestamp is left alone.
  const handleShowEarlierMessages = async () => {
    if (selectedChatId === null || !hasEarlierMessages || isLoadingEarlier) return;

    setIsLoadingEarlier(true);
    try {
      const page = await overseer.getChatHistory(selectedChatId, oldestLoadedSequence);
      prependAnchorRef.current = messagesContainerRef.current?.scrollHeight;
      cacheHistoryPage(selectedChatId, page);

      // The page's own change-affecting messages now stand in for the boundary's merged update.
      setProposedChangesVersion((prev) => prev + 1);
      forceUpdate();
    } catch (err) {
      console.error("Failed to load earlier messages:", err);
      toasts.add({ title: "Failed to load earlier messages", variant: "error" });
    } finally {
      setIsLoadingEarlier(false);
    }
  };

  loadEarlierRef.current = () => { void handleShowEarlierMessages(); };

  // Handle sending a message (always called from ChatInput with explicit messageText)
  const handleSend = async (
    messageText?: string | SlashCommandRequest,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
  ) => {
    const message = typeof messageText === "string" ? messageText.trim() : messageText ?? "";
    if (!message && (!attachments || attachments.length === 0)) return;

    // Use provided modelId or fall back to selectedModel
    const model = modelId !== undefined ? modelId : selectedModel;

    try {
      if (selectedChatId === null) {
        // Create a new chat (with optional capsules).
        const newChatId = await overseer.newChat(
            message, model, capsules, attachments, formats);
        onNavigateToChatRef.current(newChatId);
      } else {
        // Send message to existing chat.
        await overseer.sendChatMessage(
          selectedChatId,
          message,
          model,
          capsules || undefined,
          attachments || undefined,
          formats,
        );
      }
    } catch (err) {
      if (!logRpcFailure("Failed to send message:", err, { reportSite: "chat.send" })) {
        toasts.add({ title: "Failed to send message", variant: "error" });
      }
      throw err;
    }
  };

  // Handle creating a new chat from the sidebar (always creates, never sends to existing)
  const handleNewChatSend = async (
    messageText?: string | SlashCommandRequest,
    modelId?: string | null,
    capsules?: CapsuleSpecifier[],
    attachments?: ChatAttachmentHandle[],
    formats?: MessageFormatRef[],
  ) => {
    const message = typeof messageText === "string" ? messageText.trim() : messageText ?? "";
    if (!message && (!attachments || attachments.length === 0)) return;
    const model = modelId !== undefined ? modelId : selectedModel;
    try {
      const newChatId = await overseer.newChat(
          message, model, capsules, attachments, formats);
      onNavigateToChatRef.current(newChatId);
    } catch (err) {
      if (!logRpcFailure("Failed to create new chat:", err, { reportSite: "chat.new" })) {
        toasts.add({ title: "Failed to start conversation", variant: "error" });
      }
      throw err;
    }
  };

  // Handle model change
  const handleModelChange = (modelId: string | null) => {
    setSelectedModel(modelId);
    persistSelectedModel(modelId);
  };

  // Handle stopping the agent
  const handleStop = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.stopAgent(selectedChatId);
    } catch (err) {
      console.error("Failed to stop agent:", err);
      toasts.add({ title: "Failed to stop agent", variant: "error" });
    }
  };

  // Handle saving chat title
  const handleSaveChatTitle = async () => {
    if (selectedChatId === null || !titleInput.trim()) {
      return;
    }

    try {
      await overseer.setChatTitle(selectedChatId, titleInput.trim());

      // Update the cache with the new title
      const chat = cacheRef.current.chats.get(selectedChatId);
      if (chat) {
        cacheRef.current.chats.set(selectedChatId, {
          ...chat,
          title: titleInput.trim(),
        });
        forceUpdate();
      }

      setIsEditingTitle(false);
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle canceling title edit
  const handleCancelTitleEdit = () => {
    setTitleInput(currentChatMetadata?.title || "");
    setIsEditingTitle(false);
  };

  // Handle deleting a chat. Can be called from the chat header (no args) or the
  // chat list (with explicit chatId/title).
  const handleDeleteChat = (chatId?: number, chatTitle?: string) => {
    const id = chatId ?? selectedChatId;
    const title = chatTitle ?? currentChatMetadata?.title ?? "this chat";
    if (id === null || id === undefined) return;
    setDeleteTarget({ id, title });
  };

  const handleDeleteConfirm = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await overseer.deleteChat(deleteTarget.id);
      toasts.add({ title: "Chat deleted successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to delete chat:", err);
      toasts.add({ title: "Failed to delete chat", variant: "error" });
    }
    setIsDeleting(false);
    setDeleteTarget(null);
  };

  const cancelListRename = () => {
    renamingChatIdRef.current = null;
    setRenamingChatId(null);
  };

  const startListRename = (chatId: number, title: string) => {
    renamingChatIdRef.current = chatId;
    setRenamingInput(title);
    setRenamingChatId(chatId);
  };

  // Handle saving a renamed chat from the list view
  const handleSaveListRename = async (chatId: number) => {
    if (renamingChatIdRef.current !== chatId) return;

    renamingChatIdRef.current = null;
    setRenamingChatId(null);

    const trimmed = renamingInput.trim();
    const existing = cacheRef.current.chats.get(chatId);
    // Cancel on empty or no-op so commit-on-blur doesn't fire pointless RPCs.
    if (!trimmed || trimmed === existing?.title) return;

    try {
      await overseer.setChatTitle(chatId, trimmed);
      if (existing) {
        cacheRef.current.chats.set(chatId, {
          ...existing,
          title: trimmed,
        });
        bumpChatListVersion();
        forceUpdate();
      }
      toasts.add({ title: "Chat title updated successfully", variant: "success" });
    } catch (err) {
      console.error("Failed to update chat title:", err);
      toasts.add({ title: "Failed to update chat title", variant: "error" });
    }
  };

  // Handle merging changes up to a specific sequence number
  const handleMergeChanges = async (
    mergeThrough: number | null,
    options?: { includeDraft?: boolean },
  ) => {
    if (selectedChatId === null) return;

    try {
      await overseer.mergeChanges(selectedChatId, mergeThrough, options);
      toasts.add({ title: "Changes accepted", variant: "success" });
    } catch (err) {
      console.error("Failed to accept changes:", err);
      toasts.add({ title: "Failed to accept changes", variant: "error" });
    }
  };

  const handleFinalizeDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.finalizeChatDraft(selectedChatId);
      toasts.add({ title: "Changes saved", variant: "success" });
    } catch (err) {
      console.error("Failed to save changes:", err);
      toasts.add({ title: "Failed to save changes", variant: "error" });
    }
  };

  const handleDiscardDraftChanges = async () => {
    if (selectedChatId === null) return;

    try {
      await overseer.discardChatDraftChanges(selectedChatId);
      draftRef.current.delete(selectedChatId);
      forceUpdate();
      toasts.add({ title: "Changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard changes:", err);
      toasts.add({ title: "Failed to discard changes", variant: "error" });
    }
  };

  const handleDiscardPendingChanges = async () => {
    if (!discardChangesTarget) return;

    const target = discardChangesTarget;
    setDiscardingChangesChatIds((chatIds) => new Set(chatIds).add(target.chatId));
    try {
      // Rewind durable checkpoints first. If discarding the live editor draft then fails, the user
      // still retains those edits rather than losing both layers after a partial operation.
      await overseer.revertChanges(target.chatId, 0);
      if ((draftRef.current.get(target.chatId)?.entries.length ?? 0) > 0) {
        await overseer.discardChatDraftChanges(target.chatId);
        draftRef.current.delete(target.chatId);
        forceUpdate();
      }
      setDiscardChangesTarget((current) =>
        current?.chatId === target.chatId ? null : current,
      );
      toasts.add({ title: "Pending changes discarded", variant: "success" });
    } catch (err) {
      console.error("Failed to discard pending changes:", err);
      toasts.add({ title: "Failed to discard pending changes", variant: "error" });
    } finally {
      setDiscardingChangesChatIds((chatIds) => {
        const next = new Set(chatIds);
        next.delete(target.chatId);
        return next;
      });
    }
  };

  const applyActionLogUpdateToCachedMessages = (record: ActionLogEntry): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(record.id);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const messages = cacheRef.current.messages.get(location.chatId);
      const msg = messages?.[location.sequence];
      if (msg?.type !== "action" || msg.actionId !== record.id) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...messages!];
      nextMessages[location.sequence] = { ...msg, actionLog: record };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(record.id);
    return changed;
  };

  const applyOptimisticActionState = (actionId: number, state: "approved" | "rejected"): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(actionId);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const messages = cacheRef.current.messages.get(location.chatId);
      const msg = messages?.[location.sequence];
      if (msg?.type !== "action" || msg.actionId !== actionId || !msg.actionLog) {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...messages!];
      nextMessages[location.sequence] = {
        ...msg,
        actionLog: { ...msg.actionLog, state, appliedAt: new Date() },
      };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    return changed;
  };

  const applyOptimisticHookEnabled = (actionId: number, enabled: boolean): boolean => {
    let changed = false;
    const locations = cacheRef.current.actionMessages.get(actionId);
    if (!locations) return false;

    for (const [key, location] of locations) {
      const messages = cacheRef.current.messages.get(location.chatId);
      const msg = messages?.[location.sequence];
      if (msg?.type !== "action" || msg.actionId !== actionId || msg.actionLog?.type !== "bindHook") {
        locations.delete(key);
        continue;
      }

      const nextMessages = [...messages!];
      nextMessages[location.sequence] = {
        ...msg,
        actionLog: { ...msg.actionLog, enabled },
      };
      cacheRef.current.messages.set(location.chatId, nextMessages);
      changed = true;
    }

    if (locations.size === 0) cacheRef.current.actionMessages.delete(actionId);
    return changed;
  };

  // Handle reverting changes from a specific sequence number onward
  const handleRevertChanges = useCallback(async (revertFrom: number) => {
    if (selectedChatId === null) return;

    try {
      await overseer.revertChanges(selectedChatId, revertFrom);
      toasts.add({ title: "Draft rewound", variant: "success" });
    } catch (err) {
      console.error("Failed to rewind draft:", err);
      toasts.add({ title: "Failed to rewind draft", variant: "error" });
    }
  }, [overseer, selectedChatId, toasts]);

  // Pending "always approve this type" confirmation, opened from a pending action card.
  const [autoApproveConfirm, setAutoApproveConfirm] = useState<
    { actionId: number; gatekeeperId: number; resourceTitle: string;
      actionKind: ActionKind; actionLabel: string } | null
  >(null);

  // Enable auto-approval of an action tag on its connection (gated by the confirm dialog). The
  // server applies the now-eligible pending action(s) via its drain, and the action state flips to
  // "approved" through the actions subscription -- so we don't optimistically mutate it here.
  const { alwaysApproveTag, isTagAutoApproved } =
    useAlwaysApproveTag(overseer, setProcessingActions, onAutoApproveChange);

  const resolveAction = useResolveAction(overseer, setProcessingActions, (actionId, state) => {
    if (applyOptimisticActionState(actionId, state)) forceUpdate();
  });

  // Handle enabling/disabling a bound hook from the chat thread.
  const handleToggleHook = async (actionId: number, hookId: number, enabled: boolean) => {
    setProcessingActions((prev) => new Set(prev).add(actionId));
    if (applyOptimisticHookEnabled(actionId, enabled)) forceUpdate();
    try {
      if (enabled) {
        await overseer.enableHook(hookId);
      } else {
        await overseer.disableHook(hookId);
      }
    } catch (err) {
      console.error("Failed to toggle hook:", err);
      toasts.add({ title: `Failed to ${enabled ? "enable" : "disable"} hook`, variant: "error" });
      // Revert the optimistic update.
      if (applyOptimisticHookEnabled(actionId, !enabled)) forceUpdate();
    } finally {
      setProcessingActions((prev) => {
        const next = new Set(prev);
        next.delete(actionId);
        return next;
      });
    }
  };

  // Open the gatekeeper modal pre-seeded with the agent's requested vendor/resource.
  const handleAcceptConnection = (msg: AiChatMessage & { type: "connectionRequest" }) => {
    setConnectionAccept({
      requestId: msg.requestId,
      vendorId: msg.vendorId,
      resourceUrl: msg.resourceUrl,
      resourceUrlPattern: msg.resourceUrlPattern,
    });
  };

  // Invoked by the accept-flow GatekeeperModal once the user has connected + configured a resource.
  // The gatekeeper is bound into no gadget; finalizing the request surfaces it to the agent as a
  // binding in the chat's env, under the name the agent chose when it made the request (the agent
  // wires it into a gadget itself if that gadget's code needs it).
  const handleConnectionCreated = async (gk: RpcStub<GatekeeperClient<any>>) => {
    const accept = connectionAcceptRef.current;
    if (!accept) {
      gk[Symbol.dispose]();
      return;
    }
    setProcessingConnections((prev) => new Set(prev).add(accept.requestId));
    try {
      const id = await gk.getId();
      await overseer.acceptConnectionRequest(accept.requestId, {
        gatekeeperId: id,
      });
      setConnectionAccept(null);
    } catch (err) {
      console.error("Failed to finalize connection:", err);
      toasts.add({ title: "Failed to add connection", variant: "error" });
    } finally {
      gk[Symbol.dispose]();
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(accept.requestId);
        return next;
      });
    }
  };

  const handleDenyConnection = async (requestId: string) => {
    setProcessingConnections((prev) => new Set(prev).add(requestId));
    try {
      await overseer.denyConnectionRequest(requestId);
      // If the accept modal happens to be open for this same request, close it.
      if (connectionAcceptRef.current?.requestId === requestId) {
        setConnectionAccept(null);
      }
    } catch (err) {
      console.error("Failed to deny connection:", err);
      toasts.add({ title: "Failed to deny connection", variant: "error" });
    } finally {
      setProcessingConnections((prev) => {
        const next = new Set(prev);
        next.delete(requestId);
        return next;
      });
    }
  };

  const toggleToolCallExpansion = useCallback((expansionKey: string) => {
    setExpandedToolCalls((prev) => {
      const next = new Set(prev);
      if (next.has(expansionKey)) {
        next.delete(expansionKey);
      } else {
        next.add(expansionKey);
      }
      return next;
    });
  }, []);

  const toggleShowThinkingTraces = useCallback(() => {
    setShowThinkingTraces((prev) => {
      const next = !prev;
      persistShowThinkingTraces(next);
      return next;
    });
  }, []);

  // Toggle action description expansion
  const toggleActionExpansion = (actionId: number) => {
    setExpandedActions((prev) => {
      const next = new Set(prev);
      if (next.has(actionId)) {
        next.delete(actionId);
      } else {
        next.add(actionId);
      }
      return next;
    });
  };


  // Compaction summaries are collapsed by default: the marker answers where the cut fell, and the
  // summary is there for anyone who wants to see what the model was left with.
  const toggleCompactionSummary = (to: number) => {
    setExpandedCompactions((prev) => {
      const next = new Set(prev);
      if (next.has(to)) next.delete(to); else next.add(to);
      return next;
    });
  };

  // Toggle error message expansion
  const toggleErrorExpansion = (messageKey: string) => {
    setExpandedErrors((prev) => {
      const next = new Set(prev);
      if (next.has(messageKey)) {
        next.delete(messageKey);
      } else {
        next.add(messageKey);
      }
      return next;
    });
  };

  // Handle retrying the agent after an error
  const handleRetry = async () => {
    if (
      selectedChatId === null ||
      selectedModel === null
    ) {
      return;
    }

    try {
      await overseer.retryAgent(selectedChatId, selectedModel);
    } catch (err) {
      console.error("Failed to retry agent:", err);
      toasts.add({ title: "Failed to retry agent", variant: "error" });
    }
  };

  const handleCopyMessage = useCallback(async (message: string) => {
    const ok = await copyToClipboard(message);
    toasts.add({
      title: ok ? "Copied message" : "Unable to copy message",
      variant: ok ? "success" : "error",
    });
  }, [toasts]);

  const lastDurablePendingChange = useMemo(
    () => {
      for (let i = currentMessages.length - 1; i >= 0; i--) {
        const msg = currentMessages[i];
        if (
          msg.type === "changes" &&
          messageStates.changeStatus.get(msg.sequence) === "pending"
        ) {
          return msg;
        }
      }

      return null;
    },
    [currentMessages, messageStates],
  );

  // Track the last visible agent message in each completed turn. This keeps hover actions like
  // copy/timestamp on the final response instead of repeating them for every streamed step.
  const completedAgentTurnMessageSeqs = useMemo(() => {
    const out = new Set<number>();
    let lastAgentMessageSeq: number | null = null;

    for (const m of currentMessages) {
      if (m.type !== "message") continue;
      if (m.author.type === "user") {
        if (lastAgentMessageSeq !== null) out.add(lastAgentMessageSeq);
        lastAgentMessageSeq = null;
      } else if (!isEmptyAssistantMessage(m)) {
        lastAgentMessageSeq = m.sequence;
      }
    }

    if (!isAgentActive && lastAgentMessageSeq !== null) {
      out.add(lastAgentMessageSeq);
    }

    return out;
  }, [currentMessages, isAgentActive]);

  const latestCompletedAgentTurnMessageSeq = useMemo(() => {
    let latest: number | null = null;
    for (const sequence of completedAgentTurnMessageSeqs) {
      if (latest === null || sequence > latest) latest = sequence;
    }
    return latest;
  }, [completedAgentTurnMessageSeqs]);

  const pendingChangeByTurnItemSeq = useMemo(() => {
    const out = new Map<number, PendingTurnChanges>();
    let lastAgentMessageSeq: number | null = null;
    let lastVisibleWorkSeq: number | null = null;
    let pendingTurnChanges: PendingTurnChanges | null = null;
    let pendingTurnAnchorSeq: number | null = null;

    const currentAnchorSeq = () => lastAgentMessageSeq ?? lastVisibleWorkSeq;

    const attachPendingTurnChanges = () => {
      if (!pendingTurnChanges) return;

      const anchorSeq = currentAnchorSeq();
      if (anchorSeq === null) return;

      if (pendingTurnAnchorSeq !== null && pendingTurnAnchorSeq !== anchorSeq) {
        out.delete(pendingTurnAnchorSeq);
      }

      out.set(anchorSeq, pendingTurnChanges);
      pendingTurnAnchorSeq = anchorSeq;
    };

    const resetTurn = () => {
      lastAgentMessageSeq = null;
      lastVisibleWorkSeq = null;
      pendingTurnChanges = null;
      pendingTurnAnchorSeq = null;
    };

    for (const m of currentMessages) {
      if (m.type === "message") {
        if (m.author.type === "user") {
          resetTurn();
        } else if (!isEmptyAssistantMessage(m)) {
          lastAgentMessageSeq = m.sequence;
          lastVisibleWorkSeq = m.sequence;
          attachPendingTurnChanges();
        }
        continue;
      }

      if (isObservationActionMessage(m) || m.type === "useGadget") {
        lastVisibleWorkSeq = m.sequence;
        attachPendingTurnChanges();
        continue;
      }

      if (m.type === "changes" && m.author.type === "user") {
        resetTurn();
        continue;
      }

      if (
        m.type === "changes" &&
        m.author.type !== "user" &&
        (messageStates.changeStatus.get(m.sequence) ?? "pending") === "pending"
      ) {
        const createdTitles = (m.createdGadgets ?? []).map((g) => g.title);
        pendingTurnChanges = pendingTurnChanges === null
          ? { revertFrom: m.sequence, through: m.sequence, createdGadgetTitles: createdTitles }
          : {
              revertFrom: pendingTurnChanges.revertFrom,
              through: m.sequence,
              createdGadgetTitles: [...pendingTurnChanges.createdGadgetTitles, ...createdTitles],
            };
        attachPendingTurnChanges();
      }
    }

    return out;
  }, [currentMessages, messageStates]);

  // Accepted creations remain in the transcript; reverted ones disappear.
  const createdGadgetsByTurnItemSeq = useMemo(() => {
    const out = new Map<number, CreatedGadgetCardInfo[]>();
    let lastAgentMessageSeq: number | null = null;
    let lastVisibleWorkSeq: number | null = null;
    let creations: CreatedGadgetCardInfo[] = [];
    let creationAnchorSeq: number | null = null;

    const currentAnchorSeq = () => lastAgentMessageSeq ?? lastVisibleWorkSeq;

    const attachCreations = () => {
      if (creations.length === 0) return;
      const anchorSeq = currentAnchorSeq();
      if (anchorSeq === null) return;
      if (creationAnchorSeq !== null && creationAnchorSeq !== anchorSeq) {
        out.delete(creationAnchorSeq);
      }
      out.set(anchorSeq, creations);
      creationAnchorSeq = anchorSeq;
    };

    const resetTurn = () => {
      lastAgentMessageSeq = null;
      lastVisibleWorkSeq = null;
      creations = [];
      creationAnchorSeq = null;
    };

    for (const m of currentMessages) {
      if (m.type === "slashCommand" || m.type === "merge" || m.type === "revert") {
        resetTurn();
        continue;
      }

      if (m.type === "message") {
        if (m.author.type === "user") {
          resetTurn();
        } else if (!isEmptyAssistantMessage(m)) {
          lastAgentMessageSeq = m.sequence;
          lastVisibleWorkSeq = m.sequence;
          attachCreations();
        }
        continue;
      }

      if (isObservationActionMessage(m) || m.type === "useGadget") {
        lastVisibleWorkSeq = m.sequence;
        attachCreations();
        continue;
      }

      if (m.type !== "changes") continue;
      if (m.author.type === "user") {
        resetTurn();
        continue;
      }

      const status = messageStates.changeStatus.get(m.sequence) ?? "pending";
      if (status === "reverted" || !m.createdGadgets) continue;
      creations = [
        ...creations,
        ...m.createdGadgets.map(({ gadgetId, title }) => ({
          gadgetId,
          title,
          isPending: status === "pending",
          output: outputOfWorkpiece(gadgetId),
        })),
      ];
      attachCreations();
    }

    return out;
  }, [currentMessages, messageStates, outputOfWorkpiece]);

  const renderConnectionRequestCard = (
    msg: AiChatMessage & { type: "connectionRequest" },
  ) => {
    const isPending = msg.state === "pending";
    const isAccepted = msg.state === "accepted";
    const isDenied = msg.state === "denied";
    const isProc = processingConnections.has(msg.requestId);

    const stateLabel = isAccepted ? "Connected" : isDenied ? "Denied" : null;
    const stateLabelCls = isDenied ? "text-kumo-danger" : "text-kumo-success";
    const scope = msg.resourceTitle ?? msg.resourceUrl;

    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
          <div className="flex items-start gap-3">
            <GatekeeperIcon
              vendorId={msg.vendorId}
              logoUrl={msg.vendorLogoUrl}
              className="h-9 w-9 flex-shrink-0 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                <span className="font-medium text-kumo-default">
                  Connect {msg.vendorName}
                </span>
                {scope && (
                  <span className="rounded-full bg-kumo-tint px-2 py-0.5 text-[11px] leading-4 text-kumo-subtle">
                    {scope}
                  </span>
                )}
                {stateLabel && (
                  <span className={`text-[12px] font-medium ${stateLabelCls}`}>
                    {stateLabel}
                  </span>
                )}
              </div>
              {msg.reason && (
                <p className="mt-1 text-[13px] leading-[18px] text-kumo-subtle">
                  {msg.reason}
                </p>
              )}
            </div>
            {isPending && (
              <div className="ml-3 flex flex-shrink-0 items-center gap-2 self-center text-[13px] leading-4">
                <button
                  type="button"
                  onClick={() => handleDenyConnection(msg.requestId)}
                  disabled={isProc}
                  className="cursor-pointer rounded-md px-2 py-1 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Deny
                </button>
                <button
                  type="button"
                  onClick={() => handleAcceptConnection(msg)}
                  disabled={isProc}
                  className="cursor-pointer rounded-md bg-kumo-brand px-3 py-1 font-medium text-white transition-[opacity,transform] duration-150 ease-out hover:opacity-90 focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                >
                  Set up
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    );
  };

  const renderActionCard = (msg: ActionChatMessage) => {
    const log = msg.actionLog;
    if (!log) return null;

    const isAct = log.type === "action";
    const state = log.state;
    const open = expandedActions.has(msg.actionId);
    const isProc = processingActions.has(msg.actionId);
    const safeResourceUrl = safeExternalUrl(log.resourceUrl);

    if (log.type === "bindHook") {
      const isDeleted = log.hookId === undefined;
      const stateLabel = isDeleted
        ? "Deleted"
        : log.enabled
          ? "Enabled"
          : "Disabled";
      const stateLabelCls = isDeleted
        ? "text-kumo-inactive"
        : log.enabled
          ? "text-kumo-success"
          : "text-kumo-subtle";

      return (
        <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
          <div className="rounded-2xl border border-kumo-line bg-kumo-base px-4 py-3">
            <div className="flex items-start gap-3">
              <GatekeeperIcon
                fallbackText={log.resourceTitle}
                className="h-9 w-9 flex-shrink-0 rounded-lg"
              />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="font-medium text-kumo-default">
                    Hook: {log.description.title}
                  </span>
                  <span className={`text-[12px] font-medium ${stateLabelCls}`}>
                    {stateLabel}
                  </span>
                </div>
                {log.description.description && (
                  <div className={`mt-1 text-[13px] leading-[18px] text-kumo-subtle ${styles.markdownContent}`}>
                    <MarkdownMessage message={log.description.description} />
                  </div>
                )}
                {log.resourceTitle && (
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-kumo-inactive">
                    <span className="min-w-0 truncate">
                      {safeResourceUrl ? (
                        <a
                          href={safeResourceUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {log.resourceTitle}
                        </a>
                      ) : (
                        log.resourceTitle
                      )}
                    </span>
                  </div>
                )}
              </div>
              {!isDeleted && (
                <div className="ml-3 flex flex-shrink-0 items-center self-center">
                  <HookToggle
                    enabled={log.enabled}
                    disabled={isProc}
                    onToggle={(enabled) => handleToggleHook(msg.actionId, log.hookId!, enabled)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    if (!isAct) {
      const metadata = log.resourceTitle;

      return (
        <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
          <button
            type="button"
            onClick={() => toggleActionExpansion(msg.actionId)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
            aria-expanded={open}
          >
            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
              <WorkIcon Icon={MagnifyingGlass} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="flex min-w-0 items-center gap-2">
                <span className="min-w-0 truncate">{log.description.title}</span>
                <CaretRight
                  size={13}
                  weight="bold"
                  className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
                />
              </span>
              {metadata && (
                <span className="mt-1 block truncate text-[12px] leading-4 text-kumo-inactive">
                  {metadata}
                </span>
              )}
            </span>
          </button>
          {open && (
            <div className="themed-surface-inset ml-8 mt-1 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 text-[13px] leading-[19px] text-kumo-subtle">
              <MarkdownMessage message={log.description.description} />
            </div>
          )}
        </div>
      );
    }

    const isPending = state === "pending";
    const isApproved = state === "approved";
    const isRejected = state === "rejected";
    // A blocking (awaitDecision) pending action suspends the agent turn and blocks the composer, so
    // present it as a prominent callout with its details expanded by default.
    const isBlocking = isPending && log.description.awaitDecision === true;
    // A pending request is never collapsed: its description is the thing the user has to read in
    // order to answer it, so hiding it behind a disclosure would just add a step before every
    // decision. Resolved actions are history, and collapse so a long thread stays scannable.
    const showDescription = isPending || open;
    const metadata = log.resourceTitle;
    const stateLabel = isApproved
      ? "Approved"
      : isRejected
        ? "Denied"
        : null;
    const stateLabelCls = isRejected
      ? "text-kumo-danger"
      : "text-kumo-inactive";
    // Auto-approval target: offer "Always approve this type" only when enabling a rule would
    // actually apply this action -- a tagged action on a connection that the gatekeeper marked
    // auto-approvable. (A non-auto-approvable action stays a manual gate even with a rule; an
    // auto-approvable action with an existing rule wouldn't still be pending.)
    const autoApproveTarget =
      log.gatekeeperId !== undefined && log.description.actionKind !== undefined &&
      log.description.autoApprovable === true
        ? {
            actionId: msg.actionId,
            gatekeeperId: log.gatekeeperId,
            resourceTitle: log.resourceTitle,
            actionKind: log.description.actionKind,
            actionLabel: log.description.title,
          }
        : undefined;

    const actionControls = isPending ? (
      <>
        {autoApproveTarget &&
          !isTagAutoApproved(autoApproveTarget.gatekeeperId, autoApproveTarget.actionKind.tag) && (
          <Tooltip content="Always approve this type of action on this connection, without future prompts." asChild>
            <span className="flex">
              <AlwaysApproveButton
                onClick={() => setAutoApproveConfirm(autoApproveTarget)}
                disabled={isProc}
              />
            </span>
          </Tooltip>
        )}
        <ResolveButton
          tone="deny"
          onClick={() => void resolveAction(msg.actionId, "deny")}
          disabled={isProc}
        />
        <ResolveButton
          tone="approve"
          variant={isBlocking ? "filled" : "quiet"}
          onClick={() => void resolveAction(msg.actionId, "approve")}
          disabled={isProc}
        />
      </>
    ) : null;

    // Resource label, shown at the top of the blocking callout and at the bottom of the subtle
    // inline row.
    const resourceMeta = metadata ? (
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[12px] leading-4 text-kumo-inactive">
        {log.resourceTitle && (
          <span className="min-w-0 truncate">
            {safeResourceUrl ? (
              <a
                href={safeResourceUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="hover:underline"
                onClick={(e) => e.stopPropagation()}
              >
                {log.resourceTitle}
              </a>
            ) : (
              log.resourceTitle
            )}
          </span>
        )}
      </div>
    ) : null;

    // A blocking (awaitDecision) action suspends the agent turn, so present it as a prominent
    // callout laid out like the connection-request card: a permissions icon, title + resource +
    // details, and the approve/deny actions.
    if (isBlocking) {
      return (
        <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
          <div className="rounded-2xl border border-kumo-brand/40 bg-kumo-brand/10 px-4 py-3">
            <div className="flex items-start gap-3">
              <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-kumo-tint text-kumo-brand" aria-hidden="true">
                <ShieldCheck size={20} weight="fill" />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="min-w-0 truncate font-medium text-kumo-default">
                    {log.description.title}
                  </span>
                  {resourceMeta}
                </div>
                <div className={`chat-panel mt-1 max-h-[200px] overflow-y-auto pr-1 text-[13px] leading-[18px] text-kumo-subtle ${styles.markdownContent}`}>
                  <MarkdownMessage message={log.description.description} />
                </div>
              </div>
              <div className="ml-3 flex flex-shrink-0 items-center gap-1 self-center">
                {actionControls}
              </div>
            </div>
          </div>
        </div>
      );
    }

    const titleIcon = (
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center" aria-hidden="true">
        {isPending ? (
          <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand" />
        ) : (
          <WorkIcon Icon={LinkSimple} />
        )}
      </span>
    );

    return (
      <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
        {isPending ? (
          <div className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 px-1.5 py-1">
            <div className="flex min-w-[8rem] flex-1 items-center gap-3">
              {titleIcon}
              <span className="min-w-0 flex-1 truncate text-kumo-default">
                {log.description.title}
              </span>
            </div>
            <div className="ml-auto flex flex-shrink-0 items-center gap-0.5">{actionControls}</div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => toggleActionExpansion(msg.actionId)}
            className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
            aria-expanded={open}
          >
            {titleIcon}
            <span className="flex min-w-0 flex-1 items-center gap-2">
              <span className="min-w-0 truncate">{log.description.title}</span>
              {stateLabel && (
                <span className={`flex-shrink-0 text-[12px] font-medium ${stateLabelCls}`}>
                  {stateLabel}
                </span>
              )}
              <CaretRight
                size={13}
                weight="bold"
                className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${open ? "rotate-90" : ""}`}
              />
            </span>
          </button>
        )}
        {showDescription && (
          <div className="themed-surface-inset ml-8 mt-1 space-y-1.5 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3 text-[13px] leading-[19px] tracking-[-0.25px] text-kumo-subtle">
            <div className={`chat-panel max-h-[200px] overflow-y-auto pr-1 ${styles.markdownContent}`}>
              <MarkdownMessage message={log.description.description} />
            </div>
            {resourceMeta}
          </div>
        )}
      </div>
    );
  };

  // ─── sidebar list content (reused in both modes) ──────────────────────────
  const chatListPanel = (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Chat list header — title doubles as the scope switcher */}
      <div className="flex h-12 flex-shrink-0 items-center border-b border-kumo-line px-4">
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={
              <button
                type="button"
                className="group flex h-8 -ml-1.5 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left transition-colors duration-150 ease-out hover:bg-kumo-tint/60 focus-visible:bg-kumo-tint/60 focus-visible:outline-none data-[popup-open]:bg-kumo-tint/60"
                aria-label="Filter conversations"
              >
                <span className="text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                  {CHAT_LIST_SCOPE_LABELS[chatListScope]}
                </span>
                <CaretDown
                  size={10}
                  weight="bold"
                  className="text-kumo-inactive transition-transform duration-150 ease-out group-data-[popup-open]:rotate-180"
                />
              </button>
            }
          />
          <DropdownMenu.Content className="themed-floating-shadow !z-[1100] !min-w-[200px] rounded-lg border border-kumo-line bg-kumo-base p-1">
            {chatListScopes.map((scope) => {
              const active = chatListScope === scope.value;
              return (
                <DropdownMenu.Item
                  key={scope.value}
                  onClick={() => setChatListScope(scope.value)}
                  className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                >
                  <span className="mr-2 inline-flex h-3 w-3 items-center justify-center text-kumo-default">
                    {active ? <Check size={11} weight="bold" /> : null}
                  </span>
                  <span className="flex-1">{CHAT_LIST_SCOPE_LABELS[scope.value]}</span>
                  <span className="ml-3 font-mono text-[11px] text-kumo-inactive">
                    {scope.count}
                  </span>
                </DropdownMenu.Item>
              );
            })}
          </DropdownMenu.Content>
        </DropdownMenu>
      </div>
      {/* Chat list */}
      <div className="chat-panel flex-1 overflow-y-auto bg-kumo-base p-3">
        {!chatListReady ? (
          <div className="flex items-center justify-center py-10">
            <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
          </div>
        ) : chatList.length === 0 ? (
          <p className="text-sm text-kumo-inactive text-center py-8">
            No conversations yet
          </p>
        ) : (
          <div className="flex flex-col gap-1">
            {visibleChatList.length === 0 ? (
              // Only reachable when a non-"all" scope filters everything out;
              // the all-empty case is handled by the outer chatList.length check.
              <div className="py-8 text-center">
                <p className="text-[13px] leading-[18px] text-kumo-inactive">
                  No conversations started by {chatListScope === "agents" ? "agents" : "people"} yet
                </p>
                <button
                  type="button"
                  onClick={() => setChatListScope("all")}
                  className="mt-2 cursor-pointer rounded-md px-2 py-1 text-[12px] leading-4 font-medium text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                >
                  Show all
                </button>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {bucketedVisibleChats.map(({ bucket, items }) => (
                  <section key={bucket} className="flex flex-col gap-0.5">
                    <p className="mb-1 px-1 text-[11px] font-medium uppercase tracking-[0.08em] text-kumo-inactive">
                      {CHAT_TIME_BUCKET_LABELS[bucket]}
                    </p>
                    {items.map((chat) => (
              <div key={chat.id} className="relative">
                {(() => {
                  const isRenaming = renamingChatId === chat.id;
                  return (
                  <div
                    onClick={isRenaming ? undefined : () => onNavigateToChat(chat.id)}
                    className={`group flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-[background-color] duration-150 ease-out ${
                      isRenaming
                        ? "cursor-default bg-kumo-base ring-1 ring-kumo-ring/40"
                        : sidebarMode && chat.id === selectedChatId
                          ? "cursor-pointer bg-kumo-recessed"
                          : "cursor-pointer hover:bg-kumo-tint"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="flex min-w-0 items-center gap-2">
                        {isRenaming ? (
                          <input
                            type="text"
                            value={renamingInput}
                            onChange={(e) => setRenamingInput(e.target.value)}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                e.preventDefault();
                                handleSaveListRename(chat.id);
                              } else if (e.key === "Escape") {
                                e.preventDefault();
                                cancelListRename();
                              }
                            }}
                            onBlur={() => handleSaveListRename(chat.id)}
                            autoFocus
                            spellCheck={false}
                            autoCapitalize="off"
                            autoCorrect="off"
                            aria-label={`Rename ${chat.title}`}
                            className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                          />
                        ) : (
                          <span className="truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                            {chat.title}
                          </span>
                        )}
                        {!isRenaming && chat.activeAgent ? (
                          <span className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-brand">
                            <span className="h-1.5 w-1.5 rounded-full bg-kumo-brand animate-pulse" />
                            Working
                          </span>
                        ) : !isRenaming && chat.hasProposedChanges ? (
                          <Tooltip content="This conversation has pending changes" asChild>
                            <span className="inline-flex flex-shrink-0 cursor-pointer items-center gap-1 text-[11px] leading-4 font-medium text-kumo-warning">
                              <span className="h-1.5 w-1.5 rounded-full bg-kumo-warning" />
                              Pending changes
                            </span>
                          </Tooltip>
                        ) : null}
                      </div>
                      <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] leading-4 text-kumo-inactive">
                        {chat.spawnerName && (
                          <>
                            <span className="truncate">Agent · {chat.spawnerName}</span>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                          </>
                        )}
                        <span className="flex-shrink-0">
                          {formatChatRowTime(chat.lastActive, bucket, chatListNow)}
                        </span>
                        {chat.totalCost != null && (
                          <>
                            <span className="flex-shrink-0" aria-hidden="true">·</span>
                            <span className="flex-shrink-0 font-mono">
                              ${chat.totalCost.toFixed(4)}
                            </span>
                          </>
                        )}
                      </div>
                    </div>
                    {!isRenaming && (
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={
                            <WorkshopIconButton
                              aria-label={`Actions for ${chat.title}`}
                              onClick={(e) => e.stopPropagation()}
                              className="!h-7 !w-7 flex-shrink-0 text-kumo-inactive opacity-0 focus:opacity-100 group-hover:opacity-100 data-[popup-open]:opacity-100"
                            >
                              <DotsThreeVertical size={14} />
                            </WorkshopIconButton>
                          }
                        />
                        <DropdownMenu.Content
                          onClick={(event) => event.stopPropagation()}
                          className="themed-floating-shadow !z-[1100] !min-w-[144px] rounded-lg border border-kumo-line bg-kumo-base p-1"
                        >
                          <DropdownMenu.Item
                            icon={<Pencil size={12} className="mr-2" />}
                            onClick={() => startListRename(chat.id, chat.title)}
                            className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] text-kumo-default transition-colors data-highlighted:bg-kumo-tint"
                          >
                            Rename
                          </DropdownMenu.Item>
                          <DropdownMenu.Item
                            icon={<Trash size={12} className="mr-2" />}
                            variant="danger"
                            onClick={() => handleDeleteChat(chat.id, chat.title)}
                            className="!h-auto rounded-md !px-2.5 !py-1.5 text-[12px] leading-4 tracking-[-0.2px] transition-colors data-highlighted:bg-kumo-danger-tint"
                          >
                            Delete
                          </DropdownMenu.Item>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    )}
                  </div>
                  );
                })()}
              </div>
                    ))}
                  </section>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* New chat input — pinned to bottom. ChatInput supplies its own
          horizontal padding, so the wrapper just adds the top divider; no
          extra p-4 (which would shrink the input vs. the in-chat composer). */}
      <div className="flex-shrink-0 border-t border-kumo-line">
        <div className={useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}>
          <ChatInput
            createCapsuleGatekeeper={(accountId, url) =>
              overseer.newGatekeeper(accountId, url)
            }
            getOverseer={getOverseer}
            onSend={handleNewChatSend}
            isAgentActive={false}
            models={availableModels}
            selectedModel={selectedModel}
            onModelChange={handleModelChange}
            showThinkingTraces={showThinkingTraces}
            onToggleThinkingTraces={toggleShowThinkingTraces}
            minRows={2}
            newChat
          />
          {/* Reserve the same height as the token/cost row to avoid layout shift. */}
          <div aria-hidden className="min-h-[1rem]" />
        </div>
      </div>
    </div>
  );

  // ─── main render ─────────────────────────────────────────────────────────────
  return (
    <div
      className={`flex h-full bg-kumo-base ${sidebarMode ? "flex-row" : "flex-col"}`}
    >
      {/* ── Sidebar mode: conversations list on the left ───────────────────── */}
      {sidebarMode && (
        <>
          <div
            className="flex flex-col border-r border-kumo-line flex-shrink-0"
            style={{ width: sidebarWidth }}
          >
            {chatListPanel}
          </div>
          {/* Resize handle */}
          <div
            className="w-1 flex-shrink-0 bg-kumo-line hover:bg-kumo-brand cursor-col-resize transition-colors relative touch-none"
            onPointerDown={handleSidebarPointerDown}
            onPointerMove={handleSidebarPointerMove}
            onPointerUp={handleSidebarPointerUp}
            onPointerCancel={handleSidebarPointerUp}
          >
            <div className="absolute inset-y-0 -left-1 -right-1" />
          </div>
        </>
      )}

      {/* ── Non-sidebar mode: show list OR chat ────────────────────────────── */}
      {!sidebarMode && selectedChatId === null ? (
        chatListPanel
      ) : selectedChatId !== null ? (
        <div className="flex-1 flex flex-col overflow-auto">
          {/* Tab bar — in sidebar mode, show Chat / Connections tabs */}
          {sidebarMode && (
            <div className="flex h-12 flex-shrink-0 items-center gap-5 border-b border-kumo-line px-4">
              <button
                type="button"
                onClick={() => setSidebarActiveTab("chat")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "chat"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Chat
              </button>
              <button
                type="button"
                onClick={() => setSidebarActiveTab("connections")}
                className={`relative flex h-full cursor-pointer items-center text-[13px] leading-[18px] tracking-[-0.25px] transition-colors ${
                  sidebarActiveTab === "connections"
                    ? "font-medium text-kumo-default after:absolute after:inset-x-1 after:bottom-0 after:h-0.5 after:rounded-full after:bg-kumo-contrast/70"
                    : "font-normal text-kumo-subtle hover:text-kumo-default"
                }`}
              >
                Connections
              </button>
            </div>
          )}

          {/* Connections tab content */}
          {sidebarMode &&
            sidebarActiveTab === "connections" &&
            renderExtraTab && (
              <div className="flex-1 overflow-auto">{renderExtraTab()}</div>
            )}

          {/* Chat content — hidden when connections tab is active in sidebar mode */}
          {(!sidebarMode || sidebarActiveTab === "chat") && (
            <>
              {/* Chat sub-header — hidden in sidebar mode (list is always visible) */}
              {!sidebarMode && (
                <div className="flex h-12 flex-shrink-0 items-center justify-between gap-2 border-b border-kumo-line px-4">
                  <WorkshopIconButton
                    onClick={() => onNavigateToChat(null)}
                    className="!h-8 !w-8 flex-shrink-0"
                    title="Back to conversations"
                    aria-label="Back to conversations"
                  >
                    <CaretLeft size={14} />
                  </WorkshopIconButton>

                  {isEditingTitle ? (
                    <div className="flex items-center gap-1 flex-1 min-w-0">
                      <WorkshopInput
                        type="text"
                        value={titleInput}
                        onChange={(e) => setTitleInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") handleSaveChatTitle();
                          if (e.key === "Escape") handleCancelTitleEdit();
                        }}
                        autoFocus
                        className="!h-8 min-w-0 flex-1 bg-kumo-tint text-[13px] font-medium"
                      />
                      <WorkshopIconButton
                        onClick={handleSaveChatTitle}
                        disabled={!titleInput.trim()}
                        className="!h-8 !w-8 hover:text-kumo-brand disabled:opacity-30"
                        aria-label="Save chat title"
                      >
                        <Check size={13} />
                      </WorkshopIconButton>
                      <WorkshopIconButton
                        onClick={handleCancelTitleEdit}
                        className="!h-8 !w-8"
                        aria-label="Cancel title edit"
                      >
                        <X size={13} />
                      </WorkshopIconButton>
                    </div>
                  ) : (
                    <>
                      <span className="min-w-0 flex-1 truncate text-[13px] leading-[18px] font-medium tracking-[-0.25px] text-kumo-default">
                        {currentChatMetadata?.title || "Chat"}
                      </span>
                      <WorkshopIconButton
                        onClick={() => setIsEditingTitle(true)}
                        className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive hover:text-kumo-subtle"
                        title="Rename chat"
                        aria-label="Rename chat"
                      >
                        <Pencil size={11} />
                      </WorkshopIconButton>
                    </>
                  )}

                  <WorkshopIconButton
                    onClick={() => handleDeleteChat()}
                    danger
                    className="!h-8 !w-8 flex-shrink-0 text-kumo-inactive"
                    title="Delete chat"
                    aria-label="Delete chat"
                  >
                    <Trash size={14} />
                  </WorkshopIconButton>
                </div>
              )}

              {/* Messages */}
              <div
                ref={messagesContainerRef}
                onScroll={handleMessagesScroll}
                className="flex-1 overflow-y-auto chat-panel"
              >
                {isLoading ? (
                  <div className="flex items-center justify-center py-10">
                    <div className="w-5 h-5 border-2 border-kumo-brand border-t-transparent rounded-full animate-spin" />
                  </div>
                ) : (
                  <div
                    className={`flex flex-col px-6 pt-8 ${pendingConsoleLogCount > 0 ? "pb-16" : "pb-8"} ${useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}`}
                  >
                    {isLoadingEarlier && (
                      <div className="mx-auto mb-6 text-[12px] leading-4 font-medium text-kumo-inactive">
                        Loading earlier messages…
                      </div>
                    )}

                    {displayEntries.map((entry, entryIndex) => {
                      const entryTopClass = entryTopClasses[entryIndex] ?? "";
                      if (entry.type === "compactionCut") {
                        // Only meaningful alongside the summary it belongs to, which is announced
                        // further down; on its own it would be a line with nothing to explain it.
                        if (!expandedCompactions.has(entry.boundary.to)) return null;
                        return (
                          <div key={entry.key} className={`${entryTopClass} mb-4 max-w-[860px]`}>
                            <div className="flex items-center gap-3" role="separator">
                              <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
                              <span className="flex-shrink-0 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase">
                                Kept in full from here
                              </span>
                              <span className="h-px flex-1 bg-kumo-line/60" aria-hidden="true" />
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "compactionBoundary") {
                        const expanded = expandedCompactions.has(entry.boundary.to);
                        const kept = entry.keptRows;
                        const summary = (
                          <div className="themed-surface-inset mt-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3.5">
                            {kept !== undefined && (
                              // Says what the agent traded away and what it still has, since the
                              // marker sits at the request rather than at the cut it describes.
                              <p className="mb-3 text-[12px] leading-[17px] text-kumo-subtle">
                                The agent reads this in place of everything earlier in the chat.{" "}
                                {kept === 0
                                  ? "Nothing after it was kept."
                                  : `The ${kept === 1 ? "message" : `${kept} messages`} after the cut ${kept === 1 ? "was" : "were"} kept in full.`}
                              </p>
                            )}
                            <div className={`min-w-0 text-[13px] leading-[19px] ${styles.markdownContent}`}>
                              <MarkdownMessage message={entry.boundary.summary} />
                            </div>
                          </div>
                        );

                        // Announced at the user's request: an event where they asked, not a rule
                        // across the thread. The rule belongs at the cut, and appears there when
                        // this is opened.
                        if (entry.requestedBy) {
                          return (
                            <div key={entry.key} className={`${entryTopClass} max-w-[860px] py-1`}>
                              <button
                                type="button"
                                onClick={() => toggleCompactionSummary(entry.boundary.to)}
                                aria-expanded={expanded}
                                className="inline-flex cursor-pointer items-center gap-3 rounded-md px-1.5 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                              >
                                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                  <Brain size={16} />
                                </span>
                                <span className="font-medium">
                                  {entry.requestedBy.name} compacted the context
                                </span>
                                <CaretRight
                                  size={11}
                                  weight="bold"
                                  className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                />
                              </button>
                              {expanded && summary}
                            </div>
                          );
                        }

                        return (
                          <div key={entry.key} className={`${entryTopClass} mb-4 max-w-[860px]`}>
                            <div className="flex items-center gap-3" role="separator" aria-label="Context compacted">
                              <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                              <button
                                type="button"
                                onClick={() => toggleCompactionSummary(entry.boundary.to)}
                                aria-expanded={expanded}
                                className="flex flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1 py-0.5 text-[11px] leading-4 font-medium tracking-[0.6px] text-kumo-inactive uppercase transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none"
                              >
                                <Brain size={13} aria-hidden="true" />
                                Context compacted
                                <CaretRight
                                  size={11}
                                  weight="bold"
                                  className={`transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                />
                              </button>
                              <span className="h-px flex-1 bg-kumo-line" aria-hidden="true" />
                            </div>
                            {expanded && summary}
                          </div>
                        );
                      }

                      if (entry.type === "modelChange") {
                        return (
                          <div key={entry.key} className={`${entryTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <Swap size={16} />
                              </span>
                              <span className="min-w-0 truncate">
                                Switched to {entry.author.name}
                              </span>
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "savedChanges") {
                        const isOwnChange = entry.message.author.id === currentUser?.id;
                        const actor = isOwnChange ? "You" : entry.message.author.name;
                        // A user-authored creation is recorded as a "changes" message carrying
                        // createdGadgets over a no-op update, so label it as a creation rather
                        // than as saved edits.
                        const createdGadgets = entry.message.createdGadgets ?? [];
                        const label = createdGadgets.length > 0
                          ? `${actor} created ${createdGadgets.length === 1 ? "gadget" : "gadgets"} ${
                              createdGadgets.map((g) => `“${g.title}”`).join(", ")}`
                          : `${actor} saved edits`;
                        const discardLabel = getSavedEditsDiscardLabel(
                          entry.message.sequence === lastDurablePendingChange?.sequence,
                          createdGadgets.map((g) => g.title),
                        );
                        return (
                          <div key={entry.key} className={`${entryTopClass} group/savedChanges max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <PencilSimple size={15} />
                              </span>
                              <span className="min-w-0 truncate font-medium">
                                {label}
                              </span>
                              <div className="flex flex-shrink-0 items-center gap-1 opacity-0 transition-opacity duration-150 ease-out group-hover/savedChanges:opacity-100 group-focus-within/savedChanges:opacity-100">
                                <Tooltip content={discardLabel} asChild>
                                  <button
                                    type="button"
                                    disabled={isAgentActive}
                                    onClick={() => handleRevertChanges(entry.message.sequence)}
                                    className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                    aria-label={discardLabel}
                                  >
                                    <ArrowUUpLeft size={15} />
                                  </button>
                                </Tooltip>
                                <Tooltip content={formatFullTimestamp(entry.message.timestamp)} asChild>
                                  <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                    {entry.message.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              </div>
                            </div>
                          </div>
                        );
                      }

                      if (entry.type === "workRun") {
                        const pendingChange =
                          pendingChangeByTurnItemSeq.get(entry.lastMessageSequence) ?? null;
                        const createdGadgets =
                          createdGadgetsByTurnItemSeq.get(entry.lastMessageSequence) ?? [];
                        const showFooterOnGroupIndex = pendingChange
                          ? entry.toolCallGroups.length - 1
                          : -1;
                        return (
                          <div key={entry.key} className={`${entryTopClass} min-w-0 w-full max-w-[860px] space-y-2`}>
                            {entry.toolCallGroups.map((group, groupIndex) => (
                              <ToolGroupRow
                                outputOf={resolveToolOutput}
                                key={group.key}
                                group={group}
                                open={expandedToolCalls.has(group.key)}
                                expandedKeys={expandedToolCalls}
                                onToggle={toggleToolCallExpansion}
                                footerChangeSequence={
                                  groupIndex === showFooterOnGroupIndex
                                    ? pendingChange?.revertFrom
                                    : undefined
                                }
                                footerTimestamp={
                                  groupIndex === showFooterOnGroupIndex
                                    ? entry.lastMessageTimestamp
                                    : undefined
                                }
                                footerIsTrailing={
                                  pendingChange?.through === lastDurablePendingChange?.sequence
                                }
                                footerCreatedGadgetTitles={
                                  groupIndex === showFooterOnGroupIndex
                                    ? pendingChange?.createdGadgetTitles
                                    : undefined
                                }
                                footerDisabled={isAgentActive}
                                onFooterRevert={handleRevertChanges}
                              />
                            ))}
                            {createdGadgets.map((created) => (
                              <CreatedGadgetChatCard
                                key={created.gadgetId}
                                gadget={created}
                                onOpen={() => onOpenGadget(created.gadgetId)}
                              />
                            ))}
                          </div>
                        );
                      }

                      const msg = entry.message;

                      return (
                        <div key={entry.key} className={entryTopClass}>
                        {/* ── user / AI text message ── */}
                        {msg.type === "slashCommand" && (
                          <div className="group/message relative flex flex-col items-end">
                            <div className="themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default">
                              <span className="whitespace-pre-wrap">
                                <SlashCommandMention
                                  name={msg.skillName}
                                  args={msg.request.args}
                                  id={msg.request.id}
                                  commandPosition={msg.request.commandPosition}
                                  getOverseer={getOverseer}
                                />
                              </span>
                            </div>
                            <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-0 transition-opacity duration-150 ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                              {!(hideOwnUserName && msg.author.id === currentUser?.id) && (
                                <span className="font-medium">{msg.author.name}</span>
                              )}
                              <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                <span className="font-mono">
                                  {msg.timestamp.toLocaleTimeString([], {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  })}
                                </span>
                              </Tooltip>
                            </div>
                          </div>
                        )}
                        {msg.type === "message" && (
                          msg.author.type === "user" ? (
                            <div className="group/message relative flex flex-col items-end">
                              <div className={`themed-user-bubble-shadow w-fit max-w-[min(680px,78%)] rounded-[24px] rounded-br-lg border border-transparent bg-kumo-bubble-user px-4 py-2.5 text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                {msg.attachments && msg.attachments.length > 0 && (
                                  <ChatAttachmentGrid
                                    attachments={msg.attachments}
                                    onDownload={(attachment) => { void downloadChatAttachment(msg.chatId, attachment); }}
                                  />
                                )}
                                {entry.slashCommand ? (
                                  // What the command expanded into is the agent's context, not
                                  // something to re-read here.
                                  <div className="whitespace-pre-wrap">
                                    <SlashCommandMention
                                      name={entry.slashCommand.skillName}
                                      args={entry.slashCommand.request.args}
                                      id={entry.slashCommand.request.id}
                                      commandPosition={entry.slashCommand.request.commandPosition}
                                      formats={msg.formats}
                                      getOverseer={getOverseer}
                                    />
                                  </div>
                                ) : msg.message.trim() && (
                                  // pre-wrap renders users' single newlines as hard breaks.
                                  <div className="whitespace-pre-wrap">
                                    <MarkdownMessage
                                      message={msg.message}
                                      capsules={msg.capsules}
                                      formats={msg.formats}
                                    />
                                  </div>
                                )}
                              </div>
                              <div className="mt-0.5 flex items-center justify-end gap-2 pr-1 text-[11px] leading-4 text-kumo-inactive opacity-0 transition-opacity duration-150 ease-out group-hover/message:opacity-100 group-focus-within/message:opacity-100">
                                {/* hideOwnUserName implies currentUser is non-null (see memo). */}
                                {!(hideOwnUserName && msg.author.id === currentUser?.id) && (
                                  <span className="font-medium">{msg.author.name}</span>
                                )}
                                <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                  <span className="font-mono">
                                    {msg.timestamp.toLocaleTimeString([], {
                                      hour: "2-digit",
                                      minute: "2-digit",
                                    })}
                                  </span>
                                </Tooltip>
                              </div>
                            </div>
                          ) : (() => {
                            const messageToolGroups = entry.toolCallGroups;
                            const hasMessageText = msg.message.trim().length > 0;
                            const showReasoning = showThinkingTraces && !!msg.reasoning;
                            const actionMessageSeq = entry.lastMessageSequence ?? msg.sequence;
                            const pendingChange = pendingChangeByTurnItemSeq.get(
                              actionMessageSeq,
                            ) ?? null;
                            const createdGadgets =
                              createdGadgetsByTurnItemSeq.get(actionMessageSeq) ?? [];
                            const attachActionsToToolGroups =
                              !hasMessageText &&
                              !!pendingChange &&
                              !!messageToolGroups &&
                              messageToolGroups.length > 0;
                            const showActions =
                              completedAgentTurnMessageSeqs.has(actionMessageSeq) &&
                              (hasMessageText || (!!pendingChange && !attachActionsToToolGroups));
                            const keepActionsVisible =
                              actionMessageSeq === latestCompletedAgentTurnMessageSeq;
                            const showFooterOnGroupIndex = attachActionsToToolGroups && pendingChange && messageToolGroups
                              ? messageToolGroups.length - 1
                              : -1;
                            return (
                          <div className="min-w-0 w-full max-w-[860px] space-y-2">
                            <div className="group/agentMessage relative space-y-1.5">
                              {showReasoning && (
                                <ThinkingTraceRow reasoning={msg.reasoning!} />
                              )}

                              {hasMessageText && (
                                <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                                  <MarkdownMessage
                                    message={msg.message}
                                    capsules={msg.capsules}
                                    formats={msg.formats}
                                  />
                                </div>
                              )}

                              {showActions && (
                                <div className={`mt-0.5 -ml-1 flex items-center gap-1 transition-opacity duration-150 ease-out ${
                                  keepActionsVisible
                                    ? "opacity-100"
                                    : "opacity-0 group-hover/agentMessage:opacity-100 group-focus-within/agentMessage:opacity-100"
                                }`}>
                                  {hasMessageText && (
                                    <Tooltip content="Copy message" asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleCopyMessage(msg.message)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96]"
                                        aria-label="Copy message"
                                      >
                                        <Copy size={15} />
                                      </button>
                                    </Tooltip>
                                  )}
                                  {pendingChange && (() => {
                                    const label = getDiscardLabel(
                                      pendingChange.through === lastDurablePendingChange?.sequence,
                                      pendingChange.createdGadgetTitles,
                                    );
                                    return (
                                    <Tooltip content={label} asChild>
                                      <button
                                        type="button"
                                        disabled={isAgentActive}
                                        onClick={() => handleRevertChanges(pendingChange.revertFrom)}
                                        className="flex cursor-pointer items-center rounded-md p-1 text-kumo-inactive transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-40"
                                        aria-label={label}
                                      >
                                        <ArrowUUpLeft size={15} />
                                      </button>
                                    </Tooltip>
                                    );
                                  })()}
                                  <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                    <span className="px-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                                      {msg.timestamp.toLocaleTimeString([], {
                                        hour: "2-digit",
                                        minute: "2-digit",
                                      })}
                                    </span>
                                  </Tooltip>
                                </div>
                              )}
                            </div>

                            {createdGadgets.map((created) => (
                              <CreatedGadgetChatCard
                                key={created.gadgetId}
                                gadget={created}
                                onOpen={() => onOpenGadget(created.gadgetId)}
                              />
                            ))}

                            {messageToolGroups && messageToolGroups.length > 0 && (
                              <div className="space-y-1">
                                {messageToolGroups.map((group, groupIndex) => (
                                  <ToolGroupRow
                                    outputOf={resolveToolOutput}
                                    key={group.key}
                                    group={group}
                                    open={expandedToolCalls.has(group.key)}
                                    expandedKeys={expandedToolCalls}
                                    onToggle={toggleToolCallExpansion}
                                    footerChangeSequence={
                                      groupIndex === showFooterOnGroupIndex
                                        ? pendingChange?.revertFrom
                                        : undefined
                                    }
                                    footerTimestamp={
                                      groupIndex === showFooterOnGroupIndex
                                        ? msg.timestamp
                                        : undefined
                                    }
                                    footerIsTrailing={
                                      pendingChange?.through === lastDurablePendingChange?.sequence
                                    }
                                    footerCreatedGadgetTitles={
                                      groupIndex === showFooterOnGroupIndex
                                        ? pendingChange?.createdGadgetTitles
                                        : undefined
                                    }
                                    footerDisabled={isAgentActive}
                                    onFooterRevert={handleRevertChanges}
                                  />
                                ))}
                              </div>
                            )}
                          </div>
                            );
                          })()
                        )}

                        {(msg.type === "merge" || msg.type === "revert") &&
                          (() => {
                            const isMerge = msg.type === "merge";
                            const ts = isMerge
                              ? messageStates.mergeTimestamps.get(msg.sequence)
                              : messageStates.revertTimestamps.get(
                                  msg.sequence,
                                );
                            return (
                              <div className="max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <Tooltip
                                  content={
                                    isMerge
                                      ? `Accepted draft changes${ts ? ` through ${formatFullTimestamp(ts)}` : ""}.`
                                      : `Returned to the gadget state before the prompt sent ${ts ? `at ${ts.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "earlier"}.`
                                  }
                                  asChild
                                >
                                  <span className="inline-flex items-center gap-3 px-1.5">
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                      {isMerge ? <Check size={16} /> : <ArrowUUpLeft size={16} />}
                                    </span>
                                    <span className="font-medium">
                                      {msg.author.name}{" "}
                                      {isMerge
                                        ? "accepted changes"
                                        : "discarded changes"}
                                    </span>
                                  </span>
                                </Tooltip>
                              </div>
                            );
                          })()}

                        {msg.type === "action" && renderActionCard(msg)}

                        {msg.type === "connectionRequest" && renderConnectionRequestCard(msg)}

                        {msg.type === "useGadget" && (
                          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                            <Tooltip content={`Used the gadget at ${formatFullTimestamp(msg.timestamp)}`} asChild>
                              <span className="inline-flex items-center gap-3 px-1.5 py-1">
                                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                  <Plug size={16} />
                                </span>
                                <span>Used the gadget</span>
                              </span>
                            </Tooltip>
                          </div>
                        )}

                        {msg.type === "error" &&
                          (() => {
                            const key = `${msg.chatId}-${msg.sequence}`;
                            const isLast =
                              msg.sequence === lastMessageSequence &&
                              !isAgentActive;
                            const expanded = expandedErrors.has(key);
                            return (
                              <div className="group/work max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                                <div className="flex w-full items-center gap-2 px-1.5 py-1">
                                  <button
                                    type="button"
                                    onClick={() => toggleErrorExpansion(key)}
                                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md text-left transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={expanded}
                                  >
                                    <Tooltip content={formatFullTimestamp(msg.timestamp)} asChild>
                                      <span className="flex min-w-0 flex-1 items-center gap-2">
                                        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-danger" aria-hidden="true">
                                          <WarningCircle size={16} weight="fill" />
                                        </span>
                                        <span className="flex min-w-0 flex-1 items-center gap-1">
                                          <span className="min-w-0 truncate">
                                            <span className="font-medium text-kumo-danger">Error: </span>
                                            <span className="text-kumo-subtle">{msg.message}</span>
                                          </span>
                                          <CaretRight
                                            size={13}
                                            weight="bold"
                                            className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${expanded ? "rotate-90" : ""}`}
                                          />
                                        </span>
                                      </span>
                                    </Tooltip>
                                  </button>
                                  {isLast && msg.code === "usage_limit" && (
                                    <Tooltip content="Add credits to continue." asChild>
                                      <button
                                        type="button"
                                        onClick={() => setUsageModalOpen(true)}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98]"
                                      >
                                        <Lightning size={12} weight="bold" />
                                        Continue
                                      </button>
                                    </Tooltip>
                                  )}
                                  {isLast && msg.code !== "usage_limit" && (
                                    <Tooltip content="Retry the last action." asChild>
                                      <button
                                        type="button"
                                        onClick={() => handleRetry()}
                                        disabled={selectedModel === null}
                                        className="flex flex-shrink-0 cursor-pointer items-center gap-1 rounded-md px-1 py-0.5 text-[13px] leading-4 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                      >
                                        <ArrowsClockwise size={12} weight="bold" />
                                        Retry
                                      </button>
                                    </Tooltip>
                                  )}
                                </div>
                                {expanded && (
                                  <div className="ml-8 mt-1">
                                    <pre className="max-h-48 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                      {msg.message}
                                    </pre>
                                  </div>
                                )}
                              </div>
                            );
                          })()}

                        {msg.type === "agentCallback" && (
                          <div className="max-w-[860px] text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle">
                            <div className="flex items-center gap-3 px-1.5 py-1">
                              <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                                <Code size={16} />
                              </span>
                              <span className="min-w-0 truncate font-mono text-[13px]">
                                self.{msg.methodName}()
                              </span>
                            </div>
                            {msg.argsSummary && (
                              <div className="ml-8 mt-1">
                                <pre className="max-h-24 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                  {msg.argsSummary}
                                </pre>
                              </div>
                            )}
                          </div>
                        )}
                        </div>
                      );
                    })}

                    {currentDraftState && currentDraftState.entries.length > 0 && (() => {
                      const latestAuthor = currentDraftState.latestAuthor;
                      const isUserAuthored = latestAuthor?.type === "user";
                      const title = isUserAuthored
                        ? "Draft changes pending"
                        : "Draft changes in progress";
                      const description = isUserAuthored
                        ? "Your edits are still a live draft."
                        : `${latestAuthor?.name ?? "The agent"} is editing changes for this gadget.`;
                      const lastDraftEntry =
                        currentDraftState.entries[
                          currentDraftState.entries.length - 1
                        ];
                      const lastEntry = displayEntries[displayEntries.length - 1] ?? null;
                      const draftTopClass = !lastEntry
                        ? ""
                        : isUserMessageEntry(lastEntry)
                          ? "mt-6"
                          : entryEndsInWorkRow(lastEntry)
                            ? "mt-2"
                            : "mt-4";
                      return (
                        <div className={`${draftTopClass} max-w-[860px] py-1 text-[14px] leading-5 tracking-[-0.25px] text-kumo-subtle`}>
                          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-1.5">
                            <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center text-kumo-inactive" aria-hidden="true">
                              <Pencil size={16} />
                            </span>
                            <Tooltip
                              content={`${description} Last edited ${formatFullTimestamp(lastDraftEntry.timestamp)}`}
                              asChild
                            >
                              <span className="font-medium text-kumo-subtle">
                                {title}
                              </span>
                            </Tooltip>
                            <div className="flex flex-wrap items-center gap-2 text-[13px] leading-4">
                              <Tooltip content="Throw away these draft edits." asChild>
                                <button
                                  type="button"
                                  disabled={isAgentActive}
                                  onClick={handleDiscardDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-inactive transition-colors duration-150 ease-out hover:text-kumo-danger focus-visible:text-kumo-danger focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Discard
                                </button>
                              </Tooltip>
                              <Tooltip content="Save these edits as a draft version. They won't affect the gadget until you accept changes." asChild>
                                <button
                                  type="button"
                                  disabled={isAgentActive}
                                  onClick={handleFinalizeDraftChanges}
                                  className="cursor-pointer rounded-md px-1 py-0.5 font-medium text-kumo-default transition-[color,opacity,transform] duration-150 ease-out hover:text-kumo-default-hover focus-visible:text-kumo-default-hover focus-visible:outline-none active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  Save draft
                                </button>
                              </Tooltip>
                            </div>
                          </div>
                        </div>
                      );
                    })()}

                    {isAgentActive && activeAgent && (() => {
                      // Placeholder shown only while the agent is active but hasn't produced
                      // visible output yet; once real output appears, that speaks for itself.
                      const hasShownReasoning =
                        showThinkingTraces && !!currentProvisionalState?.reasoning;
                      // Only while awaiting the agent's first output this turn; otherwise it
                      // flashes again in the gap after the last message finalizes but before
                      // isAgentActive clears.
                      const lastMessage =
                        currentMessages.length > 0
                          ? currentMessages[currentMessages.length - 1]
                          : null;
                      const awaitingFirstResponse =
                        !lastMessage ||
                        lastMessage.author.type === "user" ||
                        lastMessage.author.type === "gadget";
                      const showThinking =
                        !isCompacting &&
                        awaitingFirstResponse &&
                        !currentProvisionalState?.text &&
                        !hasShownReasoning &&
                        provisionalToolCalls.length === 0;

                      // Match the spacing this response gets once finalized (see rhythmTopClass)
                      // so it doesn't shift when streaming completes.
                      const lastEntry =
                        displayEntries.length > 0
                          ? displayEntries[displayEntries.length - 1]
                          : null;
                      const provisionalTopClass = !lastEntry
                        ? ""
                        : lastEntry.type === "modelChange"
                          ? "mt-2"
                          : isUserMessageEntry(lastEntry)
                            ? "mt-5"
                            : "mt-4";

                      return (
                        <div className={`group/agent min-w-0 w-full max-w-[860px] space-y-2 ${provisionalTopClass}`}>
                          {isCompacting && (
                            <div className={`inline-flex px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] ${styles.thinkingShimmer}`}>
                              Compacting…
                            </div>
                          )}

                          {showThinking && (
                            <div className={`inline-flex px-1.5 py-1 text-[14px] leading-5 tracking-[-0.25px] ${styles.thinkingShimmer}`}>
                              Thinking
                            </div>
                          )}

                          {showThinkingTraces && currentProvisionalState?.reasoning && (
                            <ThinkingTraceRow reasoning={currentProvisionalState.reasoning} />
                          )}

                          {currentProvisionalState?.text && (
                            <div className={`text-[14px] leading-[22px] tracking-[-0.25px] text-kumo-default ${styles.markdownContent}`}>
                              <MarkdownMessage message={currentProvisionalState.text} />
                            </div>
                          )}

                          {provisionalToolCalls.length > 0 && (() => {
                            const first = provisionalToolCalls[0];
                            const { label, detailLines } =
                              buildProvisionalToolSummary(provisionalToolCalls);
                            const expansionKey = `group-${first.toolCallId}`;
                            const isExpanded = expandedToolCalls.has(expansionKey);
                            const detailCalls = provisionalToolCalls.filter(
                              (t) => t.code || t.output,
                            );
                            return (
                              <div className="space-y-1">
                                <div className="group/work -ml-0.5">
                                  <button
                                    type="button"
                                    onClick={() => toggleToolCallExpansion(expansionKey)}
                                    className="flex w-full cursor-pointer items-center gap-3 rounded-xl px-1.5 py-1 text-left text-kumo-subtle transition-colors duration-150 ease-out hover:text-kumo-default focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.995]"
                                    aria-expanded={isExpanded}
                                  >
                                    <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center">
                                      <WorkIcon Icon={getToolIcon(first.toolName, first.outputFormat)} />
                                    </span>
                                    <span className="min-w-0 flex-1">
                                      <span className="flex min-w-0 items-center gap-2 text-[14px] leading-5 tracking-[-0.25px]">
                                        <span className="min-w-0 truncate">{label}</span>
                                        <CaretRight
                                          size={13}
                                          weight="bold"
                                          className={`flex-shrink-0 text-kumo-inactive transition-transform duration-150 ease-out ${isExpanded ? "rotate-90" : ""}`}
                                        />
                                      </span>
                                      {detailLines.length > 1 && (
                                        <span className="mt-1 block truncate font-mono text-[12px] leading-4 text-kumo-inactive">
                                          {detailLines.join(" · ")}
                                        </span>
                                      )}
                                    </span>
                                  </button>
                                  {isExpanded && detailCalls.length > 0 && (
                                    <div className="ml-8 mt-1 space-y-1">
                                      {detailCalls.map((toolCall) => (
                                        <div
                                          key={`stream-tool-${toolCall.toolCallId}`}
                                          className="themed-surface-inset space-y-3 rounded-2xl border border-kumo-line/70 bg-kumo-elevated/45 p-3"
                                        >
                                          {toolCall.code && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Code</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.code}
                                              </pre>
                                            </>
                                          )}
                                          {toolCall.output && (
                                            <>
                                              <span className="font-mono text-[11px] leading-4 text-kumo-inactive uppercase tracking-[0.08em]">Output</span>
                                              <pre className="max-h-56 overflow-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-3 font-mono text-[12px] leading-[18px] text-kumo-subtle whitespace-pre-wrap">
                                                {toolCall.output}
                                              </pre>
                                            </>
                                          )}
                                        </div>
                                      ))}
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })()}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* ── Bottom: input, update state, and cost ──────────────── */}
              <div className={`flex-shrink-0 bg-kumo-base ${sidebarMode ? "" : "border-t border-kumo-line"}`}>
                <div className={useConstrainedChatWidth ? "mx-auto w-full max-w-[920px]" : ""}>
                  <ChatInput
                    chatKey={selectedChatId}
                    createCapsuleGatekeeper={(accountId, url) =>
                      overseer.newGatekeeper(accountId, url)
                    }
                    getOverseer={getOverseer}
                    onSend={handleSend}
                    isAgentActive={isAgentActive}
                    models={availableModels}
                    selectedModel={selectedModel}
                    onModelChange={handleModelChange}
                    pendingConsoleLogCount={pendingConsoleLogCount}
                    consoleLogPreview={consoleLogPreview}
                    consoleLogSeverity={consoleLogSeverity}
                    onConsumeConsoleLogs={onConsumeConsoleLogs}
                    onDiscardConsoleLogs={onDiscardConsoleLogs}
                    onStop={handleStop}
                    showThinkingTraces={showThinkingTraces}
                    onToggleThinkingTraces={toggleShowThinkingTraces}
                    blockedReason={
                      hasPendingConnectionRequest
                        ? "Set up or deny the connection request above to continue."
                        : hasPendingAwaitedAction
                          ? "Approve or reject the pending action above to continue."
                          : undefined
                    }
                    draftUpdateBanner={(() => {
                      if (!currentChatMetadata?.hasProposedChanges) return null;

                      // Accept through the newest still-proposed batch, but never below the cut the
                      // server seeds the compacted prefix at. That prefix is accepted as a unit, so
                      // addressing anything under it drains nothing -- which is reachable both when
                      // it only created gadgets (no Yjs bytes, hence no entry here) and when paging
                      // backward leaves the newest loaded batch below the boundary. Discard-all uses
                      // sequence zero because compacted batches retain their original, earlier
                      // sequences; the synthetic prefix sequence is only meaningful when merging.
                      const { activeChanges } = messageStates;
                      const cuts = [
                        ...(activeChanges.length > 0
                          ? [activeChanges[activeChanges.length - 1].sequence] : []),
                        ...(currentChatMetadata.compactedTo !== undefined
                          ? [currentChatMetadata.compactedTo - 1] : []),
                      ];
                      if (cuts.length === 0) return null;
                      const mergeThrough = Math.max(...cuts);
                      const isDiscardingChanges = discardingChangesChatIds.has(
                        currentChatMetadata.id,
                      );
                      const changesActionsDisabled = isAgentActive || isDiscardingChanges;
                      return (
                        <div className="themed-surface-inset relative flex items-center gap-2 overflow-hidden rounded-t-[calc(1rem-1px)] border-b border-kumo-line bg-kumo-elevated px-3.5 py-2">
                          <span className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-kumo-brand/40 to-transparent" aria-hidden="true" />
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium leading-4 tracking-[-0.2px] text-kumo-default">
                            Pending changes
                          </span>
                          <DiscardPendingChangesPopover
                            open={discardChangesTarget?.chatId === currentChatMetadata.id}
                            disabled={changesActionsDisabled}
                            isDiscarding={isDiscardingChanges}
                            onOpenChange={(open) => {
                              if (isDiscardingChanges) return;
                              setDiscardChangesTarget(open ? {
                                chatId: currentChatMetadata.id,
                              } : null);
                            }}
                            onConfirm={handleDiscardPendingChanges}
                          />
                          <Tooltip content={isAgentActive
                            ? "Wait for the agent to finish before accepting changes."
                            : isDiscardingChanges
                              ? "Wait for pending changes to finish discarding."
                              : "Keep this draft and make it the gadget's current version."} asChild>
                            <WorkshopButton
                              disabled={changesActionsDisabled}
                              onClick={() =>
                                handleMergeChanges(mergeThrough, { includeDraft: true })
                              }
                              tone="primary"
                              className="!h-7 !cursor-pointer !rounded-md !border-transparent !shadow-none gap-1 text-[12px]"
                            >
                              <Check size={11} weight="bold" />
                              Accept changes
                            </WorkshopButton>
                          </Tooltip>
                        </div>
                      );
                    })()}
                  />

                  {/* Token / cost summary. */}
                  <div className="-mt-1 flex min-h-[1.25rem] items-start justify-end gap-4 px-4 pb-1 font-mono text-[11px] leading-4 text-kumo-inactive">
                    {currentChatMetadata?.totalTokens != null && (
                      <span>
                        {currentChatMetadata.totalTokens.toLocaleString()} tokens
                      </span>
                    )}
                    {currentChatMetadata?.totalCost != null && (
                      <span>${currentChatMetadata.totalCost.toFixed(4)}</span>
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      ) : null}

      <DeleteConfirmationDialog
        open={deleteTarget !== null}
        title="Delete conversation?"
        description={<>This removes <span className="font-medium text-kumo-default">{deleteTarget?.title}</span>. You can&apos;t undo this.</>}
        isDeleting={isDeleting}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
        onConfirm={handleDeleteConfirm}
      />

      {autoApproveConfirm && (
        <AutoApproveConfirmDialog
          open
          actionLabel={autoApproveConfirm.actionLabel}
          resourceTitle={autoApproveConfirm.resourceTitle}
          isProcessing={processingActions.has(autoApproveConfirm.actionId)}
          onOpenChange={(open) => {
            if (!open) setAutoApproveConfirm(null);
          }}
          onConfirm={async () => {
            const { actionId, gatekeeperId, actionKind } = autoApproveConfirm;
            if (await alwaysApproveTag(actionId, gatekeeperId, actionKind)) {
              setAutoApproveConfirm(null);
            }
          }}
        />
      )}

      {/* Accept flow for an agent connection request: pre-seeds the gatekeeper modal and, on
          creation, finalizes the request so the agent resumes. */}
      <GatekeeperModal
        open={connectionAccept !== null}
        onClose={() => setConnectionAccept(null)}
        getOverseer={getOverseer}
        onCreated={handleConnectionCreated}
        initialVendorId={connectionAccept?.vendorId}
        initialResourceUrl={connectionAccept?.resourceUrl}
        initialResourceUrlPattern={connectionAccept?.resourceUrlPattern}
      />
      <OutOfCreditsModal
        open={usageModalOpen}
        onClose={() => setUsageModalOpen(false)}
      />
    </div>
  );
}

export default ChatInterface;
