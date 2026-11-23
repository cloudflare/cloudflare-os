import { expect, it } from "vitest";
import { applyCodeChange, composeCodeChange, transformCodeChange, validateCodeChangeSchema, validateBytesRef,
  type CodeChange, type FileChange } from "@gadgets/workshop-shared/code-change";

const bytes = {oid: "1".repeat(40), byteLength: 4};
const one = (change: FileChange): CodeChange => ({1: [["file", change]]});

it("composes whole-file binary replacements without retaining earlier payloads", () => {
  const replaced = {oid: "2".repeat(40), byteLength: 2};
  expect(composeCodeChange(one({setBytes: bytes}), one({setBytes: replaced}))).toEqual(one({setBytes: replaced}));
  expect(composeCodeChange(one({setBytes: bytes}), one({remove: true}))).toEqual(one({remove: true}));
  expect(composeCodeChange(one({setBytes: bytes}), one({set: "text"}))).toEqual(one({set: "text"}));
});

it("converges binary replacement, deletion and text races using the existing assignment priority", () => {
  const base = new Map([[1, new Map([["file", "text"]])]]);
  const operations: FileChange[] = [
    {setBytes: bytes}, {setBytes: {oid: "0".repeat(40), byteLength: 0}},
    {set: "replacement"}, {remove: true}, {edit: [4, [0, "!"]]},
  ];
  for (const a of operations) for (const b of operations) {
    const pair = transformCodeChange(one(a), one(b));
    expect(applyCodeChange(applyCodeChange(base, one(a)), pair.b))
      .toEqual(applyCodeChange(applyCodeChange(base, one(b)), pair.a));
    if (!("edit" in a) && !("edit" in b)) {
      expect(pair.a).toEqual({});
      expect(pair.b).toEqual(one(b));
    }
  }
});

it("keeps empty bytes distinct from deletion and rejects text edits on binary content", () => {
  const base = new Map([[1, new Map([["file", bytes]])]]);
  const empty = {oid: "0".repeat(40), byteLength: 0};
  expect(applyCodeChange(base, one({setBytes: empty})).get(1)?.get("file")).toEqual(empty);
  expect(applyCodeChange(base, one({remove: true})).get(1)?.has("file")).toBe(false);
  expect(() => applyCodeChange(base, one({edit: [4]}))).toThrow(/text base/);
});

it("rejects binary deltas rather than silently replacing them with their base", () => {
  expect(() => validateCodeChangeSchema(JSON.parse('{"1":[["file",{"editBytes":{"beforeBytes":4,"sections":[4]}}]]}'))).toThrow();
  expect(() => validateCodeChangeSchema(JSON.parse(`{"1":[["file",{"setBytes":{"oid":"${"1".repeat(40)}","byteLength":4,"edit":{"beforeBytes":4,"sections":[4]}}}]]}`))).toThrow(/byte reference/);
  expect(() => validateCodeChangeSchema(JSON.parse(`{"1":[["file",{"setBytes":{"base":{"oid":"${"1".repeat(40)}","byteLength":4}}}]]}`))).toThrow(/byte reference/);
  for (const byteLength of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    expect(() => validateBytesRef({oid: "a".repeat(40), byteLength})).toThrow();
  }
  expect(() => validateBytesRef({oid: "../file", byteLength: 1})).toThrow();
  expect(() => validateBytesRef({oid: "1".repeat(40), byteLength: 1, padding: "x"} as never)).toThrow();
  validateCodeChangeSchema(one({setBytes: bytes}));
});
