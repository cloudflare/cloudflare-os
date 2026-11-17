// The small pieces of SpreadsheetML reading behind the sheet reader (`xlsx-sheets.ts`): shared
// strings, cell references and boolean attributes.

import { findRelationship, readPartText, streamPart, type Relationships } from "./ooxml";
import { childElements, firstChild, textContent, type XmlElement } from "./xml";
import type { ZipArchive } from "./zip";

/** Whether an `xsd:boolean` attribute value is true. */
export function isTrue(value: string | undefined): boolean {
  return value === "1" || value === "true";
}

/** A string item's text: its runs joined, without the phonetic guide East Asian text may carry. */
export function stringItemText(item: XmlElement): string {
  let text = "";
  for (const child of childElements(item)) {
    const run = child.name === "s:t" ? child : child.name === "s:r" ? firstChild(child, "s:t") : undefined;
    if (run) text += textContent(run);
  }
  return text;
}

/** The workbook's shared strings, which cells of type `s` refer to by index. */
export async function readSharedStrings(zip: ZipArchive, relationships: Relationships): Promise<string[]> {
  const part = findRelationship(relationships, "sharedStrings")?.target;
  if (!part || !zip.has(part)) return [];
  const strings: string[] = [];
  for (const item of streamPart(await readPartText(zip, part), 1)) {
    if (item.name === "s:si") strings.push(stringItemText(item));
  }
  return strings;
}

/** The zero-based column of a cell reference such as `AB12`, or -1 if it has no column letters. */
export function columnIndex(reference: string): number {
  let column = 0;
  for (let index = 0; index < reference.length; index++) {
    const code = reference.charCodeAt(index) & ~0x20;
    if (code < 65 || code > 90) break;
    column = column * 26 + (code - 64);
  }
  return column - 1;
}
