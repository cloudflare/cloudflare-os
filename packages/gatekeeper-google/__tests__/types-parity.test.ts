import { describe, expect, it } from "vitest";
import bigqueryDeclared from "../src/bigquery-types.d.ts?raw";
import bigqueryShipped from "../src/bigquery-types.txt?raw";
import calendarDeclared from "../src/calendar-types.d.ts?raw";
import calendarShipped from "../src/calendar-types.txt?raw";
import docsDeclared from "../src/docs-types.d.ts?raw";
import docsShipped from "../src/docs-types.txt?raw";
import driveDeclared from "../src/drive-types.d.ts?raw";
import driveShipped from "../src/drive-types.txt?raw";
import sheetsDeclared from "../src/sheets-types.d.ts?raw";
import sheetsShipped from "../src/sheets-types.txt?raw";
import gmailDeclared from "../src/types.d.ts?raw";
import gmailShipped from "../src/types.txt?raw";

// Every agent-facing type surface exists twice: a `.d.ts` the server type-checks against, and a
// byte-identical `.txt` that wrangler bundles as a Text module and getTypeScriptTypes() returns
// verbatim as the contract the model codes against. Nothing but this test keeps them in step, and
// a one-sided edit ships the agent a signature the server does not implement — silent at build
// time, and it surfaces as an agent calling a method that isn't there.
describe("agent-facing TypeScript type modules", () => {
  it.each([
    ["types", gmailShipped, gmailDeclared],
    ["docs-types", docsShipped, docsDeclared],
    ["sheets-types", sheetsShipped, sheetsDeclared],
    ["calendar-types", calendarShipped, calendarDeclared],
    ["bigquery-types", bigqueryShipped, bigqueryDeclared],
    ["drive-types", driveShipped, driveDeclared],
  ])("keeps %s.txt identical to its .d.ts", (name, shipped, declared) => {
    expect(shipped, `${name}.txt drifted from ${name}.d.ts; copy the .d.ts over the .txt`)
      .toBe(declared);
  });
});
