// Provisional streaming previews of in-progress tool calls. As writeFile/editFile/executeCode
// input tokens arrive, the streaming JSON parser (see streaming-json-parser.ts) decodes the
// call's target fields and streaming string value incrementally, and the managers here emit the
// provisional AiChatStreamEvents that let the UI display the call before it finalizes. Everything
// emitted here is display-only: the durable record of an edit is the change row appended when the
// tool call executes (see AiChatSubscriber.changeApplied).

import { AiChatStreamEvent, AiToolCall, WorkpieceId } from '@gadgets/workshop-shared/api';
import { StreamingToolInputParser } from './streaming-json-parser';
import { createWorkshopLogger } from './observability';

const logger = createWorkshopLogger("workshop.agent");

type CodePreviewEntry = {
  toolName: "writeFile" | "editFile";
  parser: StreamingToolInputParser;
  // The edit's target workpiece, resolved from the streaming input's prefix fields once they are
  // complete. `null` means resolution failed (e.g. the agent omitted `workpiece` in a workspace
  // with no default gadget) — the tool call itself will fail, so no preview is shown.
  target?: {workpieceId: WorkpieceId} | null;
  // Whether we've already emitted the toolCallTarget event. To avoid emitting multiple times.
  targetEmitted?: boolean;
  // Whether an editPreviewStart has been emitted for this call (content deltas follow it), and
  // how much of the parser's decoded streaming value those deltas have covered so far.
  previewing?: boolean;
  emittedLength: number;
  // Set when this call's content preview is abandoned: its input was malformed, its preview was
  // withdrawn (editPreviewClear), or the tool call turned out not to produce a change row. No
  // further preview events are emitted for the call.
  previewSkipped?: boolean;
};

// Returns the newly decoded characters of `parser`'s streaming value past `state.emittedLength`,
// advancing it. A trailing lone high surrogate is held back until its low half arrives (or the
// stream ends): a delta boundary splitting a surrogate pair would put a lone surrogate on the
// wire, where UTF-8 encoding turns it into U+FFFD and desynchronizes the client's accumulated
// text from the real content.
function takeStreamedDelta(parser: StreamingToolInputParser,
                           state: {emittedLength: number}): string {
  let value = parser.streamingValue;
  let end = value.length;
  if (!parser.streamComplete && end > state.emittedLength) {
    let last = value.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end--;
  }
  if (end <= state.emittedLength) return "";
  let delta = value.slice(state.emittedLength, end);
  state.emittedLength = end;
  return delta;
}

/**
 * Tracks writeFile and editFile tool calls while the LLM is still streaming their input, emitting
 * the provisional events that let the UI show the edit live. As tool-call input tokens arrive,
 * the streaming JSON parser extracts the target fields and emits toolCallTarget / setActiveFile
 * (so the UI can focus the file being edited), then streams the edit's content itself as an
 * editPreviewStart + editPreviewDelta preview (see AiChatStreamEvent). The preview carries only
 * the streamed text -- the client overlays it on its own copy of the file -- and is superseded by
 * the durable change row the completed call appends, or withdrawn with editPreviewClear when no
 * row will come (parse failure, tool failure, no-op edit).
 */
export class CodePreviewManager {
  #previews = new Map<string, CodePreviewEntry>();
  #activeFile: {workpieceId: WorkpieceId, filename: string} | null = null;

  /**
   * `resolveWorkpiece` resolves an edit's (optional) `workpiece` input field -- the chat binding
   * name of the target workpiece -- to the workpiece whose file is being edited (a filename
   * alone doesn't identify a file).
   */
  constructor(private emit: (event: AiChatStreamEvent) => void,
              private resolveWorkpiece:
                  (workpiece?: string) => {workpieceId: WorkpieceId}) {}

