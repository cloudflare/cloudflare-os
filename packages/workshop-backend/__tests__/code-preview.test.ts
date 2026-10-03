import { describe, it, expect } from 'vitest';
import { CodePreviewManager, ExecuteCodeStreamManager } from '../src/code-preview';
import type { AiChatStreamEvent } from '@gadgets/workshop-shared/api';

// ===========================================================================
// Helpers
// ===========================================================================

const CALL = "call_1";

function makeManager() {
  let events: AiChatStreamEvent[] = [];
  let manager = new CodePreviewManager(
      ev => events.push(ev),
      workpiece => {
        if (workpiece === "missing") throw new Error("no such workpiece");
        return {workpieceId: 7};
      });
  return {events, manager};
}

// Feed `json` to the manager in chunks of the given size (default: one char at a time), then
// finish the call.
function feed(manager: CodePreviewManager, toolName: "writeFile" | "editFile", json: string,
              chunkSize = 1, finish = true) {
  manager.startToolCall(CALL, toolName);
  for (let pos = 0; pos < json.length; pos += chunkSize) {
    manager.appendInput(CALL, json.slice(pos, pos + chunkSize));
  }
  if (finish) manager.finishToolCall(CALL, true);
}

function ofType<T extends AiChatStreamEvent["type"]>(events: AiChatStreamEvent[], type: T) {
  return events.filter(ev => ev.type === type) as Extract<AiChatStreamEvent, {type: T}>[];
}

// The preview content accumulated by editPreviewDelta events.
function streamedText(events: AiChatStreamEvent[]): string {
  return ofType(events, "editPreviewDelta").map(ev => ev.delta).join("");
}

// ===========================================================================
// CodePreviewManager content previews
// ===========================================================================

