import { describe, expect, it } from "vitest";
import {
  checkboxSelection, displayText, MAX_ID_LENGTH, MAX_TEXT_LENGTH, sanitizeOptions, withUnavailableOptions,
} from "./options.ts";

const options = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ value: `tool-${index}`, title: `Tool ${index}` }));

describe("sanitizeOptions", () => {
  it("truncates an overflowing suggestion list but refuses an overflowing grant list", () => {
    expect(sanitizeOptions(options(201), "truncate")).toHaveLength(200);
    expect(() => sanitizeOptions(options(201), "refuse")).toThrow(/at most 200 options/i);
    expect(sanitizeOptions(options(200), "refuse")).toHaveLength(200);
  });

  it("drops an option whose value would have to be clipped, but clips its title", () => {
    const [kept, ...rest] = sanitizeOptions([
      { value: "ok", title: "t".repeat(MAX_TEXT_LENGTH + 10) },
      { value: "v".repeat(MAX_ID_LENGTH + 1), title: "Too long" },
      { value: "", title: "Empty" },
      { value: "untitled" },
      "not an option",
    ], "truncate");
    expect(rest).toEqual([]);
    expect(kept).toEqual({ value: "ok", title: "t".repeat(MAX_TEXT_LENGTH) });
  });

  // A third party names the file or channel; these characters let a name reorder the text around it.
  it("strips bidirectional and control characters from what it shows", () => {
    const [option] = sanitizeOptions([{
      value: "id\u202e1",
      title: "Report\u202efdp.exe",
      subtitle: "line\nbreak",
      meta: "\u2066meta\u2069",
    }], "truncate");
    expect(option).toEqual({ value: "id\u202e1", title: "Reportfdp.exe", subtitle: "linebreak", meta: "meta" });
    expect(displayText("\u200f")).toBeUndefined();
  });
});

describe("checkbox selection", () => {
  it("keeps stale selections visible so they can be cleared", () => {
    expect(withUnavailableOptions([{ value: "current", title: "Current" }], "current, removed")).toEqual([
      { value: "current", title: "Current" },
      { value: "removed", title: "removed (unavailable)" },
    ]);
  });

  it("presents every loaded option as selected when asked, whatever the value", () => {
    const loaded = [{ value: "read", title: "Read" }, { value: "write", title: "Write" }];
    expect([...checkboxSelection(loaded, null, true)]).toEqual(["read", "write"]);
    expect([...checkboxSelection(loaded, "write", false)]).toEqual(["write"]);
  });
});
