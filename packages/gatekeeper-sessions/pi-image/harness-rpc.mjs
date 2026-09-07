import { Buffer } from "node:buffer";

const common = {
  prompt: ["message", "images", "streamingBehavior"],
  steer: ["message", "images"],
  follow_up: ["message", "images"],
  abort: [], get_state: [], get_messages: [], get_session_stats: [], export_html: [],
};
const commands = {
  "pi@0.84.2": { ...common, get_entries: ["since"], get_tree: [] },
  "prime@0.8.0": common,
};
const dialogs = new Set(["confirm", "select", "input", "editor"]);
const notices = new Set(["notify", "setStatus", "setWidget", "setTitle", "set_editor_text"]);
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

/**
 * Internal, version-pinned stdio transport, NOT a session/authority API. The owner
 * injects binary Node readable/writable streams, handles process exit via close(),
 * and owns their shutdown/error handling after detachment. No process is launched.
 * Sources: Pi 0.84.2 docs/rpc.md; Prime 0.8.0 dist/modes/rpc/{rpc-mode,
 * rpc-extension-ui-context}.js. Responses and events retain their wire shapes:
 * Pi message_update is delta-only; Prime includes cumulative message/partial.
 * agent_end never settles a request or implies owner-level session completion.
 *
 * exportPath, if enabled, must be allocated by the trusted owner inside its own
 * filesystem boundary. Neither caller command fields nor returned paths confer
 * authority. This helper does not validate filesystem ownership or serve exports.
 * onEvent is synchronous; the consumer owns retention. No event history is kept.
 * Terminal faults (including timeout) reject all requests and forget local dialogs;
 * they do NOT send approvals/cancellations or kill the process. The owner must
 * shut down the peer. Dialog expiry only removes local eligibility to respond.
 */
