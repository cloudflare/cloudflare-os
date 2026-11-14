import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { PROPERTY_RUN_OPTIONS } from '@gadgets/scripts/property-runs';
import { StreamingToolInputParser } from '../src/streaming-json-parser.js';
import {
  cutDeltas, decodableValue, deltaSizes, previewedToolCall, serialize, STREAMED_FIELD,
  type PreviewedToolCall,
} from './tool-input-streams.js';

// Helper: feed a complete JSON string in one shot.
function parseAll(streamingField: string, json: string) {
  let p = new StreamingToolInputParser(streamingField);
  p.append(json);
  return p;
}

// Helper: feed a JSON string one character at a time.
function parseCharByChar(streamingField: string, json: string) {
  let p = new StreamingToolInputParser(streamingField);
  for (let ch of json) {
    p.append(ch);
  }
  return p;
}

// Helper: feed a JSON string in random-sized chunks (seeded for reproducibility).
function parseRandomChunks(streamingField: string, json: string, seed: number = 42) {
  let p = new StreamingToolInputParser(streamingField);
  let pos = 0;
  let rng = seed;
  while (pos < json.length) {
    // Simple LCG for deterministic chunk sizes 1–8.
    rng = (rng * 1664525 + 1013904223) & 0x7fffffff;
    let chunkSize = (rng % 8) + 1;
    p.append(json.slice(pos, pos + chunkSize));
    pos += chunkSize;
  }
  return p;
}

// Run a test case with all three feeding strategies.
function testAllStrategies(
    streamingField: string,
    json: string,
    check: (p: StreamingToolInputParser) => void) {
  check(parseAll(streamingField, json));
  check(parseCharByChar(streamingField, json));
  check(parseRandomChunks(streamingField, json));
}

// ===========================================================================
// Basic functionality
// ===========================================================================

