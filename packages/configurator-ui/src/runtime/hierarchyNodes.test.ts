import { describe, expect, it } from "vitest";
import { splitTitle } from "./hierarchyNodes.ts";

describe("splitTitle", () => {
  it("keeps the extension and the 3 characters before it in view", () => {
    expect(splitTitle("Quarterly budget forecast v3.xlsx")).toEqual(["Quarterly budget forecast", " v3.xlsx"]);
    expect(splitTitle("archive.tar.gz")).toEqual(["archive.", "tar.gz"]);
  });

  // Counted in code units, the split would draw half of the flag, or the accent without its letter.
  it("never splits a character as the user sees it", () => {
    expect(splitTitle("Trip 🇯🇵.pptx")).toEqual(["Tri", "p 🇯🇵.pptx"]);
    expect(splitTitle("Cafe\u0301 2.pdf")).toEqual(["Caf", "e\u0301 2.pdf"]);
  });

  it("leaves whole a title without an extension, or with nothing before its end to give way", () => {
    for (const title of ["Reports", "Notes v2", "abc.pdf", ".bashrc"]) expect(splitTitle(title)).toBeUndefined();
  });
});
