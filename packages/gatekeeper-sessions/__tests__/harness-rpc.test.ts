import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createHarnessRpc } from "../pi-image/harness-rpc.mjs";

// Wire fixtures from the pinned Pi docs/rpc.md and Prime dist/modes/rpc
// implementation. These are protocol replays, not live model/CLI invocations.
const updates = {
  "pi@0.84.2": {
    type: "message_update", usage: { input: 100, output: 1 },
    assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hello 🌍\u2028world\u2029!" },
  },
  "prime@0.8.0": {
    type: "message_update",
    message: { role: "assistant", content: [{ type: "text", text: "Hello 🌍\u2028world\u2029!" }] },
    assistantMessageEvent: {
      type: "text_delta", contentIndex: 0, delta: "!",
      partial: { role: "assistant", content: [{ type: "text", text: "Hello 🌍\u2028world\u2029!" }] },
    },
  },
};
const cleanup: (() => void)[] = [];
afterEach(() => { cleanup.splice(0).forEach((fn) => fn()); vi.useRealTimers(); });
function setup(runtime = "pi@0.84.2", options = {}) {
  const readable = new PassThrough();
  const sent: any[] = [];
  const writable = new Writable({ write(chunk, _encoding, done) { sent.push(JSON.parse(chunk.toString())); done(); } });
  const onEvent = vi.fn();
  const onClose = vi.fn();
  const rpc = createHarnessRpc({ runtime, readable, writable, onEvent, onClose, ...options });
  cleanup.push(() => { rpc.close(); readable.destroy(); writable.destroy(); });
  const emit = (value: unknown) => readable.write(Buffer.from(JSON.stringify(value) + "\n"));
  const reply = (index: number, extra = {}) => emit({
    type: "response", id: sent[index].id, command: sent[index].type, success: true, ...extra,
  });
  return { rpc, readable, writable, sent, onEvent, onClose, emit, reply };
}