  startToolCall(toolCallId: string, toolName: AiToolCall["toolName"]) {
    if (toolName !== "writeFile" && toolName !== "editFile") {
      return;
    }

    let streamingField = toolName === "writeFile" ? "content" : "replacement";
    this.#previews.set(toolCallId, {
      toolName,
      parser: new StreamingToolInputParser(streamingField),
      emittedLength: 0,
    });
  }

  appendInput(toolCallId: string, delta: string) {
    let entry = this.#previews.get(toolCallId);
    if (!entry) return;

    try {
      entry.parser.append(delta);
      if (entry.parser.hasError) throw new Error("Invalid JSON in tool input");

      this.#maybeEmitActiveFile(toolCallId, entry);
      this.#maybeEmitPreview(toolCallId, entry);
    } catch (err) {
      this.#withdrawPreview(toolCallId, entry);
      this.#previews.delete(toolCallId);
      logger.warn("failed to parse provisional tool input", {
        event: "agent.provisional.tool.input.parse.failed", toolCallId, error: err,
      });
    }
  }

  finishToolCall(toolCallId: string, success: boolean) {
    let entry = this.#previews.get(toolCallId);
    if (!entry) return;

    if (!success) {
      this.#withdrawPreview(toolCallId, entry);
      this.#previews.delete(toolCallId);
    } else {
      // Flush any tail the delta emission held back (e.g. a surrogate pair completed by the
      // input's final chunk).
      this.#maybeEmitPreview(toolCallId, entry);
    }
  }

  /**
   * Withdraws the preview of a tool call that will produce no change row after all -- the tool
   * failed, or the edit turned out to be a no-op -- so clients stop showing its provisional
   * content. (A call that does produce a row needs no withdrawal: the row supersedes the
   * preview.) No-op for calls with no active preview.
   */
  clearPreview(toolCallId: string) {
    let entry = this.#previews.get(toolCallId);
    if (entry) this.#withdrawPreview(toolCallId, entry);
  }

  clear() {
    this.#previews.clear();
    this.#activeFile = null;
  }

  clearActiveFile() {
    if (this.#activeFile === null) return;

    this.#activeFile = null;
    this.emit({type: "setActiveFile", file: null});
  }

  #withdrawPreview(toolCallId: string, entry: CodePreviewEntry) {
    if (entry.previewing) {
      this.emit({type: "editPreviewClear", toolCallId});
    }
    entry.previewing = false;
    entry.previewSkipped = true;
  }

  #maybeEmitActiveFile(toolCallId: string, entry: CodePreviewEntry) {
    let prefix = entry.parser.prefixFields;
    let filename = prefix?.filename;
    if (typeof filename !== "string") {
      return;
    }

    // Resolve the target workpiece once the prefix fields (which precede the streaming content
    // field, hence are complete) are available.
    if (entry.target === undefined) {
      let rawWorkpiece = prefix!.workpiece;
      try {
        entry.target =
            this.resolveWorkpiece(typeof rawWorkpiece === "string" ? rawWorkpiece : undefined);
      } catch {
        // Unresolvable target: the tool call itself will fail, so show no preview for it.
        entry.target = null;
      }
    }
    if (!entry.target) return;
    let workpieceId = entry.target.workpieceId;

    // Tell the UI this call's target file so it can display before it finalizes.
    if (!entry.targetEmitted) {
      entry.targetEmitted = true;
      this.emit({type: "toolCallTarget", toolCallId, file: {workpieceId, filename}});
    }

    if (this.#activeFile !== null && this.#activeFile.workpieceId === workpieceId &&
        this.#activeFile.filename === filename) {
      return;
    }
    this.#activeFile = {workpieceId, filename};
    this.emit({type: "setActiveFile", file: {workpieceId, filename}});
  }

  // Streams the edit's content as it decodes: an editPreviewStart once the target (and, for
  // editFile, the complete textToReplace -- a prefix field, so complete by the time the streaming
  // replacement value begins) is known, then editPreviewDelta events for newly decoded characters.
  #maybeEmitPreview(toolCallId: string, entry: CodePreviewEntry) {
    if (entry.previewSkipped) return;
    let prefix = entry.parser.prefixFields;
    let filename = prefix?.filename;
    if (prefix === null || typeof filename !== "string" || !entry.target) return;

    if (!entry.previewing) {
      let textToReplace: string | undefined;
      if (entry.toolName === "editFile") {
        let raw = prefix.textToReplace;
        if (typeof raw !== "string") {
          // Malformed call (the tool will reject it); show no preview.
          entry.previewSkipped = true;
          return;
        }
        textToReplace = raw;
      }
      entry.previewing = true;
      this.emit({
        type: "editPreviewStart",
        toolCallId,
        file: {workpieceId: entry.target.workpieceId, filename},
        ...(textToReplace !== undefined ? {textToReplace} : {}),
      });
    }

    let delta = takeStreamedDelta(entry.parser, entry);
    if (delta !== "") {
      this.emit({type: "editPreviewDelta", toolCallId, delta});
    }
  }
}

/**
 * Streams the `code` field of executeCode tool calls to the client as it arrives, so the
 * UI can display the code the agent is about to run before the tool call is actually
 * invoked.  Emits incremental "toolCodeDelta" stream events containing only the new
 * characters decoded since the last event.
 */
export class ExecuteCodeStreamManager {
  #streams = new Map<string, {parser: StreamingToolInputParser, emittedLength: number}>();

  constructor(private emit: (event: AiChatStreamEvent) => void) {}

  startToolCall(toolCallId: string, toolName: AiToolCall["toolName"]) {
    if (toolName !== "executeCode") {
      return;
    }

    this.#streams.set(toolCallId, {
      parser: new StreamingToolInputParser("code"),
      emittedLength: 0,
    });
  }

  appendInput(toolCallId: string, delta: string) {
    let stream = this.#streams.get(toolCallId);
    if (!stream) return;

    try {
      stream.parser.append(delta);
      if (stream.parser.hasError) {
        this.#streams.delete(toolCallId);
        logger.warn("failed to parse provisional executeCode input", {
          event: "agent.provisional.execute.code.input.parse.failed",
          toolCallId,
        });
        return;
      }

      if (!stream.parser.prefixFields) return;

      let newDelta = takeStreamedDelta(stream.parser, stream);
      if (newDelta !== "") {
        this.emit({
          type: "toolCodeDelta",
          toolCallId,
          delta: newDelta,
        });
      }
    } catch (err) {
      this.#streams.delete(toolCallId);
      logger.warn("failed to parse provisional executeCode input", {
        event: "agent.provisional.execute.code.input.parse.failed",
        toolCallId, error: err,
      });
    }
  }

  finishToolCall(toolCallId: string) {
    this.#streams.delete(toolCallId);
  }

  clear() {
    this.#streams.clear();
  }
}
