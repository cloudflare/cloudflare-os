// Turns a reviewer's text into findings, NEEDS-A-PERSON reasons and a MERGE-CONFIDENCE score, in
// the shape REVIEW.md and the prompt in verdict.ts ask for. The text is model output that read the
// pull request, so a pull request can steer what it says: every ambiguity resolves toward a person
// (a finding with no tag is P1, a stray NEEDS-A-PERSON counts, a second or malformed score is an
// error).

/** A REVIEW.md severity. P0 and P1 block an automatic merge. */
export type Severity = "P0" | "P1" | "P2" | "P3";

/** One finding, as the producer contract carries it. */
export interface Finding {
  severity: Severity;
  title: string;
  /** From the `path:line` line under the title; null when the reviewer gave none. */
  path: string | null;
  line: number | null;
}

/** A review that followed the format. */
export interface ParsedReview {
  findings: Finding[];
  needsPerson: string[];
  mergeConfidence: number;
}

export type ParseResult = { ok: true; review: ParsedReview } | { ok: false; error: string };

const SEVERITIES: readonly Severity[] = ["P0", "P1", "P2", "P3"];
const TAG = /\[(P[0-3])\]/g;
const LEADING_TAG = /^\[(P[0-3])\]\s+(.+)$/;
const LOCATION = /^`?([^\s`:]+):(\d+)(?:-\d+)?`?$/;
const SCORE = /^MERGE-CONFIDENCE: (10|[0-9])$/;
/** A fence opener, ignoring indentation. A backtick fence's info string has no backtick. */
const FENCE_OPENER = /^(`{3,})[^`]*$|^(~{3,})/;
const HEADING = /^ {0,3}(#{1,6})(?:\s|$)/;
/** Headings markdown renders that the parser does not read: HTML, setext, quoted or listed ones. */
const HTML_HEADING = /^\s*<h[1-6][\s>]/i;
const SETEXT_UNDERLINE = /^ {0,3}(=+|-+)[ \t]*$/;
const CONTAINED_HEADING = /^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)+#{1,6}(?:\s|$)/;
/** Markdown that can open a line before a tag: headings, emphasis, quotes, bullets, numbering. */
const LINE_MARKUP = /^[\s#*_>+\-\d.)]*/;
const LINE_TAG = /^[\s#*_>+\-\d.)]*\[P[0-3]\]/;

function isSeverity(value: string): value is Severity {
  return SEVERITIES.some(severity => severity === value);
}

function mostSevere(severities: Severity[]): Severity {
  return severities.reduce((worst, next) => (next < worst ? next : worst));
}

/**
 * A finding's severity from its title. Exactly one leading tag and no other tag is that tag.
 * Anything else counts as untagged, so P1, unless a tag anywhere in the title is more severe.
 */
function titleSeverity(title: string): { severity: Severity; title: string } {
  const tags = [...title.matchAll(TAG)].map(match => match[1]).filter(isSeverity);
  const leading = LEADING_TAG.exec(title);
  if (leading && tags.length === 1 && isSeverity(leading[1])) {
    return { severity: leading[1], title: leading[2].trim() };
  }
  return { severity: mostSevere(["P1", ...tags]), title };
}

interface Line {
  text: string;
  /** Inside a fenced code block; fence lines count as inside. */
  fenced: boolean;
}

/**
 * Lines with their fence state, following CommonMark: a fence closes only on the same character
 * repeated at least as often, indented at most three spaces. A fence-like line that is neither an
 * opener nor a closer, or a fence left open, is an error: renderers disagree on those, and a
 * disagreement would let a rendered finding read as code here.
 */
function classifyLines(text: string): { lines: Line[] } | { error: string } {
  let open: string | null = null;
  const lines: Line[] = [];
  for (const line of text.split("\n")) {
    if (open !== null) {
      const closer = new RegExp(`^ {0,3}${open[0] === "`" ? "`" : "~"}{${open.length},}[ \\t]*$`);
      if (closer.test(line)) open = null;
      lines.push({ text: line, fenced: true });
      continue;
    }
    const indent = /^\s*/.exec(line)?.[0] ?? "";
    const opener = FENCE_OPENER.exec(line.slice(indent.length));
    if (opener) {
      // Indented four spaces or a tab, renderers read it as code or as a list item's fence.
      if (!/^ {0,3}$/.test(indent)) return { error: `ambiguous code fence ${JSON.stringify(line.trim())}` };
      open = opener[1] ?? opener[2];
      lines.push({ text: line, fenced: true });
      continue;
    }
    lines.push({ text: line, fenced: false });
  }
  if (open !== null) return { error: "a code fence is never closed" };
  return { lines };
}

export function parseReview(raw: string): ParseResult {
  const classified = classifyLines(raw.replaceAll("\r\n", "\n"));
  if ("error" in classified) return { ok: false, error: classified.error };
  const { lines } = classified;
  if (lines.every(line => line.text.trim() === "")) return { ok: false, error: "the review is empty" };
  const unsupported = lines.find((line, index) => {
    if (line.fenced) return false;
    const previous = index > 0 ? lines[index - 1] : undefined;
    const underlines = previous !== undefined && !previous.fenced && previous.text.trim() !== "" &&
      !HEADING.test(previous.text) && SETEXT_UNDERLINE.test(line.text);
    return underlines || HTML_HEADING.test(line.text) || CONTAINED_HEADING.test(line.text);
  });
  if (unsupported) return { ok: false, error: `unsupported heading form near ${JSON.stringify(unsupported.text.trim())}` };

  // Both markers are matched anywhere, fenced or not and in any case. A pull request that gets its
  // own text quoted back adds a second score (an error) or a NEEDS-A-PERSON (a person), never a pass.
  const scoreLines = lines.flatMap((line, index) => /merge-confidence/i.test(line.text) ? [index] : []);
  const needsPerson = lines.flatMap(({ text }) => {
    const at = text.search(/needs-a-person/i);
    if (at === -1) return [];
    const reason = text.slice(at + "NEEDS-A-PERSON".length).replace(/^[\s:*_`]+/, "").trim();
    return [reason === "" ? "unspecified" : reason];
  });

  // Any heading markdown renders counts, so a section cannot hide behind indentation or a
  // non-breaking space. Only the two known sections may exist, and an untagged entry heading outside
  // the findings section is an error: either could carry a finding the loop below never reads.
  const headings = lines.flatMap((line, index) => {
    const heading = HEADING.exec(line.text);
    return !line.fenced && heading ? [{ index, level: heading[1].length, name: line.text.slice(heading[0].length).trim() }] : [];
  });
  const sections = headings.filter(heading => heading.level <= 2);
  const unknown = sections.find(heading => heading.level !== 2 || (heading.name !== "Findings" && heading.name !== "Summary"));
  if (unknown) return { ok: false, error: `unknown section ${JSON.stringify(lines[unknown.index].text.trim())}` };
  const findingsHeadings = sections.filter(heading => heading.name === "Findings");
  const summaryHeadings = sections.filter(heading => heading.name === "Summary");
  if (findingsHeadings.length !== 1 || summaryHeadings.length !== 1) {
    return { ok: false, error: "the review needs exactly one '## Findings' and one '## Summary' heading" };
  }
  const findingsStart = findingsHeadings[0].index;
  const summaryStart = summaryHeadings[0].index;
  if (summaryStart < findingsStart) return { ok: false, error: "'## Summary' comes before '## Findings'" };
  const findingsEnd = summaryStart;
  const stray = headings.find(heading => heading.level >= 3 && (heading.index < findingsStart || heading.index > findingsEnd) &&
    !LINE_TAG.test(lines[heading.index].text));
  if (stray) return { ok: false, error: `untagged heading outside '## Findings': ${JSON.stringify(lines[stray.index].text.trim())}` };

  if (scoreLines.length !== 1) {
    return { ok: false, error: `the review has ${scoreLines.length} MERGE-CONFIDENCE lines; it needs exactly one` };
  }
  const scoreIndex = scoreLines[0];
  const score = SCORE.exec(lines[scoreIndex].text.trim());
  if (!score || lines[scoreIndex].fenced) {
    return { ok: false, error: `malformed MERGE-CONFIDENCE line: ${JSON.stringify(lines[scoreIndex].text.trim())}` };
  }
  if (scoreIndex < summaryStart) return { ok: false, error: "MERGE-CONFIDENCE is not in the summary" };

  const findings: Finding[] = [];
  let current: Finding | undefined;
  let awaitingLocation = false;
  for (let index = findingsStart + 1; index < findingsEnd; index++) {
    const { text, fenced } = lines[index];
    const heading = fenced ? null : HEADING.exec(text);
    // Every heading here opens an entry, a deeper one too: an untagged subheading counts as P1
    // rather than letting a finding pass as body text.
    if (heading) {
      current = { ...titleSeverity(text.slice(heading[0].length).trim()), path: null, line: null };
      findings.push(current);
      awaitingLocation = true;
      continue;
    }
    if (text.trim() === "") continue;
    if (!current) {
      // Prose before the first entry could be a finding written in another shape and missed.
      if (text.trim() === "None.") continue;
      return { ok: false, error: "the findings section has text outside a '###' finding" };
    }
    if (awaitingLocation) {
      const location = LOCATION.exec(text.trim());
      if (location) {
        current.path = location[1];
        current.line = Number(location[2]);
      }
      awaitingLocation = false;
    }
  }

  // Any other line that opens with a tag is still a finding, whatever markdown wraps it: a bold or
  // bulleted line, or a heading outside the findings section.
  for (const [index, { text, fenced }] of lines.entries()) {
    const counted = index > findingsStart && index < findingsEnd && HEADING.test(text);
    if (fenced || counted) continue;
    if (!LINE_TAG.test(text)) continue;
    const tags = [...text.matchAll(TAG)].map(match => match[1]).filter(isSeverity);
    findings.push({ severity: mostSevere(tags), title: text.replace(LINE_MARKUP, "").trim(), path: null, line: null });
  }

  return { ok: true, review: { findings, needsPerson, mergeConfidence: Number(score[1]) } };
}