describe.each(["pi@0.84.2", "prime@0.8.0"] as const)("%s stdio", (runtime) => {
  it("accepts zero-timeout dialogs while retaining the bounded local reply window", () => {
    vi.useFakeTimers();
    const h = setup(runtime, { timeoutMs: 100 });
    h.emit({ type: "extension_ui_request", id: "zero", method: "confirm", timeout: 0 });
    vi.advanceTimersByTime(1);
    h.rpc.respondToDialog("zero", { confirmed: false });
    expect(h.sent).toEqual([{ type: "extension_ui_response", id: "zero", confirmed: false }]);
    h.emit({ type: "extension_ui_request", id: "expires", method: "input", timeout: 0 });
    vi.advanceTimersByTime(100);
    expect(h.rpc.pendingDialogIds).toEqual([]);
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("correlates out-of-order ids AND commands; returns native responses", async () => {
    const h = setup(runtime);
    const state = h.rpc.request("get_state");
    const messages = h.rpc.request("get_messages");
    h.reply(1, { data: { messages: [] } });
    h.reply(0, { data: { isStreaming: true } });
    expect(await messages).toMatchObject({ command: "get_messages", data: { messages: [] } });
    expect(await state).toMatchObject({ command: "get_state", data: { isStreaming: true } });
    expect(h.sent[0].id).not.toBe(h.sent[1].id);
  });

  it("passes native updates through fragmented UTF-8 and CRLF without treating agent_end as a reply", async () => {
    const h = setup(runtime);
    let settled = false;
    const prompt = h.rpc.request("prompt", { message: "fixture", streamingBehavior: "followUp" });
    void prompt.then(() => { settled = true; });
    const wire = Buffer.from(`${JSON.stringify(updates[runtime])}\r\n{"type":"agent_end","messages":[]}\n`);
    for (const byte of wire) h.readable.write(Buffer.from([byte]));
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(h.onEvent.mock.calls.map(([event]) => event)).toEqual([updates[runtime], { type: "agent_end", messages: [] }]);
    h.reply(0);
    await prompt;
  });

  it("supports the shared command allowlist without expanding authority", async () => {
    const h = setup(runtime, { exportPath: "/owner/allocated/export.html" });
    for (const command of ["prompt", "steer", "follow_up", "abort", "get_state", "get_messages", "get_session_stats", "export_html"]) {
      const fields = ["prompt", "steer", "follow_up"].includes(command)
        ? { message: "fixture", images: [{ type: "image", data: "eA==", mimeType: "image/png" }] } : {};
      const result = h.rpc.request(command, fields);
      h.reply(h.sent.length - 1);
      expect((await result).command).toBe(command);
    }
    expect(h.sent.at(-1).outputPath).toBe("/owner/allocated/export.html");
    for (const command of ["bash", "new_session", "switch_session", "set_model", "constructor", "__proto__"]) {
      await expect(h.rpc.request(command)).rejects.toThrow("Unsupported");
    }
    await expect(h.rpc.request("export_html", { outputPath: "/untrusted" })).rejects.toThrow("Unsupported");
    await expect(h.rpc.request("get_state", { id: "spoof" })).rejects.toThrow("Unsupported");
    await expect(h.rpc.request("prompt", { message: 2 })).rejects.toThrow("message");
    await expect(h.rpc.request("prompt", { message: "x", streamingBehavior: "follow_up" })).rejects.toThrow("streamingBehavior");
    await expect(h.rpc.request("steer", { message: "x", images: [{}] })).rejects.toThrow("images");
  });

  it("rejects command failures but keeps the connection usable", async () => {
    const h = setup(runtime);
    const rejected = expect(h.rpc.request("prompt", { message: "fixture" })).rejects.toMatchObject({
      message: "RPC command rejected", response: { success: false, error: "Already streaming" },
    });
    h.reply(0, { success: false, error: "Already streaming" });
    await rejected;
    const next = h.rpc.request("abort"); h.reply(1); await next;
    expect(h.onClose).not.toHaveBeenCalled();
  });

  it("requires explicit, method-valid replies to observed dialog ids", () => {
    const h = setup(runtime);
    for (const method of ["confirm", "select", "input", "editor"]) {
      h.emit({ type: "extension_ui_request", id: method, method, title: "fixture", options: ["Allow", "Block"] });
    }
    h.emit({ type: "extension_ui_request", id: "notice", method: "notify", message: "fixture" });
    expect(h.sent).toEqual([]);
    expect(h.rpc.pendingDialogIds).toEqual(["confirm", "select", "input", "editor"]);
    expect(() => h.rpc.respondToDialog("notice", { cancelled: true })).toThrow("Unknown");
    expect(() => h.rpc.respondToDialog("unseen", { confirmed: true })).toThrow("Unknown");
    for (const response of [{ confirmed: "yes" }, { value: "yes" }, { cancelled: false }, { confirmed: true, cancelled: true }]) {
      expect(() => h.rpc.respondToDialog("confirm", response)).toThrow("Invalid");
    }
    expect(() => h.rpc.respondToDialog("select", { value: "invented" })).toThrow("Invalid");
    h.rpc.respondToDialog("confirm", { confirmed: false });
    h.rpc.respondToDialog("select", { value: "Block" });
    h.rpc.respondToDialog("input", { value: "typed" });
    h.rpc.respondToDialog("editor", { cancelled: true });
    expect(h.sent).toEqual([
      { type: "extension_ui_response", id: "confirm", confirmed: false },
      { type: "extension_ui_response", id: "select", value: "Block" },
      { type: "extension_ui_response", id: "input", value: "typed" },
      { type: "extension_ui_response", id: "editor", cancelled: true },
    ]);
    expect(h.rpc.pendingDialogIds).toEqual([]);
    expect(() => h.rpc.respondToDialog("confirm", { confirmed: true })).toThrow("Unknown");
  });
});

it("gates Pi entry/tree queries and requires an owner export allocation", async () => {
  const pi = setup();
  for (const [command, fields] of [["get_entries", {}], ["get_entries", { since: "abc123" }], ["get_tree", {}]] as const) {
    const result = pi.rpc.request(command, fields); pi.reply(pi.sent.length - 1, { data: { leafId: null } }); await result;
  }
  expect(pi.sent[1].since).toBe("abc123");
  const prime = setup("prime@0.8.0");
  await expect(prime.rpc.request("get_entries")).rejects.toThrow("Unsupported");
  await expect(prime.rpc.request("get_tree")).rejects.toThrow("Unsupported");
  await expect(pi.rpc.request("export_html")).rejects.toThrow("Owner export path");
  expect(() => setup("pi@latest")).toThrow("version");
});

it.each([
  Buffer.from("not-json\n"), Buffer.from("[]\n"), Buffer.from("{}\n"), Buffer.from("\n"),
  Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc0, 0xaf, 0x22, 0x7d, 10]),
  Buffer.from('{"type":"response","command":"parse","success":false,"error":"bad"}\n'),
  Buffer.from('{"type":"response","id":"unknown","command":"get_state","success":true}\n'),
  Buffer.from('{"type":"response","id":"harness-1","command":"abort","success":true}\n'),
  Buffer.from('{"type":"response","id":"harness-1","command":"get_state","success":"true"}\n'),
])("fails closed on malformed bytes/envelopes/correlation (%#)", async (bytes) => {
  const h = setup();
  h.emit({ type: "extension_ui_request", id: "pending", method: "confirm" });
  const rejected = expect(h.rpc.request("get_state")).rejects.toThrow();
  h.readable.write(bytes);
  await rejected;
  expect(h.rpc.pendingDialogIds).toEqual([]);
  expect(h.onClose).toHaveBeenCalledTimes(1);
  expect(h.readable.listenerCount("data")).toBe(0);
  expect(h.writable.listenerCount("drain")).toBe(0);
  await expect(h.rpc.request("abort")).rejects.toThrow();
});