describe('CodePreviewManager', () => {
  describe('writeFile previews', () => {
    let json = '{"workpiece": "app", "filename": "foo.ts", "content": "hello\\nworld"}';

    it('emits a whole-file preview start followed by the streamed content', () => {
      for (let chunkSize of [1, 3, json.length]) {
        let {events, manager} = makeManager();
        feed(manager, "writeFile", json, chunkSize);

        let starts = ofType(events, "editPreviewStart");
        expect(starts).toEqual([{
          type: "editPreviewStart",
          toolCallId: CALL,
          file: {workpieceId: 7, filename: "foo.ts"},
        }]);
        expect(streamedText(events)).toBe("hello\nworld");
        expect(ofType(events, "editPreviewClear")).toEqual([]);

        // The start follows the target events and precedes every delta.
        let types = events.map(ev => ev.type);
        expect(types.indexOf("editPreviewStart")).toBeGreaterThan(types.indexOf("toolCallTarget"));
        expect(types.indexOf("editPreviewStart")).toBeLessThan(types.indexOf("editPreviewDelta"));
      }
    });

    it('emits deltas as content arrives, not only at the end', () => {
      let {events, manager} = makeManager();
      feed(manager, "writeFile", json, 1, /*finish=*/ false);
      // Streaming is still mid-call (no finish), yet the content has already been delivered.
      expect(streamedText(events)).toBe("hello\nworld");
    });
  });

  describe('editFile previews', () => {
    let json = '{"workpiece": "app", "filename": "foo.ts", ' +
        '"textToReplace": "old text", "replacement": "new text"}';

    it('carries textToReplace on the start and streams the replacement', () => {
      let {events, manager} = makeManager();
      feed(manager, "editFile", json);

      expect(ofType(events, "editPreviewStart")).toEqual([{
        type: "editPreviewStart",
        toolCallId: CALL,
        file: {workpieceId: 7, filename: "foo.ts"},
        textToReplace: "old text",
      }]);
      expect(streamedText(events)).toBe("new text");
    });

    it('shows no preview when textToReplace is missing', () => {
      let {events, manager} = makeManager();
      feed(manager, "editFile",
          '{"workpiece": "app", "filename": "foo.ts", "replacement": "new text"}');

      // The target is still surfaced (the file focus events don't need textToReplace)...
      expect(ofType(events, "toolCallTarget").length).toBe(1);
      // ...but no content preview is opened for a call the tool will reject.
      expect(ofType(events, "editPreviewStart")).toEqual([]);
      expect(ofType(events, "editPreviewDelta")).toEqual([]);
    });
  });

  describe('preview suppression and withdrawal', () => {
    it('shows no preview for an unresolvable workpiece', () => {
      let {events, manager} = makeManager();
      feed(manager, "writeFile",
          '{"workpiece": "missing", "filename": "foo.ts", "content": "hello"}');
      expect(ofType(events, "editPreviewStart")).toEqual([]);
      expect(ofType(events, "editPreviewDelta")).toEqual([]);
    });

    it('withdraws the preview on a mid-stream parse error', () => {
      let {events, manager} = makeManager();
      manager.startToolCall(CALL, "writeFile");
      manager.appendInput(CALL, '{"workpiece": "app", "filename": "foo.ts", "content": "hel');
      expect(streamedText(events)).toBe("hel");
      manager.appendInput(CALL, '\\q'); // invalid escape
      expect(ofType(events, "editPreviewClear"))
          .toEqual([{type: "editPreviewClear", toolCallId: CALL}]);
    });

    it('withdraws the preview when the call finishes unsuccessfully', () => {
      let {events, manager} = makeManager();
      manager.startToolCall(CALL, "writeFile");
      manager.appendInput(CALL, '{"workpiece": "app", "filename": "foo.ts", "content": "hel');
      manager.finishToolCall(CALL, false);
      expect(ofType(events, "editPreviewClear"))
          .toEqual([{type: "editPreviewClear", toolCallId: CALL}]);
    });

    it('clearPreview() withdraws once and is idempotent', () => {
      let {events, manager} = makeManager();
      feed(manager, "writeFile",
          '{"workpiece": "app", "filename": "foo.ts", "content": "hello"}');
      manager.clearPreview(CALL);
      manager.clearPreview(CALL);
      expect(ofType(events, "editPreviewClear"))
          .toEqual([{type: "editPreviewClear", toolCallId: CALL}]);
    });

    it('clearPreview() emits nothing when no preview started', () => {
      let {events, manager} = makeManager();
      manager.startToolCall(CALL, "writeFile");
      manager.appendInput(CALL, '{"workpiece": "missing", "filename": "foo.ts", "content": "x"}');
      manager.clearPreview(CALL);
      expect(ofType(events, "editPreviewClear")).toEqual([]);
    });

    it('ignores non-edit tools', () => {
      let {events, manager} = makeManager();
      manager.startToolCall(CALL, "executeCode");
      manager.appendInput(CALL, '{"code": "1 + 1"}');
      manager.finishToolCall(CALL, true);
      expect(events).toEqual([]);
    });
  });

  describe('surrogate-pair handling', () => {
    // A delta boundary must never split a surrogate pair: a lone surrogate becomes U+FFFD over
    // the UTF-8 wire, desynchronizing the client's accumulated preview text.
    it('never emits a delta ending in a lone high surrogate (raw astral chars)', () => {
      let json = '{"workpiece": "app", "filename": "foo.ts", "content": "a😀b😀"}';
      let {events, manager} = makeManager();
      feed(manager, "writeFile", json); // one char at a time: splits every pair
      for (let ev of ofType(events, "editPreviewDelta")) {
        let last = ev.delta.charCodeAt(ev.delta.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      expect(streamedText(events)).toBe("a😀b😀");
    });

    it('never emits a delta ending in a lone high surrogate (\\u escapes)', () => {
      let json = '{"workpiece": "app", "filename": "foo.ts", ' +
          '"content": "a\\ud83d\\ude00b"}';
      let {events, manager} = makeManager();
      feed(manager, "writeFile", json);
      for (let ev of ofType(events, "editPreviewDelta")) {
        let last = ev.delta.charCodeAt(ev.delta.length - 1);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
      }
      expect(streamedText(events)).toBe("a\ud83d\ude00b");
    });
  });
});

// ===========================================================================
// ExecuteCodeStreamManager
// ===========================================================================

describe('ExecuteCodeStreamManager', () => {
  it('streams code deltas without splitting surrogate pairs', () => {
    let events: AiChatStreamEvent[] = [];
    let manager = new ExecuteCodeStreamManager(ev => events.push(ev));
    let json = '{"code": "run(\'😀\')"}';
    manager.startToolCall(CALL, "executeCode");
    // Feed one UTF-16 code unit at a time (string indexing, not code-point iteration), so the
    // astral char's halves arrive in separate chunks.
    for (let pos = 0; pos < json.length; pos++) {
      manager.appendInput(CALL, json[pos]);
    }
    manager.finishToolCall(CALL);

    let deltas = ofType(events, "toolCodeDelta");
    for (let ev of deltas) {
      let last = ev.delta.charCodeAt(ev.delta.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
    expect(deltas.map(ev => ev.delta).join("")).toBe("run('😀')");
  });
});
