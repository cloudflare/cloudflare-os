import {
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
} from "react";
import { DropdownMenu, Tooltip, useKumoToastManager } from "@cloudflare/kumo";
import { Brain, CaretDown, Check, File as FileIcon, Plug, Plus, X } from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  GatekeeperClient,
  MessageFormatRef,
  OutputFormatOffer,
  OutputIcon,
  Overseer,
  SlashCommandChoice,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import type { ResourceDescription } from "@gadgets/workshop-shared/gatekeeper";
import { isTransientRpcError } from "../../../rpcErrors";
import { reportIssue } from "../../../errorReporting";
import {
  parseSlashCommandInput, slashCommandTokenKey, stripSlashCommandToken,
} from "../../../components/chat/slash-command-input";
import {
  ComposerMirror, composerTextareaClass, type ComposerMirrorHandle, type MirrorToken,
} from "../../../components/chat/ComposerMirror";
import { slashCommandKey } from "../../../components/chat/slash-command-catalog";
import {
  removeComposerToken, snapCaretOutOfRanges, spliceComposerToken, type ComposerRange,
} from "../../../components/chat/composer-tokens";
import CapsuleOverlay, { CAPSULE_OVERLAY_GAP } from "../../../CapsuleOverlay";
import type { SelectableItem } from "../../../ResourcePicker";
import GatekeeperModal from "../../../GatekeeperModal";
import { formatIconDataUrl } from "../../../components/format/formatIconImage";
import { locateMessageFormatRefs } from "../../../components/format/messageFormatRefs";
import ComposerFormatMenuItems from "../../../components/format/ComposerFormatMenuItems";
import { WorkshopIconButton } from "../../../components/WorkshopControls";
import { handlePickerKeyDown } from "../../../pickerNavigation";
import { normalizeResourceUrl } from "../../../resourceMatching";
import { useAuthenticatedApi } from "../../../AuthContext";
import { useVendorBranding } from "../../../useVendorBranding";
import { useSlashCommandPicker } from "../../../components/chat/SlashCommandPicker";
import { isImeComposing } from "../../../keyboardEvent";
import {
  decorateComposerDraft,
  readComposerDraft,
  serializeComposerDraft,
  writeComposerDraft,
  type StoredComposerDraft,
} from "../../../composerDraft";
import { formatAttachmentSize } from "../attachmentFormatting";
import styles from "./ChatComposer.module.css";

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

// Internal capsule state tracked within ChatComposer (not yet sent).
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
  noun: string;
  icon: OutputIcon;
  // Data URL for the format's icon, painted into the token's logo slot. Absent if it couldn't be
  // rendered, in which case the token carries no slot either.
  logo?: string;
};

function formatTokensFromDraft(draft: StoredComposerDraft | undefined): FormatToken[] {
  return draft?.formats.map(({position, length, noun, icon}) => ({
    start: position,
    length,
    noun,
    icon,
  })) ?? [];
}

function slashCommandFromDraft(draft: StoredComposerDraft | undefined): SelectedSlashCommand | null {
  const command = draft?.command;
  return command
    ? { start: command.position, length: command.length, choice: command.choice }
    : null;
}

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

