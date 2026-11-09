import { describe, expect, it, vi } from "vitest";
import type { MessageFormatRef } from "@gadgets/workshop-shared/api";

// overseer.ts reaches capnweb-validate's decorators, which need the bundler plugin. Same stub the
// other overseer tests use.
vi.mock("capnweb-validate", () => ({ validateRpc: () => () => undefined }));

const { sanitizeCommandPosition, sanitizeMessageFormatRefs } = await import("../src/overseer.js");

// "create a Doc for homework and Slides for the presentation"
//  0123456789...
const MESSAGE = "create a Doc for homework and Slides for the presentation";
const DOC_AT = MESSAGE.indexOf("Doc");
const SLIDES_AT = MESSAGE.indexOf("Slides");

function ref(overrides: Partial<MessageFormatRef> = {}): MessageFormatRef {
  return {
    position: DOC_AT,
    length: 3,
    noun: "Doc",
    icon: "fileText",
    ...overrides,
  };
}

describe("sanitizeMessageFormatRefs", () => {
  it("keeps well-formed refs, sorted by position", () => {
    let result = sanitizeMessageFormatRefs([
      ref({position: SLIDES_AT, length: 6, noun: "Slides", icon: "presentation"}),
      ref(),
    ], MESSAGE);
    expect(result?.map(r => r.noun)).toEqual(["Doc", "Slides"]);
  });

  it("drops a ref whose span doesn't hold its own noun", () => {
    // The load-bearing check: without it a ref could relabel an arbitrary piece of the user's text.
    expect(sanitizeMessageFormatRefs([ref({position: 0})], MESSAGE)).toBeUndefined();
  });

  it("drops refs that run past the end of the message", () => {
    expect(sanitizeMessageFormatRefs([ref({length: 999})], MESSAGE)).toBeUndefined();
  });

  it("drops refs with a non-integer or negative span", () => {
    expect(sanitizeMessageFormatRefs([ref({position: 1.5})], MESSAGE)).toBeUndefined();
    expect(sanitizeMessageFormatRefs([ref({position: -1})], MESSAGE)).toBeUndefined();
    expect(sanitizeMessageFormatRefs([ref({length: 0})], MESSAGE)).toBeUndefined();
  });

  it("drops refs naming an icon outside the closed set", () => {
    expect(sanitizeMessageFormatRefs(
        [ref({icon: "skull" as MessageFormatRef["icon"]})], MESSAGE)).toBeUndefined();
  });

  it("drops the second of two overlapping refs", () => {
    // Two chips over the same text would paint it twice.
    let result = sanitizeMessageFormatRefs([
      ref(),
      ref({position: DOC_AT + 1, length: 2, noun: "oc"}),
    ], MESSAGE);
    expect(result).toHaveLength(1);
    expect(result?.[0].position).toBe(DOC_AT);
  });

  it("keeps a repeated format that appears twice in the text", () => {
    let message = "a Doc and another Doc";
    let result = sanitizeMessageFormatRefs([
      ref({position: 2}),
      ref({position: message.lastIndexOf("Doc")}),
    ], message);
    expect(result).toHaveLength(2);
  });

  it("tolerates a malformed ref alongside a good one", () => {
    let result = sanitizeMessageFormatRefs([ref({position: 0}), ref()], MESSAGE);
    expect(result?.map(r => r.position)).toEqual([DOC_AT]);
  });

  it("returns undefined for an empty list or a message-less record", () => {
    expect(sanitizeMessageFormatRefs([], MESSAGE)).toBeUndefined();
    expect(sanitizeMessageFormatRefs(undefined, MESSAGE)).toBeUndefined();
    expect(sanitizeMessageFormatRefs([ref()], undefined)).toBeUndefined();
  });

  it("bounds how many refs one message can carry", () => {
    let message = "Doc ".repeat(64).trim();
    let many = Array.from({length: 64}, (_, i) => ref({position: i * 4}));
    expect(sanitizeMessageFormatRefs(many, message)!.length).toBeLessThanOrEqual(32);
  });

  it("drops an unreasonably long noun", () => {
    let long = "x".repeat(200);
    expect(sanitizeMessageFormatRefs(
        [ref({position: 0, length: long.length, noun: long})], long)).toBeUndefined();
  });
});

describe("sanitizeCommandPosition", () => {
  const request = (args: string, commandPosition?: number) =>
      ({id: {gatekeeperId: 1, commandId: "deploy"}, args, commandPosition}) as never;

  it("keeps a position inside the arguments", () => {
    expect(sanitizeCommandPosition(request("Please use for staging", 11))).toBe(11);
  });

  it("treats a missing, leading or out-of-range position as absent", () => {
    // Absent and 0 render identically -- the command leads the line -- so there is nothing to store.
    expect(sanitizeCommandPosition(request("staging"))).toBeUndefined();
    expect(sanitizeCommandPosition(request("staging", 0))).toBeUndefined();
    // Out of range is display data that can't be honoured, so the command renders where it always
    // did rather than the message being refused.
    expect(sanitizeCommandPosition(request("staging", 999))).toBeUndefined();
    expect(sanitizeCommandPosition(request("staging", -1))).toBeUndefined();
    expect(sanitizeCommandPosition(request("staging", 1.5))).toBeUndefined();
  });

  it("accepts a position at the very end of the arguments", () => {
    // A command typed last: the trailing space is trimmed, leaving the seam on the boundary.
    expect(sanitizeCommandPosition(request("ship it with", 12))).toBe(12);
  });
});