describe('StreamingToolInputParser', () => {
  describe('basic writeFile-style input', () => {
    let json = '{"filename": "foo.ts", "content": "hello world"}';

    it('parses prefix fields and streaming value', () => {
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ filename: "foo.ts" });
        expect(p.streamingValue).toBe("hello world");
        expect(p.streamComplete).toBe(true);
      });
    });
  });

  describe('editFile-style input with three fields', () => {
    let json = '{"filename": "app.js", "textToReplace": "old code", "replacement": "new code"}';

    it('parses two prefix fields and streams the third', () => {
      testAllStrategies("replacement", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({
          filename: "app.js",
          textToReplace: "old code",
        });
        expect(p.streamingValue).toBe("new code");
        expect(p.streamComplete).toBe(true);
      });
    });
  });

  describe('executeCode-style input with only the streaming field', () => {
    let json = '{"code": "console.log(42)"}';

    it('parses empty prefix and streams the value', () => {
      testAllStrategies("code", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({});
        expect(p.streamingValue).toBe("console.log(42)");
        expect(p.streamComplete).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Escape handling in the streaming field
  // ===========================================================================

  describe('escape sequences in streaming value', () => {
    it('handles simple escapes', () => {
      let json = '{"content": "line1\\nline2\\ttab\\\\\\"end"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.streamingValue).toBe('line1\nline2\ttab\\"end');
        expect(p.streamComplete).toBe(true);
      });
    });

    it('handles unicode escapes', () => {
      let json = '{"content": "caf\\u00e9 \\u0041"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.streamingValue).toBe("caf\u00e9 A");
        expect(p.streamComplete).toBe(true);
      });
    });

    it('handles escape at exact chunk boundary', () => {
      // Split right before the backslash
      let p = new StreamingToolInputParser("content");
      p.append('{"content": "abc');
      expect(p.streamingValue).toBe("abc");
      p.append('\\');
      expect(p.streamingValue).toBe("abc"); // backslash waiting for next char
      p.append('n');
      expect(p.streamingValue).toBe("abc\n");
      p.append('def"}');
      expect(p.streamingValue).toBe("abc\ndef");
      expect(p.streamComplete).toBe(true);
    });

    it('handles \\uXXXX split across chunks', () => {
      let p = new StreamingToolInputParser("content");
      p.append('{"content": "x\\u00');
      expect(p.streamingValue).toBe("x"); // incomplete \uXXXX
      p.append('e9y"}');
      expect(p.streamingValue).toBe("x\u00e9y");
      expect(p.streamComplete).toBe(true);
    });
  });

  // ===========================================================================
  // Non-string prefix values (numbers, booleans, null, objects, arrays)
  // ===========================================================================

  describe('non-string prefix values', () => {
    it('skips numeric prefix values', () => {
      let json = '{"line": 42, "content": "hello"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ line: 42 });
        expect(p.streamingValue).toBe("hello");
      });
    });

    it('skips boolean prefix values', () => {
      let json = '{"verbose": true, "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ verbose: true });
        expect(p.streamingValue).toBe("data");
      });
    });

    it('skips null prefix values', () => {
      let json = '{"prev": null, "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ prev: null });
        expect(p.streamingValue).toBe("data");
      });
    });

    it('skips nested object prefix values', () => {
      let json = '{"meta": {"a": 1, "b": "two"}, "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ meta: { a: 1, b: "two" } });
        expect(p.streamingValue).toBe("data");
      });
    });

    it('skips nested array prefix values', () => {
      let json = '{"tags": ["a", "b", "c"], "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ tags: ["a", "b", "c"] });
        expect(p.streamingValue).toBe("data");
      });
    });

    it('skips deeply nested prefix values', () => {
      let json = '{"meta": {"nested": {"deep": [1, {"x": "y"}]}}, "content": "ok"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ meta: { nested: { deep: [1, { x: "y" }] } } });
        expect(p.streamingValue).toBe("ok");
      });
    });

    it('handles strings with escapes inside nested objects', () => {
      // The string inside the nested object contains a quote escape and braces.
      let json = '{"meta": {"desc": "has \\"quotes\\" and {braces}"}, "content": "ok"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ meta: { desc: 'has "quotes" and {braces}' } });
        expect(p.streamingValue).toBe("ok");
      });
    });
  });

  // ===========================================================================
  // Escape handling in keys
  // ===========================================================================

  describe('escape sequences in keys', () => {
    it('handles simple escapes in non-streaming keys', () => {
      let json = '{"file\\nname": "foo.ts", "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ "file\nname": "foo.ts" });
        expect(p.streamingValue).toBe("data");
      });
    });

    it('handles unicode escapes in keys', () => {
      let json = '{"\\u0066ile": "foo.ts", "content": "data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ "file": "foo.ts" });
        expect(p.streamingValue).toBe("data");
      });
    });
  });

  // ===========================================================================
  // Incremental streaming behavior
  // ===========================================================================

  describe('incremental streaming', () => {
    it('grows streamingValue as tokens arrive', () => {
      let p = new StreamingToolInputParser("content");

      p.append('{"filen');
      expect(p.prefixFields).toBeNull();
      expect(p.streamingValue).toBe("");

      p.append('ame": "test.js", "con');
      expect(p.prefixFields).toBeNull();

      p.append('tent": "hel');
      expect(p.prefixFields).toEqual({ filename: "test.js" });
      expect(p.streamingValue).toBe("hel");
      expect(p.streamComplete).toBe(false);

      p.append('lo wor');
      expect(p.streamingValue).toBe("hello wor");

      p.append('ld"}');
      expect(p.streamingValue).toBe("hello world");
      expect(p.streamComplete).toBe(true);
    });

    it('never regresses streamingValue length', () => {
      let json = '{"content": "abcdefghijklmnopqrstuvwxyz"}';
      let p = new StreamingToolInputParser("content");
      let prevLen = 0;
      for (let ch of json) {
        p.append(ch);
        expect(p.streamingValue.length).toBeGreaterThanOrEqual(prevLen);
        prevLen = p.streamingValue.length;
      }
      expect(p.streamingValue).toBe("abcdefghijklmnopqrstuvwxyz");
    });
  });

  // ===========================================================================
  // Whitespace handling
  // ===========================================================================

  describe('whitespace handling', () => {
    it('handles extra whitespace around structure', () => {
      let json = '  { "filename" :  "f.ts" ,  "content" :  "data"  }  ';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ filename: "f.ts" });
        expect(p.streamingValue).toBe("data");
        expect(p.streamComplete).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Edge cases
  // ===========================================================================

  describe('edge cases', () => {
    it('handles empty streaming value', () => {
      let json = '{"filename": "f.ts", "content": ""}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ filename: "f.ts" });
        expect(p.streamingValue).toBe("");
        expect(p.streamComplete).toBe(true);
      });
    });

    it('handles empty object without the streaming field', () => {
      let json = '{}';
      let p = parseAll("content", json);
      expect(p.hasError).toBe(false);
      expect(p.prefixFields).toBeNull(); // streaming field never found
      expect(p.streamingValue).toBe("");
    });

    it('handles incomplete input (partial prefix key)', () => {
      let p = new StreamingToolInputParser("content");
      p.append('{"file');
      expect(p.hasError).toBe(false);
      expect(p.prefixFields).toBeNull();
    });

    it('handles incomplete input (partial streaming value)', () => {
      let p = new StreamingToolInputParser("content");
      p.append('{"content": "partial');
      expect(p.hasError).toBe(false);
      expect(p.prefixFields).toEqual({});
      expect(p.streamingValue).toBe("partial");
      expect(p.streamComplete).toBe(false);
    });

    it('handles prefix field whose string value contains the streaming key name', () => {
      // The value of "description" contains "content" — should not confuse the parser.
      let json = '{"description": "the content field", "content": "real data"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.prefixFields).toEqual({ description: "the content field" });
        expect(p.streamingValue).toBe("real data");
      });
    });

    it('handles streaming value with embedded JSON', () => {
      // The streaming value itself contains JSON-like text with quotes and braces.
      let json = '{"content": "fn() { return {\\"key\\": \\"val\\"}; }"}';
      testAllStrategies("content", json, p => {
        expect(p.hasError).toBe(false);
        expect(p.streamingValue).toBe('fn() { return {"key": "val"}; }');
        expect(p.streamComplete).toBe(true);
      });
    });
  });

  // ===========================================================================
  // Error cases
  // ===========================================================================

  describe('error cases', () => {
    it('reports error for non-object input', () => {
      let p = parseAll("content", '"not an object"');
      expect(p.hasError).toBe(true);
    });

    it('reports error for non-string streaming field value', () => {
      let p = parseAll("content", '{"content": 42}');
      expect(p.hasError).toBe(true);
    });

    it('reports error for invalid escape in streaming value', () => {
      let p = parseAll("content", '{"content": "bad\\qescape"}');
      expect(p.hasError).toBe(true);
    });

    it('reports error for invalid unicode escape in streaming value', () => {
      let p = parseAll("content", '{"content": "bad\\uXXXXescape"}');
      expect(p.hasError).toBe(true);
    });

    it('reports error for invalid escape in key', () => {
      let p = parseAll("content", '{"bad\\qkey": "val", "content": "data"}');
      expect(p.hasError).toBe(true);
    });

    it('reports error for missing colon', () => {
      let p = parseAll("content", '{"content" "oops"}');
      expect(p.hasError).toBe(true);
    });
  });
});