it("bounds frame bytes, request count and outbound bytes", async () => {
  const h = setup("pi@0.84.2", { maxFrameBytes: 128, maxWriteBytes: 128, maxOutstanding: 1 });
  await expect(h.rpc.request("prompt", { message: "🌍".repeat(100) })).rejects.toThrow("byte limit");
  const rejected = expect(h.rpc.request("get_state")).rejects.toThrow("frame byte limit");
  await expect(h.rpc.request("abort")).rejects.toThrow("outstanding");
  h.readable.write(Buffer.alloc(64, 32));
  h.readable.write(Buffer.alloc(65, 32));
  await rejected;
});

it.each(["eof", "truncated", "exit", "read-error", "write-error", "finish", "close"])("cleans requests and UI on %s", async (mode) => {
  const h = setup();
  h.emit({ type: "extension_ui_request", id: "pending", method: "editor" });
  const rejected = expect(h.rpc.request("get_state")).rejects.toThrow();
  if (mode === "truncated") { h.readable.write(Buffer.from('{"type":')); h.readable.end(); }
  else if (mode === "eof") h.readable.end();
  else if (mode === "exit") h.rpc.close(new Error("peer exited 1"));
  else if (mode === "read-error") h.readable.emit("error", new Error("fixture"));
  else if (mode === "write-error") h.writable.emit("error", new Error("fixture"));
  else h.writable.emit(mode);
  await rejected;
  expect(h.rpc.pendingDialogIds).toEqual([]);
  expect(h.sent).toHaveLength(1); // Cleanup never sends implicit approval/cancellation.
  expect(h.onClose).toHaveBeenCalledTimes(1);
  h.rpc.close();
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

it("times out all outstanding requests and clears timers/dialogs", async () => {
  vi.useFakeTimers();
  const h = setup("pi@0.84.2", { timeoutMs: 20 });
  h.emit({ type: "extension_ui_request", id: "pending", method: "input" });
  const first = expect(h.rpc.request("get_state")).rejects.toThrow("timeout");
  const second = expect(h.rpc.request("abort")).rejects.toThrow("timeout");
  await vi.advanceTimersByTimeAsync(20);
  await Promise.all([first, second]);
  expect(h.rpc.pendingDialogIds).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("expires dialogs locally and bounds/validates pending UI", async () => {
  vi.useFakeTimers();
  const h = setup("pi@0.84.2", { maxDialogs: 1 });
  h.emit({ type: "extension_ui_request", id: "expiring", method: "confirm", timeout: 5 });
  await vi.advanceTimersByTimeAsync(5);
  expect(() => h.rpc.respondToDialog("expiring", { confirmed: true })).toThrow("expired");
  expect(h.sent).toEqual([]);
  h.emit({ type: "extension_ui_request", id: "one", method: "input" });
  h.emit({ type: "extension_ui_request", id: "two", method: "input" });
  expect(h.onClose).toHaveBeenCalledTimes(1);
  expect(h.rpc.pendingDialogIds).toEqual([]);
  expect(vi.getTimerCount()).toBe(0);
});

it("honors backpressure and bounds unflushed writes independently of replies", async () => {
  const writable = Object.assign(new EventEmitter(), { write: vi.fn((_bytes: Buffer, _done: (error?: Error) => void) => false) });
  const h = setup("pi@0.84.2", { writable, maxWriteBytes: 70 });
  const first = h.rpc.request("get_state");
  const wire = JSON.parse(writable.write.mock.calls[0][0].toString());
  h.emit({ type: "response", id: wire.id, command: "get_state", success: true });
  await first;
  await expect(h.rpc.request("abort")).rejects.toThrow(/backpressure|byte limit/);
  writable.emit("drain");
  await expect(h.rpc.request("abort")).rejects.toThrow("byte limit");
});

it.each([
  { method: "select", options: [1] },
  { method: "confirm", timeout: -1 },
  { method: "confirm", timeout: 2 ** 32 },
  { method: "custom" },
])("rejects invalid dialog wire requests (%#)", (fields) => {
  const h = setup();
  h.emit({ type: "extension_ui_request", id: "dialog", ...fields });
  expect(h.onClose).toHaveBeenCalledTimes(1);
  expect(h.sent).toEqual([]);
});

it("rejects duplicate pending UI ids and duplicate command responses", async () => {
  const h = setup();
  const request = h.rpc.request("get_state"); h.reply(0); await request;
  h.reply(0);
  expect(h.onClose).toHaveBeenCalledTimes(1);
  const ui = setup();
  const dialog = { type: "extension_ui_request", id: "same", method: "confirm" };
  ui.emit(dialog); ui.emit(dialog);
  expect(ui.onClose).toHaveBeenCalledTimes(1);
  expect(ui.rpc.pendingDialogIds).toEqual([]);
});

it("accepts exact frame bounds and many frames in one larger chunk", () => {
  const line = JSON.stringify({ type: "agent_start" });
  const h = setup("pi@0.84.2", { maxFrameBytes: Buffer.byteLength(line) });
  h.readable.write(Buffer.from((line + "\n").repeat(100)));
  expect(h.onEvent).toHaveBeenCalledTimes(100);
  expect(h.onClose).not.toHaveBeenCalled();
});

it.each(["throw", "callback"])("cleans up on synchronous %s write failure", async (mode) => {
  const writable = Object.assign(new EventEmitter(), {
    write(_bytes: Buffer, done: (error?: Error) => void) {
      if (mode === "throw") throw new Error("fixture");
      done(new Error("fixture")); return true;
    },
  });
  const h = setup("prime@0.8.0", { writable });
  await expect(h.rpc.request("abort")).rejects.toThrow("write failed");
  expect(h.onClose).toHaveBeenCalledTimes(1);
});

it("resumes after drain and write acknowledgement", async () => {
  const writable = Object.assign(new EventEmitter(), {
    write: vi.fn((_bytes: Buffer, _done: (error?: Error) => void) => false),
  });
  const h = setup("pi@0.84.2", { writable });
  const first = h.rpc.request("get_state");
  await expect(h.rpc.request("abort")).rejects.toThrow("backpressure");
  writable.write.mock.calls[0][1](); writable.emit("drain");
  const second = h.rpc.request("abort");
  for (const [bytes, done] of writable.write.mock.calls) {
    const command = JSON.parse(bytes.toString());
    h.emit({ type: "response", id: command.id, command: command.type, success: true });
    if (command.type === "abort") done();
  }
  await Promise.all([first, second]);
});

it("allows explicit confirmation, editor text and cancellation of each dialog method", () => {
  const h = setup();
  for (const method of ["confirm", "select", "input", "editor"]) {
    h.emit({ type: "extension_ui_request", id: method, method, options: ["x"] });
    h.rpc.respondToDialog(method, { cancelled: true });
  }
  h.emit({ type: "extension_ui_request", id: "confirm", method: "confirm" });
  h.rpc.respondToDialog("confirm", { confirmed: true });
  h.emit({ type: "extension_ui_request", id: "editor", method: "editor" });
  h.rpc.respondToDialog("editor", { value: "line 1\nline 2" });
  expect(h.sent.slice(0, 4).every((value) => value.cancelled === true)).toBe(true);
  expect(h.sent[4].confirmed).toBe(true);
  expect(h.sent[5].value).toBe("line 1\nline 2");
});
