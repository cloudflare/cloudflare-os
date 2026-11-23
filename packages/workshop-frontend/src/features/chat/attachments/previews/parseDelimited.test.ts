import { describe, expect, it } from "vitest";
import { parseDelimited, sniffDelimiter } from "./parseDelimited";

describe("parseDelimited", () => {
  it("reads quoted cells holding delimiters, quotes and line breaks", () => {
    const text = 'name,note\r\n"Doe, Jane","said ""hi""\nthen left"\r\n';
    expect(parseDelimited(text, ",", 100).rows).toEqual([
      ["name", "note"],
      ["Doe, Jane", 'said "hi"\nthen left'],
    ]);
  });

  it("keeps empty cells and a last line with no line break", () => {
    expect(parseDelimited("a,,c\n,,", ",", 100).rows).toEqual([["a", "", "c"], ["", "", ""]]);
  });

  it("splits on tabs for TSV and ignores a byte-order mark", () => {
    expect(parseDelimited("﻿a\tb,c\n", "\t", 100).rows).toEqual([["a", "b,c"]]);
  });

  it("stops at the row limit and says whether more followed", () => {
    expect(parseDelimited("1\n2\n3\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], truncated: true });
    expect(parseDelimited("1\n2\n", ",", 2)).toEqual({ rows: [["1"], ["2"]], truncated: false });
  });

  it("tells a semicolon- or tab-separated file from a comma-separated one by its first line", () => {
    expect(sniffDelimiter("name;team\nJane;Platform\n")).toBe(";");
    expect(sniffDelimiter("name\tteam\n")).toBe("\t");
    expect(sniffDelimiter("name,team;lead\n1;2;3;4\n")).toBe(",");
    // Delimiters inside a quoted cell are part of the cell.
    expect(sniffDelimiter('"a;b;c",d\n')).toBe(",");
    expect(sniffDelimiter("single\n")).toBe(",");
  });
});