export const ChatComposer = ({
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
  draftStorageKey,
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
  /**
   * Returns an overseer stub, used by the attach modal to create gatekeepers. Can be async
   * to support lazy provisional-gadget creation on the Home page.
   */
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
  /**
   * Whether the composer offers the deployment's standard formats. A chosen format rides along as
   * an instruction on the message; it does not change which workspace is created. Only meaningful
   * with `newChat`, since a format names something to build rather than something to say.
   */
  offerFormats?: boolean;
  autoFocus?: boolean;
  /** Minimum number of textarea rows at rest. Defaults to 2. */
  minRows?: number;
  /** Optional starter text to drop into the composer (e.g. a Home task suggestion). Applied
   * whenever `seedNonce` changes, so the same text can be re-seeded by bumping the nonce. */
  seedText?: string;
  seedNonce?: number;
  /** Session-storage key used to recover this composer's draft prompt after a page refresh. */
  draftStorageKey?: string;
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
  const [initialDraft] = useState(() => readComposerDraft(draftStorageKey));
  const [inputValue, setInputValue] = useState(() => initialDraft?.text ?? "");
  const [capsules, setCapsules] = useState<InputCapsule[]>([]);
  const [formatTokens, setFormatTokens] = useState<FormatToken[]>(() =>
    formatTokensFromDraft(initialDraft));
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [isSending, setIsSending] = useState(false);
  // The chat the "may not have been sent" hint belongs to; the render condition scopes it, and
  // leaving the chat dismisses it.
  const [sendHiccup, setSendHiccup] = useState<{ chatKey?: number | null } | null>(null);
  useEffect(() => setSendHiccup(null), [chatKey]);
  const [isAttachmentDragActive, setIsAttachmentDragActive] = useState(false);
  const [selectedSlashCommand, setSelectedSlashCommand] = useState<SelectedSlashCommand | null>(
    () => slashCommandFromDraft(initialDraft),
  );
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
  const draftEditedRef = useRef(false);

  const loadedDraftKeyRef = useRef(draftStorageKey);
  const skipDraftWriteRef = useRef(false);
  const draftRestoreGenerationRef = useRef(0);

  const placeRestoredCaretAtEnd = (
    text: string,
    key: string | undefined,
    generation: number,
  ) => {
    requestAnimationFrame(() => {
      if (draftRestoreGenerationRef.current !== generation ||
          loadedDraftKeyRef.current !== key || inputValueRef.current !== text) {
        return;
      }
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      if (autoFocus) textarea.focus();
      textarea.setSelectionRange(text.length, text.length);
      autoResizeTextarea(textarea, minRows, newChat ? 10 : 4);
    });
  };

  const composerMatchesStoredDraft = (draft: StoredComposerDraft) => {
    const currentCommand = selectedSlashCommandRef.current;
    const storedCommand = draft.command;
    if (inputValueRef.current !== draft.text || capsulesRef.current.length > 0 ||
        !!currentCommand !== !!storedCommand || currentCommand && storedCommand &&
        (currentCommand.start !== storedCommand.position ||
          currentCommand.length !== storedCommand.length ||
          slashCommandKey(currentCommand.choice.selection) !==
            slashCommandKey(storedCommand.choice.selection))) {
      return false;
    }
    const currentFormats = formatTokensRef.current;
    return currentFormats.length === draft.formats.length && currentFormats.every((format, index) => {
      const stored = draft.formats[index];
      return !format.logo && format.start === stored.position && format.length === stored.length &&
        format.noun === stored.noun && format.icon === stored.icon;
    });
  };

  const restoreDraftPresentation = (
    draft: StoredComposerDraft,
    key: string | undefined,
    generation: number,
  ) => {
    placeRestoredCaretAtEnd(draft.text, key, generation);
    if (draft.formats.length === 0) return;
    void Promise.all(draft.formats.map(({icon}) => formatIconDataUrl(icon))).then((logos) => {
      requestAnimationFrame(() => {
        if (draftRestoreGenerationRef.current !== generation ||
            loadedDraftKeyRef.current !== key || !composerMatchesStoredDraft(draft)) {
          return;
        }
        const restored = decorateComposerDraft(draft, logos, CAPSULE_LOGO_SLOT);
        setInputValue(restored.text);
        setFormatTokens(restored.formats);
        setSelectedSlashCommand(restored.command ?? null);
        placeRestoredCaretAtEnd(restored.text, key, generation);
      });
    });
  };

  useEffect(() => {
    // On a cold load the user-scoped key usually arrives after authentication; the key-change
    // effect below restores that draft, while this path handles drafts available at mount.
    if (!initialDraft) return;
    const generation = ++draftRestoreGenerationRef.current;
    restoreDraftPresentation(initialDraft, draftStorageKey, generation);
    return () => {
      if (draftRestoreGenerationRef.current === generation) {
        draftRestoreGenerationRef.current++;
      }
    };
    // Restoration belongs to the draft captured during initialization, not later prop values.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (loadedDraftKeyRef.current === draftStorageKey) return;
    const generation = ++draftRestoreGenerationRef.current;
    const previousKey = loadedDraftKeyRef.current;
    loadedDraftKeyRef.current = draftStorageKey;
    skipDraftWriteRef.current = true;
    const storedDraft = readComposerDraft(draftStorageKey);
    const preserveLocalDraft = previousKey === undefined &&
      (draftEditedRef.current || inputValueRef.current.length > 0);
    if (preserveLocalDraft) {
      writeComposerDraft(draftStorageKey, serializeComposerDraft(
        inputValueRef.current,
        capsulesRef.current.map(({start, length, description}) => ({
          start,
          length,
          url: description.url,
        })),
        formatTokensRef.current,
        selectedSlashCommandRef.current ?? undefined,
      ));
      skipDraftWriteRef.current = false;
      return;
    }
    setInputValue(storedDraft?.text ?? "");
    if (previousKey !== undefined) {
      draftEditedRef.current = false;
      setCapsules([]);
    }
    setFormatTokens(formatTokensFromDraft(storedDraft));
    setSelectedSlashCommand(slashCommandFromDraft(storedDraft));
    if (storedDraft) restoreDraftPresentation(storedDraft, draftStorageKey, generation);
  }, [draftStorageKey]);

  useEffect(() => {
    if (skipDraftWriteRef.current) {
      skipDraftWriteRef.current = false;
      return;
    }
    writeComposerDraft(draftStorageKey, serializeComposerDraft(
      inputValue,
      capsules.map(({start, length, description}) => ({
        start,
        length,
        url: description.url,
      })),
      formatTokens,
      selectedSlashCommand ?? undefined,
    ));
  }, [capsules, draftStorageKey, formatTokens, inputValue, selectedSlashCommand]);

  // Seed the composer from an external suggestion (Home task cards). Re-runs whenever the nonce
  // changes so picking the same suggestion twice still works. Focus + move the cursor to the end.
  useEffect(() => {
    if (seedNonce === undefined) return;
    draftRestoreGenerationRef.current++;
    const text = seedText ?? "";
    setSelectedSlashCommand(null);
    setCapsules([]);
    setFormatTokens([]);
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
    setFormatTokens(previous => previous.map(token => token.start >= tokenEnd
      ? {...token, start: token.start + splice.delta}
      : token));
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

  const shiftFormatTokens = (position: number, delta: number) => {
    if (delta === 0) return;
    setFormatTokens(previous => previous.map(token => token.start >= position
      ? {...token, start: token.start + delta}
      : token));
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
    const sendingDraftKey = draftStorageKey;
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
            delta += token.noun.length - token.length;
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
          text = text.slice(0, token.start) + token.noun +
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
          [...formatTokens].toSorted((a, b) => a.start - b.start));

      await onSend(message, selectedModel,
          capsuleSpecifiers?.length ? capsuleSpecifiers : undefined,
          readyAttachments.length ? readyAttachments : undefined,
          formatRefs);
      writeComposerDraft(sendingDraftKey, undefined);
      if (loadedDraftKeyRef.current !== sendingDraftKey) return;
      draftEditedRef.current = false;
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
        shiftFormatTokens(urlEnd, splice.delta);
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
    shiftFormatTokens(urlEnd, lengthDiff);
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
    shiftFormatTokens(insertPos, splice.delta);
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
      {
        noun: format.output.noun,
        icon: format.output.icon,
        logo,
        start: splice.start,
        length: splice.length,
      },
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
    <div className={`relative isolate px-2 py-2 sm:px-4 sm:py-4 ${styles.chatInputRoot}`}>
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
                draftEditedRef.current = true;
                draftRestoreGenerationRef.current++;
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
                // An IME commits a composition with Enter, and the browser reports that as an
                // ordinary keydown. Reading it as "send" truncates the message mid-word for every
                // user who types through an IME, so hand the whole keystroke back to the IME: Enter
                // is not the only key it owns -- Escape cancels a composition and the arrows move
                // through candidates.
                if (isImeComposing(e)) return;
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
              className={`relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[16px] leading-[22px] outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed sm:text-[14px] ${composerTextareaClass}`}
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
                    className="group flex h-10 w-10 flex-shrink-0 cursor-pointer items-center justify-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.96] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-subtle sm:h-8 sm:w-8"
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
              className="inline-flex h-10 flex-shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-none text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-subtle focus-visible:bg-kumo-tint focus-visible:text-kumo-subtle focus-visible:outline-none active:scale-[0.97] sm:h-8 sm:text-[13px]"
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
                      className="group inline-flex h-10 min-w-0 max-w-[110px] cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[14px] leading-5 text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none active:scale-[0.97] data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default sm:h-8 sm:max-w-[180px] sm:text-[13px]"
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
                  className="!h-10 !w-10 sm:!h-8 sm:!w-8"
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
                  className="!h-10 !w-10 disabled:cursor-not-allowed disabled:opacity-30 sm:!h-8 sm:!w-8"
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
