import {
  useState,
  useEffect,
  useRef,
  useMemo,
  useCallback,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { DropdownMenu, useKumoToastManager } from "@cloudflare/kumo";
import { Brain, File as FileIcon, Plug, Plus } from "@phosphor-icons/react";
import { RpcStub } from "capnweb";
import type {
  AiChatAuthorInfo,
  CapsuleSpecifier,
  ChatAttachmentHandle,
  GatekeeperClient,
  MessageFormatRef,
  OutputFormatOffer,
  Overseer,
  SlashCommandChoice,
  SlashCommandRequest,
} from "@gadgets/workshop-shared/api";
import { isTransientRpcError } from "../../../rpcErrors";
import {
  parseSlashCommandInput, slashCommandTokenKey,
} from "../../../components/chat/slash-command-input";
import {
  ComposerMirror, composerTextareaClass, type ComposerMirrorHandle, type MirrorToken,
} from "./inline-items/ComposerMirror";
import {
  snapCaretOutOfRanges, type ComposerRange,
} from "../../../components/chat/composer-tokens";
import CapsuleOverlay from "../../../CapsuleOverlay";
import type { SelectableItem } from "../../../ResourcePicker";
import GatekeeperModal from "../../../GatekeeperModal";
import { formatIconDataUrl } from "../../../components/format/formatIconImage";
import ComposerFormatMenuItems from "../../../components/format/ComposerFormatMenuItems";
import { WorkshopIconButton } from "../../../components/WorkshopControls";
import { handlePickerKeyDown } from "../../../pickerNavigation";
import { useAuthenticatedApi } from "../../../AuthContext";
import { useVendorBranding } from "../../../useVendorBranding";
import { useSlashCommandPicker } from "../../../components/chat/SlashCommandPicker";
import { isImeComposing } from "../../../keyboardEvent";
import { ComposerAttachmentTray } from "./attachments/ComposerAttachmentTray";
import { useComposerAttachmentDrop } from "./attachments/useComposerAttachmentDrop";
import {
  MAX_COMPOSER_ATTACHMENTS,
  useComposerAttachments,
} from "./attachments/useComposerAttachments";
import { CapturedConsoleLogsPrompt } from "./CapturedConsoleLogsPrompt";
import { ComposerModelSelector } from "./ComposerModelSelector";
import { useComposerDraft } from "./draft/useComposerDraft";
import { buildComposerSubmission } from "./composerSubmission";
import {
  applyComposerTextEdit,
  insertComposerFormat,
  removeComposerDocumentToken,
  resolveComposerSlashCommand,
  type ComposerDocument,
} from "./composerDocument";
import { useComposerResources } from "./useComposerResources";
import { useComposerEditorLayout } from "./useComposerEditorLayout";
import styles from "./ChatComposer.module.css";

// A capsule's text begins with an em space, which reserves the box the mirror paints the vendor
// logo into, and a no-break space, which is the gap between the logo and the title. The word
// joiner keeps the two spaces (and the title) on one line, since the logo must not wrap away from
// what it labels.
const CAPSULE_LOGO_SLOT = "\u2003\u2060\u00a0";

function firstAccountIndex(items: readonly SelectableItem[]): number {
  const index = items.findIndex((item) => item.type === "account");
  return index > 0 ? index : 0;
}

const applyStateAction = <T,>(value: T, action: SetStateAction<T>): T =>
  typeof action === "function" ? (action as (previous: T) => T)(value) : action;

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
  const {
    attachments: pendingAttachments,
    addFiles,
    clearSentAttachments,
    removeAttachment,
  } = useComposerAttachments({
    getOverseer,
    modelId: selectedModel,
    onError: (message) => toasts.add({ title: message, variant: "error" }),
  });
  const {
    beginSend: beginDraftSend,
    commitDocumentEdit,
    completeSend: completeDraftSend,
    document: composerDocument,
    getDocumentSnapshot,
    presentationRequest: draftPresentationRequest,
    recordEdit: recordDraftEdit,
    replaceDocument: replaceComposerDocument,
    updateDocument: updateComposerDocument,
  } = useComposerDraft({
    storageKey: draftStorageKey,
    logoSlot: CAPSULE_LOGO_SLOT,
  });
  const {
    text: inputValue,
    capsules,
    formats: formatTokens,
    command: selectedSlashCommand,
  } = composerDocument;
  const setInputValue: Dispatch<SetStateAction<string>> = (action) => {
    updateComposerDocument((previous) => ({
      ...previous,
      text: applyStateAction(previous.text, action),
    }));
  };
  const [isSending, setIsSending] = useState(false);
  // The chat the "may not have been sent" hint belongs to; the render condition scopes it, and
  // leaving the chat dismisses it.
  const [sendHiccup, setSendHiccup] = useState<{ chatKey?: number | null } | null>(null);
  useEffect(() => setSendHiccup(null), [chatKey]);
  // The caret the slash command picker parses at. Deliberately updated only when it moves to a
  // different command token (see `syncPickerCaret`): the mirror owns the caret the user sees,
  // so ordinary caret movement doesn't have to re-render the composer.
  const [cursorPosition, setCursorPosition] = useState(0);
  const pickerCaretRef = useRef<{key: string | null; text: string}>({key: null, text: ""});
  const { authenticatedApi } = useAuthenticatedApi();
  const vendorBranding = useVendorBranding(authenticatedApi);
  const selectedSlashCommandRef = useRef(selectedSlashCommand);
  selectedSlashCommandRef.current = selectedSlashCommand;
  const sendInFlightRef = useRef(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);
  const [overlayIndex, setOverlayIndex] = useState(0);
  const overlayItemsRef = useRef<SelectableItem[]>([]);
  const overlayActivateRef = useRef<((index: number) => void) | null>(null);
  // Once the user moves the overlay's selection, the default stops applying.
  const overlayNavigatedRef = useRef(false);
  const navigateOverlay: Dispatch<SetStateAction<number>> = (index) => {
    overlayNavigatedRef.current = true;
    setOverlayIndex(index);
  };
  // Accounts arrive from a subscription, so they can land after the panel first renders.
  const handleOverlayItems = useCallback((items: SelectableItem[]) => {
    overlayItemsRef.current = items;
    if (!overlayNavigatedRef.current) setOverlayIndex(firstAccountIndex(items));
  }, []);

  // Refs for the mirror div and the textarea wrapper.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const promptCardRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<ComposerMirrorHandle>(null);
  const composerTextareaRef = useRef<HTMLTextAreaElement>(null);

  // Keep inputValue in a ref so handleCursorChange can read it without re-binding.
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const {
    activeUrl,
    attachCreated,
    attachModalOpen,
    closeAttachModal,
    createCapsule,
    dismissUrl,
    isCreatingResource,
    openAttachModal,
    refineUrl,
    scanAt: scanForResourceUrl,
  } = useComposerResources({
    createCapsuleGatekeeper,
    getDocumentSnapshot,
    commitDocumentEdit,
    capsuleTokenText: (description, vendorId) =>
      (vendorId && vendorBranding.get(vendorId)?.logoUrl ? CAPSULE_LOGO_SLOT : "") +
      description.title,
    onSelectionRequest: (selection, documentRevision) => {
      requestAnimationFrame(() => {
        if (getDocumentSnapshot().documentRevision !== documentRevision) return;
        const textarea = composerTextareaRef.current;
        if (!textarea) return;
        textarea.focus();
        textarea.setSelectionRange(selection.start, selection.end);
        syncPickerCaret(selection.end);
      });
    },
    onError: (message) => toasts.add({ title: message, variant: "error" }),
  });
  const {
    resizeTextarea,
    syncMirrorScroll,
    urlLineOffset,
  } = useComposerEditorLayout({
    textareaRef: composerTextareaRef,
    wrapperRef,
    mirrorRef,
    text: inputValue,
    activeTextOffset: activeUrl?.start,
    minRows,
    maxRows: newChat ? 10 : 4,
  });
  const {
    canAttachMore,
    isActive: isAttachmentDragActive,
    onDragEnter: handleAttachmentDragEnter,
    onDragLeave: handleAttachmentDragLeave,
    onDragOver: handleAttachmentDragOver,
    onDrop: handleAttachmentDrop,
  } = useComposerAttachmentDrop({
    attachmentCount: pendingAttachments.length,
    maxAttachments: MAX_COMPOSER_ATTACHMENTS,
    onFilesDropped: (files) => void addFiles(files),
  });

  useEffect(() => {
    if (!draftPresentationRequest) return;
    const frame = requestAnimationFrame(() => {
      if (inputValueRef.current !== draftPresentationRequest.text) return;
      const textarea = composerTextareaRef.current;
      if (!textarea) return;
      if (autoFocus) textarea.focus();
      textarea.setSelectionRange(
        draftPresentationRequest.text.length,
        draftPresentationRequest.text.length,
      );
      resizeTextarea(textarea);
    });
    return () => cancelAnimationFrame(frame);
  }, [autoFocus, draftPresentationRequest, minRows, newChat]);

  // Seed the composer from an external suggestion (Home task cards). Re-runs whenever the nonce
  // changes so picking the same suggestion twice still works. Focus + move the cursor to the end.
  useEffect(() => {
    if (seedNonce === undefined) return;
    recordDraftEdit();
    const text = seedText ?? "";
    replaceComposerDocument({ text, capsules: [], formats: [], command: null });
    requestAnimationFrame(() => {
      const ta = composerTextareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(text.length, text.length);
      resizeTextarea(ta);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedNonce]);
  const capsulesRef = useRef(capsules);
  capsulesRef.current = capsules;
  // Reset overlay selection when the overlay appears or changes URL, preferring a connected account
  // so Tab never reaches for "Connect new account" first.
  useEffect(() => {
    setOverlayIndex(firstAccountIndex(overlayItemsRef.current));
    overlayNavigatedRef.current = false;
  }, [activeUrl]);

  const isBlocked = !!blockedReason;

  // A disabled textarea stops firing mouse events, so drop the hover state the token hit-testing
  // below leaves behind; otherwise the cursor outlives `disabled:cursor-not-allowed`.
  useEffect(() => {
    if (!isBlocked) return;
    mirrorRef.current?.setHoveredToken(null);
    if (composerTextareaRef.current) composerTextareaRef.current.style.cursor = "";
  }, [isBlocked]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

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

  const currentComposerDocument = (): ComposerDocument => ({
    text: inputValueRef.current,
    capsules: capsulesRef.current,
    formats: formatTokensRef.current,
    command: selectedSlashCommandRef.current,
  });

  const commitComposerDocument = (document: ComposerDocument) => {
    replaceComposerDocument(document);
  };

  const removeTokenAt = (range: ComposerRange) => {
    recordDraftEdit();
    const transition = removeComposerDocumentToken(currentComposerDocument(), range);
    commitComposerDocument(transition.document);
    requestAnimationFrame(() => moveCaret(transition.caret));
  };

  // Hit-tests the pointer against the mirror's token spans, which lay out identically to the
  // textarea's text.
  const tokenAtPoint = (clientX: number, clientY: number):
      {start: number; edge: number} | null => {
    // Hit-testing forces layout, so avoid it in the common case with no tokens.
    if (capsulesRef.current.length === 0 && !selectedSlashCommandRef.current
        && formatTokensRef.current.length === 0) {
      return null;
    }
    return mirrorRef.current?.tokenAtPoint(clientX, clientY) ?? null;
  };

  // Completing a command leaves the `/name` text in place (only its color changes) and parks the
  // caret past it so the next keystroke doesn't grow the token.
  const applySlashCommandSelection = useCallback((
      choice: SlashCommandChoice, tokenStart: number, tokenEnd: number) => {
    recordDraftEdit();
    const commandText = `/${choice.name}`;
    const transition = resolveComposerSlashCommand(
      currentComposerDocument(), choice, tokenStart, tokenEnd, commandText,
    );
    commitComposerDocument(transition.document);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      moveCaret(transition.caret);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keeps the resolved command anchored to its text when text is inserted or removed before it.
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
    if (isCreatingResource) {
      toasts.add({ title: "Please wait for the resource connection to finish", variant: "error" });
      return;
    }

    sendInFlightRef.current = true;
    setIsSending(true);
    const draftSend = beginDraftSend();
    try {
      let documentForSubmission = composerDocument;
      if (!documentForSubmission.command && documentForSubmission.text.startsWith("//")) {
        documentForSubmission = {
          ...documentForSubmission,
          text: documentForSubmission.text.slice(1),
          capsules: documentForSubmission.capsules.map((capsule) => ({
            ...capsule,
            start: Math.max(0, capsule.start - 1),
          })),
          formats: documentForSubmission.formats.map((format) => ({
            ...format,
            start: Math.max(0, format.start - 1),
          })),
        };
      } else if (!documentForSubmission.command && documentForSubmission.text.startsWith("/")) {
        const parsed = parseSlashCommandInput(documentForSubmission.text, 1);
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
        documentForSubmission = {
          ...documentForSubmission,
          command: {
            choice: match,
            start: parsed.tokenStart,
            length: parsed.tokenEnd - parsed.tokenStart,
          },
        };
      }
      const submissionResult = buildComposerSubmission({
        document: documentForSubmission,
        hasAttachments: readyAttachments.length > 0,
      });
      if (!submissionResult.ok) {
        toasts.add({ title: "Slash commands cannot include resources or attachments", variant: "error" });
        return;
      }
      const { message, capsules: capsuleSpecifiers, formats: formatRefs } =
        submissionResult.submission;

      await onSend(message, selectedModel,
          capsuleSpecifiers,
          readyAttachments.length ? readyAttachments : undefined,
          formatRefs);
      clearSentAttachments(attachmentsSnapshot);
      if (!completeDraftSend(draftSend)) return;
      replaceComposerDocument({ text: "", capsules: [], formats: [], command: null });
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
    recordDraftEdit();
    setInputValue((prev) => prev + "\n\n" + formatted);
  };

  const handleAttachOpen = () => {
    const position = composerTextareaRef.current?.selectionStart ?? inputValueRef.current.length;
    openAttachModal(snapCaretOutOfRanges(position, currentTokenRanges(), "nearest"));
  };

  const handleInputChange = (newValue: string, editCursorPos?: number) => {
    const transition = applyComposerTextEdit(
      currentComposerDocument(), newValue, editCursorPos,
    );
    if (transition.rejected) {
      const textarea = composerTextareaRef.current;
      if (textarea) {
        textarea.value = transition.document.text;
        textarea.setSelectionRange(transition.caret, transition.caret);
      }
      return;
    }

    recordDraftEdit();
    commitComposerDocument(transition.document);
    if (transition.caret !== undefined) {
      const caret = transition.caret;
      requestAnimationFrame(() => moveCaret(caret));
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

    scanForResourceUrl(cursorPos);
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
    const transition = insertComposerFormat(
      currentComposerDocument(),
      at,
      { noun: format.output.noun, icon: format.output.icon, logo },
      (logo ? CAPSULE_LOGO_SLOT : "") + format.output.noun,
    );
    if (!transition) return;
    recordDraftEdit();
    commitComposerDocument(transition.document);
    requestAnimationFrame(() => {
      composerTextareaRef.current?.focus();
      moveCaret(transition.caret);
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
      logoUrl: inputValue.startsWith(CAPSULE_LOGO_SLOT, start) && vendorId
        ? vendorBranding.get(vendorId)?.logoUrl
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
      logoUrl: inputValue.startsWith(CAPSULE_LOGO_SLOT, start) ? logo : undefined,
    })),
  ], [capsules, formatTokens, inputValue, selectedSlashCommand, vendorBranding]);

  const hasReadyAttachment = pendingAttachments.some(
    (attachment) => attachment.uploadState === "ready" && attachment.ref,
  );
  const hasUnreadyAttachment = pendingAttachments.some(
    (attachment) => attachment.uploadState !== "ready",
  );
  const canSend = !isSending && !isAgentActive && !isBlocked &&
    (inputValue.trim().length > 0 || selectedSlashCommand !== null || hasReadyAttachment) &&
    !hasUnreadyAttachment && !isCreatingResource;
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
      <CapturedConsoleLogsPrompt
        count={pendingConsoleLogCount}
        preview={consoleLogPreview}
        severity={consoleLogSeverity}
        onAttach={handleAttachLogs}
        onDiscard={onDiscardConsoleLogs}
      />

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
                  void createCapsule(accountId, vendorId);
                }}
                onRefine={refineUrl}
                onDismiss={dismissUrl}
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
                resizeTextarea(e.target);
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
                  resizeTextarea(el);
                  syncMirrorScroll(el);
                }
              }}
              className={`relative z-[1] w-full resize-none border-none bg-transparent p-0 text-[16px] leading-[22px] outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed sm:text-[14px] ${composerTextareaClass}`}
            />
          </div>
        </div>

        <ComposerAttachmentTray
          attachments={pendingAttachments}
          disabled={isSending}
          onRemove={removeAttachment}
        />

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
              <ComposerModelSelector
                models={models}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
              />
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
        onClose={closeAttachModal}
        getOverseer={getOverseer}
        onCreated={attachCreated}
      />
    </div>
  );
};
