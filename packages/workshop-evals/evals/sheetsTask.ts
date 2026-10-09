import { inflateRawSync } from "node:zlib";
import type { GadgetStub, SheetsDocument } from "../../bundled-blueprints/blueprints/workspace-sheets/files/lib/protocol.ts";
import { asEvidence, defineEvalTask } from "../src/task.js";
import type { EvalVerifier } from "../src/verifier.js";

const TITLE = "Sheets workflow check";
const SOURCE = "Owner's Sheet";
const SUMMARY = "Summary";
const FORMULAS = {
  A1: String.raw`=COUNTIF('Owner\'s Sheet'!C2:C4,'Complete')`,
  A2: String.raw`=SUM('Owner\'s Sheet'!$B$2:$B$4)`,
  A3: String.raw`='a\"b'`,
};

// The built-in exporter produces ZIP32 with stored or raw-deflated entries. Read the central
// directory: local headers intentionally omit sizes because the export is streamed.
function workbookParts(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = bytes.length - 22;
  if (view.getUint32(end, true) !== 0x06054b50) throw new Error("Missing XLSX ZIP directory");
  const parts = new Map<string, string>();
  const decoder = new TextDecoder();
  let offset = view.getUint32(end + 16, true);
  for (let entry = 0; entry < view.getUint16(end + 10, true); entry++) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error("Invalid XLSX ZIP entry");
    const method = view.getUint16(offset + 10, true);
    const size = view.getUint32(offset + 20, true);
    const nameLength = view.getUint16(offset + 28, true);
    const local = view.getUint32(offset + 42, true);
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = bytes.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new Error("Unsupported XLSX compression");
    parts.set(decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength)),
      decoder.decode(method === 8 ? inflateRawSync(data) : data));
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return parts;
}

function sheetId(document: SheetsDocument, name: string): string {
  const matches = document.sheetOrder.filter(id => document.sheets[id]?.name === name);
  if (matches.length !== 1) throw new Error(`Expected exactly one sheet named ${name}`);
  return matches[0];
}

async function verifySheets(verifier: EvalVerifier, prefix: string): Promise<void> {
  await verifier.check(`${prefix}-preserves-filter-chart-and-comment`, async () => {
    using api = await verifier.connect<GadgetStub>(TITLE);
    const document = await api.getDocument();
    const source = document.sheets[sheetId(document, SOURCE)];
    const summary = sheetId(document, SUMMARY);
    return {
      pass: source.filter?.criteria?.["2"]?.includes("s:Complete") === true &&
        source.charts?.some(chart => chart.type === "line" && chart.range === "A1:B4") === true &&
        source.comments?.some(comment => comment.ref === "B2" && comment.text === "Reviewed sales") === true &&
        Object.entries(FORMULAS).every(([ref, formula]) => document.cells[summary]?.[ref]?.value === formula),
      evidence: asEvidence({ filter: source.filter, charts: source.charts, comments: source.comments }),
    };
  });
  await verifier.check(`${prefix}-exports-formulas-filtered-chart-and-comments`, async () => {
    const parts = workbookParts(await verifier.exportFile(TITLE, "xlsx"));
    const worksheets = [...parts].filter(([name]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name));
    const formulas = worksheets.flatMap(([, xml]) => [...xml.matchAll(/<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/g)]
      .map(match => match[1]));
    const source = worksheets.find(([, xml]) => xml.includes("<autoFilter"))?.[1] ?? "";
    const chart = [...parts].find(([name]) => /^xl\/charts\/chart\d+\.xml$/.test(name))?.[1] ?? "";
    const comments = [...parts].filter(([name]) => /^xl\/comments\d+\.xml$/.test(name))
      .map(([, xml]) => xml).join("");
    return {
      pass: formulas.includes(`COUNTIF('Owner''s Sheet'!C2:C4,"Complete")`) &&
        formulas.includes(`SUM('Owner''s Sheet'!$B$2:$B$4)`) &&
        formulas.includes('"a\\""b"') && /<row\b[^>]*\br="4"[^>]*\bhidden="1"/.test(source) &&
        chart.includes('<c:lineChart>') && chart.includes("'Owner''s Sheet'!$B$2:$B$4") &&
        chart.includes('<c:plotVisOnly val="1"/>') && comments.includes('ref="B2"') && comments.includes("Reviewed sales"),
      evidence: { formulas, filteredRow: source.match(/<row\b[^>]*\br="4"[^>]*>/)?.[0] ?? null,
        chartReferences: [...chart.matchAll(/<c:f>(.*?)<\/c:f>/g)].map(match => match[1]) },
    };
  });
}

/** Exercise the bundled Sheets implementation before and after accepting the agent's setup. */
export const sheetsTask = defineEvalTask({
  id: "sheets",
  turns: [{
    prompt: `Create a Gadget named exactly "${TITLE}" using the built-in format.spreadsheet blueprint.
Keep the blueprint's existing code, RPC API, and Excel export implementation; configure it using
its documented applyOperation/getDocument workflow rather than replacing or wrapping the server.

Create a sheet named "${SOURCE}" with these cells (rows are listed in order):
Region\tSales\tStatus
East\t10\tComplete
West\t20\tComplete
East\t30\tCancelled

Give this source sheet a filter across A1:C4 showing only Complete rows. Add a line chart over
A1:B4 with first-row headers and first-column labels, and a comment on B2 saying "Reviewed sales".
Create a second sheet named "${SUMMARY}" containing these exact formulas:
${Object.entries(FORMULAS).map(([ref, formula]) => `${ref}: ${formula}`).join("\n")}

Leave both sheets and their data configured when finished. The standard getDocument RPC and xlsx
export must still work, and this setup must survive accepting and reloading the Gadget.`,
    verify: verifier => verifySheets(verifier, "provisional"),
    verifyAfterAccept: verifier => verifySheets(verifier, "accepted"),
  }],
});
