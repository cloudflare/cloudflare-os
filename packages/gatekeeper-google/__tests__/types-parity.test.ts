/// <reference types="node" />

import { readlinkSync } from "node:fs";
import { URL } from "node:url";
import { describe, expect, it } from "vitest";
import bigqueryDeclared from "../src/bigquery-types.d.ts?raw";
import bigqueryShipped from "../src/bigquery-types.txt?raw";
import calendarDeclared from "../src/calendar-types.d.ts?raw";
import calendarShipped from "../src/calendar-types.txt?raw";
import docsReadDeclared from "../src/docs-read-types.d.ts?raw";
import docsReadShipped from "../src/docs-read-types.txt?raw";
import docsDeclared from "../src/docs-types.d.ts?raw";
import docsShipped from "../src/docs-types.txt?raw";
import driveDeclared from "../src/drive-types.d.ts?raw";
import driveShipped from "../src/drive-types.txt?raw";
import sheetsDeclared from "../src/sheets-types.d.ts?raw";
import sheetsShipped from "../src/sheets-types.txt?raw";
import gmailDeclared from "../src/types.d.ts?raw";
import gmailShipped from "../src/types.txt?raw";

// Every agent-facing type surface has one authoritative `.d.ts`. Wrangler consumes the symlinked
// `.txt` path as a Text module and getTypeScriptTypes() returns it verbatim as the contract the model
// codes against. A broken symlink would keep the server type-checking while dropping or freezing the
// shipped contract.
describe("agent-facing TypeScript type modules", () => {
  it.each([
    ["types", gmailShipped, gmailDeclared],
    ["docs-read-types", docsReadShipped, docsReadDeclared],
    ["docs-types", docsShipped, docsDeclared],
    ["sheets-types", sheetsShipped, sheetsDeclared],
    ["calendar-types", calendarShipped, calendarDeclared],
    ["bigquery-types", bigqueryShipped, bigqueryDeclared],
    ["drive-types", driveShipped, driveDeclared],
  ])("keeps %s.txt identical to its .d.ts", (name, shipped, declared) => {
    expect(shipped, `${name}.txt drifted from ${name}.d.ts; restore the .txt symlink to the .d.ts`)
      .toBe(declared);
  });

  it.each([
    "types", "docs-read-types", "docs-types", "sheets-types", "calendar-types",
    "bigquery-types", "drive-types",
  ])("ships %s.txt as a symlink to its authoritative declaration", name => {
    expect(readlinkSync(new URL(`../src/${name}.txt`, import.meta.url))).toBe(`${name}.d.ts`);
  });
});