export function createHarnessRpc({
  runtime, readable, writable, onEvent = () => {}, onClose = () => {}, exportPath,
  maxFrameBytes = 1024 * 1024, maxWriteBytes = 1024 * 1024,
  maxOutstanding = 32, maxDialogs = 32, timeoutMs = 30_000,
}) {
  if (!Object.hasOwn(commands, runtime)) throw new Error("Unsupported runtime version");
  if (![maxFrameBytes, maxWriteBytes, maxOutstanding, maxDialogs, timeoutMs].every(positive)
      || timeoutMs > 2_147_483_647) throw new Error("Invalid transport limits");
  if (exportPath !== undefined && (typeof exportPath !== "string" || !exportPath || exportPath.includes("\0"))) {
    throw new Error("Invalid owner export path");
  }
  const pending = new Map();
  const ui = new Map();
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  let frame = Buffer.alloc(maxFrameBytes);
  let used = 0;
  let sequence = 0;
  let writing = 0;
  let blocked = false;
  let failure;
  const subscriptions = [];
  function listen(stream, name, handler) {
    stream.on(name, handler);
    subscriptions.push(() => stream.off(name, handler));
  }
  function close(reason = new Error("RPC transport closed")) {
    if (failure) return;
    failure = reason instanceof Error ? reason : new Error("RPC peer exited");
    for (const detach of subscriptions) detach();
    for (const entry of pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
    pending.clear();
    for (const entry of ui.values()) clearTimeout(entry.timer);
    ui.clear();
    frame = undefined;
    used = 0;
    onClose(failure);
  }
  function encode(value) {
    if (failure) throw failure;
    const bytes = Buffer.from(JSON.stringify(value) + "\n");
    if (bytes.length - 1 > maxFrameBytes || bytes.length > maxWriteBytes - writing) {
      throw new Error("RPC write byte limit exceeded");
    }
    if (blocked) throw new Error("RPC write backpressure");
    return bytes;
  }
  function send(bytes) {
    writing += bytes.length;
    try {
      blocked = !writable.write(bytes, (error) => {
        writing -= bytes.length;
        if (error) close(new Error("RPC write failed"));
      });
    } catch {
      close(new Error("RPC write failed"));
      throw failure;
    }
  }
  function receive(value) {
    if (!object(value) || typeof value.type !== "string" || !value.type) throw new Error("Invalid RPC envelope");
    if (value.type === "response") {
      const entry = pending.get(value.id);
      if (!entry || value.command !== entry.command || typeof value.success !== "boolean"
          || (!value.success && typeof value.error !== "string")) throw new Error("Invalid RPC response correlation");
      pending.delete(value.id);
      clearTimeout(entry.timer);
      if (value.success) entry.resolve(value);
      else {
        const error = new Error("RPC command rejected");
        // Bounded by maxFrameBytes; callers may inspect the unmodified wire error.
        error.response = value;
        entry.reject(error);
      }
      return;
    }
    if (value.type === "extension_ui_request") {
      if (typeof value.id !== "string" || !value.id || (!dialogs.has(value.method) && !notices.has(value.method))) {
        throw new Error("Invalid extension UI request");
      }
      if (dialogs.has(value.method)) {
        if (ui.has(value.id) || ui.size >= maxDialogs) throw new Error("Extension UI pending limit or duplicate id");
        if (value.method === "select" && (!Array.isArray(value.options) || !value.options.every((v) => typeof v === "string"))) {
          throw new Error("Invalid extension UI options");
        }
        if (value.timeout !== undefined && value.timeout !== 0 && (!positive(value.timeout) || value.timeout > 2_147_483_647)) {
          throw new Error("Invalid extension UI timeout");
        }
        ui.set(value.id, {
          method: value.method, options: value.options?.slice(),
          timer: setTimeout(() => ui.delete(value.id), Math.min(value.timeout || timeoutMs, timeoutMs)),
        });
      }
    }
    onEvent(value);
  }
  function data(chunk) {
    try {
      if (!(chunk instanceof Uint8Array)) throw new Error("RPC requires binary chunks");
      const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      let start = 0;
      while (start < bytes.length) {
        if (failure) break;
        const lf = bytes.indexOf(10, start);
        const end = lf === -1 ? bytes.length : lf;
        const length = end - start;
        if (used + length > maxFrameBytes) throw new Error("RPC frame byte limit exceeded");
        bytes.copy(frame, used, start, end);
        used += length;
        if (lf === -1) break;
        const line = frame.subarray(0, used - (frame[used - 1] === 13 ? 1 : 0));
        let value;
        try { value = JSON.parse(decoder.decode(line)); }
        catch { throw new Error("Malformed RPC JSON or UTF-8"); }
        used = 0;
        receive(value);
        start = lf + 1;
      }
    } catch (error) { close(error); }
  }
  listen(readable, "data", data);
  listen(readable, "end", () => close(new Error(used ? "Truncated RPC frame at EOF" : "RPC EOF")));
  listen(readable, "close", () => close(new Error("RPC readable closed")));
  listen(readable, "error", () => close(new Error("RPC read failed")));
  listen(writable, "error", () => close(new Error("RPC write failed")));
  listen(writable, "close", () => close(new Error("RPC writable closed")));
  listen(writable, "finish", () => close(new Error("RPC writable finished")));
  listen(writable, "drain", () => { blocked = false; });
  return {
    /** Send only an allowed wire command; resolve its raw response, not a turn. */
    async request(command, fields = {}) {
      if (failure) throw failure;
      const allowed = Object.hasOwn(commands[runtime], command) && commands[runtime][command];
      if (!allowed || !object(fields) || Object.keys(fields).some((key) => !allowed.includes(key))) {
        throw new Error("Unsupported RPC command or fields");
      }
      if (["prompt", "steer", "follow_up"].includes(command) && typeof fields.message !== "string") {
        throw new Error("RPC message must be a string");
      }
      if (fields.streamingBehavior !== undefined && !["steer", "followUp"].includes(fields.streamingBehavior)) {
        throw new Error("Invalid streamingBehavior");
      }
      if (fields.since !== undefined && typeof fields.since !== "string") throw new Error("Invalid entry cursor");
      if (fields.images !== undefined && (!Array.isArray(fields.images) || !fields.images.every((image) =>
        object(image) && image.type === "image" && typeof image.data === "string" && typeof image.mimeType === "string"
        && Object.keys(image).every((key) => ["type", "data", "mimeType"].includes(key))))) {
        throw new Error("Invalid RPC images");
      }
      if (command === "export_html" && exportPath === undefined) throw new Error("Owner export path required");
      if (pending.size >= maxOutstanding) throw new Error("RPC outstanding request limit exceeded");
      const id = `harness-${++sequence}`;
      const bytes = encode({ ...fields, type: command, id, ...(command === "export_html" ? { outputPath: exportPath } : {}) });
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => close(new Error("RPC request timeout")), timeoutMs);
        pending.set(id, { command, resolve, reject, timer });
        send(bytes);
      });
    },
    /** Explicit owner decision, only for an observed, still-pending dialog id. */
    respondToDialog(id, response) {
      if (failure) throw failure;
      const entry = ui.get(id);
      if (!entry) throw new Error("Unknown or expired extension UI id");
      if (!object(response) || Object.keys(response).length !== 1) throw new Error("Invalid extension UI response");
      const valid = response.cancelled === true
        || (entry.method === "confirm" ? typeof response.confirmed === "boolean"
          : typeof response.value === "string" && (entry.method !== "select" || entry.options.includes(response.value)));
      if (!valid) throw new Error("Invalid extension UI response");
      const bytes = encode({ ...response, type: "extension_ui_response", id });
      clearTimeout(entry.timer);
      ui.delete(id);
      send(bytes);
    },
    /** Snapshot of locally eligible ids; no implicit approvals or event retention. */
    get pendingDialogIds() { return [...ui.keys()]; },
    close,
  };
}
