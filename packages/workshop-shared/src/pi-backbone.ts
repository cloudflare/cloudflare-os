/** Bounded owner-side Pi/Prime commands. Dialog replies are not Workshop action approvals. */
export type CodingSessionPiCommand =
  | { /** Read state/context/history/tree, abort, or export. Prime rejects get_entries/get_tree as unavailable. */ type: "get_state" | "get_messages" | "get_entries" | "get_tree" | "abort" | "export_html" }
  | { /** Submit text; acknowledgement means accepted, not completed. */ type: "prompt" | "steer" | "follow_up"; /** Plain text, at most 32 KiB UTF-8. */ message: string }
  | { /** Poll bounded events after a cursor; truncated=true requires history refresh. */ type: "events"; /** Last received sequence, or zero on first poll. */ after: number }
  | { /** Answer a pending Pi extension dialog, never an MCP approval. */ type: "extension_ui_response"; /** Pending dialog identifier. */ id: string; /** Selected or entered value, when applicable. */ value?: string; /** Confirmation answer, when applicable. */ confirmed?: boolean; /** Dismiss the dialog. */ cancelled?: boolean };

/** Verified runtime semantics, not a guarantee that a bounded read fits or succeeds. */
export interface CodingSessionPiCapabilities {
  /** get_messages contains current model context only. */
  messages: "current-context";
  /** Whether persisted entries can be read through this transport. */
  history: "persisted-entries" | "unavailable";
  /** Whether the runtime exposes its branch tree through this transport. */
  tree: boolean;
  /** Only Pi supplies a verified settlement event; acknowledgements never imply completion. */
  settlement: "agent_settled" | "unavailable";
  /** Runtime message_update representation; retain original event shapes. */
  messageUpdates: "delta" | "cumulative";
}

/** Attach-only result. Connecting never creates or restarts an agent process. */
export type CodingSessionPiConnection =
  | { /** Machine transport is available. */ mode: "rpc"; /** Actual wire runtime; Prime session creation uses runtime prime-agent. */ runtime: "pi" | "prime"; /** Supported semantics for this runtime. */ capabilities: CodingSessionPiCapabilities; /** Opaque owner- and generation-bound handle, not a URL. */ connectionId: string; /** Reconnect after this deadline. */ expiresAt: Date; /** Owner bridge protocol version. */ version: 1 }
  | { /** Existing TUI, unsupported runtime, or bridge unavailable. */ mode: "terminal"; /** Concrete limitation suitable for display. */ reason: string };

/** Bounded JSON result from Pi, Prime or the bridge. Treat all content as untrusted data. */
export interface CodingSessionPiResult {
  /** JSON-encoded response data. Events include cursor/truncated/events; export includes filename, mediaType, base64 and must be downloaded, never embedded as trusted HTML. */
  json: string;
}