// ===========================================================================
// Property: the live preview of a streamed tool call
// ===========================================================================

// While an agent streams a writeFile / editFile / executeCode call, the preview shows the
// streamed field as far as it has arrived. fast-check generates the calls agents make (source
// text with quotes, backslashes, CRLFs, accented text and emoji), serialized compactly or with
// spaces, with raw or `\uXXXX`-escaped non-ASCII, and cut into provider deltas anywhere -- inside
// an escape, or between a surrogate pair's halves. After every delta the parser must hold exactly
// what that much input determines: no prefix fields until the streamed value opens, then all of
// them; the streamed value decoded up to any escape still cut off, so it only grows and never
// lags; and, at the end, the same input JSON.parse reads.
describe('StreamingToolInputParser property', () => {
  it('tracks the decodable prefix of a streamed tool input after every delta', () => {
    let surrogateCall: PreviewedToolCall = {
      toolName: "writeFile",
      input: {filename: "app.ts", content: "label: '😀',\n\\\"end\\\""},
      asciiOnly: true,
      spaced: true,
    };
    fc.assert(fc.property(previewedToolCall, deltaSizes, (call, sizes) => {
      let field = STREAMED_FIELD[call.toolName];
      let {json, valueStart} = serialize(call);
      let {[field]: value, ...prefix} = JSON.parse(json);
      let parser = new StreamingToolInputParser(field);
      let received = 0;
      for (let delta of cutDeltas(json, sizes)) {
        parser.append(delta);
        received += delta.length;
        let at = `after ${received} of ${json.length} chars of ${json}`;
        expect(parser.hasError, at).toBe(false);
        expect(parser.prefixFields, at).toEqual(received >= valueStart ? prefix : null);
        // Compared JSON-encoded: the value may end in a lone high surrogate, which in a failure
        // message is invalid UTF-8 to the vitest pool's WebSocket, which then drops the report.
        expect(JSON.stringify(parser.streamingValue), at)
            .toBe(JSON.stringify(decodableValue(json, valueStart, received)));
        expect(parser.streamComplete, at).toBe(received >= json.length - 1);
      }
      expect(parser.prefixFields).toEqual(prefix);
      expect(parser.streamingValue).toBe(value);
    }), {
      ...PROPERTY_RUN_OPTIONS,
      numRuns: 200,
      examples: [
        // One UTF-16 code unit per delta: every escape and `\ud83d\ude00` pair split everywhere.
        [surrogateCall, [1]],
        [{...surrogateCall, asciiOnly: false}, [1]],
      ],
    });
  });
});
