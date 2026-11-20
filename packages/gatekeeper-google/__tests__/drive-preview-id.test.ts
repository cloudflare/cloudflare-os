import { expect, it } from "vitest";
import { drivePreviewId, parseDrivePreviewId } from "../src/drive-editors";

it("names a file by its kind and the folders between the connected one and it", () => {
  const nested = { fileId: "f_1", folderIds: ["root", "a-1", "b"] };
  expect(drivePreviewId("docs", nested)).toBe("docs:a-1/b/f_1");
  expect(parseDrivePreviewId("docs:a-1/b/f_1")).toEqual({ editor: "docs", folderIds: ["a-1", "b"], fileId: "f_1" });

  // A whole-Drive or exact-file binding, and a direct child of a folder, need no way in.
  expect(drivePreviewId("slides", { fileId: "f" })).toBe("slides:f");
  expect(drivePreviewId("sheets", { fileId: "f", folderIds: ["root"] })).toBe("sheets:f");
  expect(parseDrivePreviewId("sheets:f")).toEqual({ editor: "sheets", folderIds: [], fileId: "f" });
});

it("refuses a name it did not give", () => {
  for (const name of ["", "f", "pdf:f", "docs:", "docs:a//f", "docs:../f", "docs:a/f?x", "docs:a/f\n"]) {
    expect(() => parseDrivePreviewId(name), JSON.stringify(name)).toThrow("no preview by that name");
  }
});
