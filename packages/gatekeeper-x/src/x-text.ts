// Post text as X counts and bills it: the weighted length X enforces, and the links and mentions an
// approver should see called out. These follow twitter-text's v3 rules closely enough to refuse
// what X would refuse before it reaches the approval queue; X remains the authority at apply.

/** Standard accounts' limit, in weighted characters. */
export const TEXT_LIMIT = 280;
/** X Premium accounts' limit. */
export const TEXT_LIMIT_PREMIUM = 25_000;
/** What one link counts as, whatever its length: X wraps every link in t.co. */
export const URL_WEIGHT = 23;

/** Code point ranges twitter-text counts as one character; everything else counts as two. */
const SINGLE_WEIGHT_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x10ff], [0x2000, 0x200d], [0x2010, 0x201f], [0x2032, 0x2037],
];

/**
 * Links X detects: an explicit http(s) URL, or a bare domain under a common top-level domain.
 * Bare-domain detection is X's too, which is why "example.com" in a post counts and bills as a
 * link; the TLD list here is the common subset, not X's full one. A domain is held to DNS's
 * limits, 63 characters a label and 127 labels a name, which also bounds how far a failed match
 * backtracks: unbounded, a long run of dotted or hyphenated text made detection quadratic.
 */
const URL_PATTERN = new RegExp(
  String.raw`\bhttps?:\/\/[^\s<>"]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.){1,126}` +
  String.raw`(?:com|org|net|io|dev|ai|co|app|me|ly|gg|xyz|info|edu|gov|us|uk|de|fr|jp|ca|au|in|tv|so|sh|to|cc|link|site|blog|news|page)` +
  String.raw`\b(?:\/[^\s<>"]*)?`,
  "gi");

/** Punctuation that ends the sentence a link sits in rather than the link. */
const TRAILING_PUNCTUATION = new Set([".", ",", "!", "?", ";", ":", ")", "]"]);

/** A mention: an `@handle` not preceded by a word character or another `@`. */
const MENTION_PATTERN = /(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_@])/g;

const EMOJI = /\p{Extended_Pictographic}|\p{Regional_Indicator}/u;

let segmenter: Intl.Segmenter | undefined;

/** Splits text into user-perceived characters, so an emoji ZWJ sequence counts once. */
function graphemes(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: "grapheme" });
  return Array.from(segmenter.segment(text), part => part.segment);
}

function codePointWeight(codePoint: number): number {
  return SINGLE_WEIGHT_RANGES.some(([low, high]) => codePoint >= low && codePoint <= high) ? 1 : 2;
}

/** The links in `text`, as written. */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(URL_PATTERN)].map(match => {
    // A loop rather than /[.,!?;:)\]]+$/, which is quadratic in a long run of punctuation.
    let end = match[0].length;
    while (end > 0 && TRAILING_PUNCTUATION.has(match[0][end - 1])) end--;
    return match[0].slice(0, end);
  });
}

/** The handles `text` mentions, without the "@", deduplicated case-insensitively. */
export function extractMentions(text: string): string[] {
  const seen = new Map<string, string>();
  for (const match of text.matchAll(MENTION_PATTERN)) {
    const handle = match[1];
    if (!seen.has(handle.toLowerCase())) seen.set(handle.toLowerCase(), handle);
  }
  return [...seen.values()];
}

/**
 * The length X enforces: each link counts `URL_WEIGHT`, each emoji 2, CJK and most other scripts
 * 2 per code point, Latin and common punctuation 1. Text is NFC-normalized first, as X does.
 */
export function weightedLength(text: string): number {
  const normalized = text.normalize("NFC");
  let length = 0;
  let rest = normalized;
  for (const url of extractUrls(normalized)) {
    length += URL_WEIGHT;
    rest = rest.replace(url, " ");
    length -= 1;  // the space standing in for it is counted below
  }
  for (const grapheme of graphemes(rest)) {
    if (EMOJI.test(grapheme)) {
      length += 2;
      continue;
    }
    for (const char of grapheme) length += codePointWeight(char.codePointAt(0)!);
  }
  return length;
}

/**
 * Drops links and collapses whitespace, so a draft and the post X made of it compare equal although
 * X rewrote every link into t.co form.
 */
export function comparableText(text: string): string {
  return text.normalize("NFC")
    .replace(URL_PATTERN, "")
    .replace(/\s+/g, " ")
    .trim();
}
