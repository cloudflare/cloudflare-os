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
const FENCE = /^\s*(```|~~~)/;
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

/** Lines with a flag for whether each sits inside a fenced code block (fence lines count as inside). */
function classifyLines(text: string): { text: string; fenced: boolean }[] {
  let open = false;
  return text.split("\n").map(line => {
    if (FENCE.test(line)) {
      open = !open;
      return { text: line, fenced: true };
    }
    return { text: line, fenced: open };
  });
}

export function parseReview(raw: string): ParseResult {
  const lines = classifyLines(raw.replaceAll("\r\n", "\n"));
  if (lines.every(line => line.text.trim() === "")) return { ok: false, error: "the review is empty" };

  // Both markers are matched anywhere, fenced or not and in any case. A pull request that gets its
  // own text quoted back adds a second score (an error) or a NEEDS-A-PERSON (a person), never a pass.
  const scoreLines = lines.flatMap((line, index) => /merge-confidence/i.test(line.text) ? [index] : []);
  const needsPerson = lines.flatMap(({ text }) => {
    const at = text.search(/needs-a-person/i);
    if (at === -1) return [];
    const reason = text.slice(at + "NEEDS-A-PERSON".length).replace(/^[\s:*_`]+/, "").trim();
    return [reason === "" ? "unspecified" : reason];
  });

  const headings = lines.flatMap((line, index) =>
    !line.fenced && line.text.startsWith("## ") ? [{ index, name: line.text.slice(3).trim() }] : []);
  const findingsHeadings = headings.filter(heading => heading.name === "Findings");
  const summaryHeadings = headings.filter(heading => heading.name === "Summary");
  if (findingsHeadings.length !== 1 || summaryHeadings.length !== 1) {
    return { ok: false, error: "the review needs exactly one '## Findings' and one '## Summary' heading" };
  }
  const findingsStart = findingsHeadings[0].index;
  const summaryStart = summaryHeadings[0].index;
  if (summaryStart < findingsStart) return { ok: false, error: "'## Summary' comes before '## Findings'" };
  const findingsEnd = headings.find(heading => heading.index > findingsStart)?.index ?? lines.length;

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
    if (!fenced && text.startsWith("### ")) {
      current = { ...titleSeverity(text.slice(4).trim()), path: null, line: null };
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

  // Any other line that opens with a tag is still a finding, whatever markdown wraps it: a deeper
  // heading inside an entry, a bold or bulleted line, or a heading outside the findings section.
  for (const [index, { text, fenced }] of lines.entries()) {
    const counted = index > findingsStart && index < findingsEnd && text.startsWith("### ");
    if (fenced || counted) continue;
    if (!LINE_TAG.test(text)) continue;
    const tags = [...text.matchAll(TAG)].map(match => match[1]).filter(isSeverity);
    findings.push({ severity: mostSevere(tags), title: text.replace(LINE_MARKUP, "").trim(), path: null, line: null });
  }

  return { ok: true, review: { findings, needsPerson, mergeConfidence: Number(score[1]) } };
}
