/** A character that separates a delimited file's cells. */
export type Delimiter = "," | "\t" | ";";

/**
 * The delimiter a file uses, judged by its first line: the candidate that appears most outside
 * quotes. A ".csv" is often semicolon-separated where the comma is the decimal mark, and
 * sometimes tab-separated. Comma when the line has none of them.
 */
export const sniffDelimiter = (text: string): Delimiter => {
  const counts: Record<Delimiter, number> = { ",": 0, "\t": 0, ";": 0 };
  let quoted = false;
  for (let index = 0; index < text.length && index < 16_384; index++) {
    const char = text[index]!;
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === "\n" || char === "\r")) break;
    else if (!quoted && (char === "," || char === "\t" || char === ";")) counts[char]++;
  }
  if (counts[";"] > counts[","] && counts[";"] >= counts["\t"]) return ";";
  return counts["\t"] > counts[","] ? "\t" : ",";
};

/**
 * Parses CSV or TSV text into rows of cells, following RFC 4180: a quoted cell may hold the
 * delimiter, line breaks, and a doubled quote for a literal one. Parsing stops after `maxRows`
 * rows, so a large file costs no more than what is shown; `truncated` says more followed.
 */
export const parseDelimited = (
  text: string,
  delimiter: Delimiter,
  maxRows: number,
): { rows: string[][]; truncated: boolean } => {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let index = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  for (; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char !== '"') cell += char;
      else if (text[index + 1] === '"') { cell += '"'; index++; }
      else quoted = false;
    } else if (char === '"' && cell === "") {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      if (rows.length === maxRows) {
        return { rows, truncated: /\S/.test(text.slice(index + 1)) };
      }
    } else {
      cell += char;
    }
  }
  // A final line without a line break; a trailing break leaves nothing to add.
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return { rows, truncated: false };
};
