import { normalizePageLocation } from '@gadgets/error-reporting'

// A stack frame's location ends its line as ":line:column", in brackets or not. Only a line's
// last few characters are read for it.
const STACK_POSITION = /:\d+:\d+\)?[ \t]*$/
const POSITION_TAIL = 40
// A data: URL's header, read at a "data:" that is not a stack frame's location: a media type, or
// none ("data:," and "data:;base64,"), then a parameter or the content. Each read stops at the
// first character no header has.
const DATA_HEADER = /data:(?:[\w.+-]*\/[\w.+-]*)?[;,]/y
// A line of a Chromium stack: a frame, indented, after "at ".
const CHROME_FRAME = /^\s+at /
// An http(s) URL, to the next space, quote or angle bracket: a stack frame's location (a script's
// own URL, or one a sourceURL annotation gave it) or one a message quotes, as a Worker's
// SecurityError does its script's. Its query or fragment can hold a credential.
const HTTP_URL = /https?:\/\/[^\s'"<>]*/gi
// What ends such a URL without being part of it: a frame's ":line:column", and the punctuation
// that closes a clause or a bracket. Read from its last few characters.
const HTTP_URL_TAIL = /(?::\d+:\d+)?[)\]:,.;]*$/
// The browser's own message for a failed dynamic import, at the start of an error's line, with
// the labels the frame's listeners put before it: what follows is the module's URL, the error's
// one location, since it has no stack to name it in. Only at the start, so that a module whose
// source holds the words (in a comment, say), quoted in a stack frame, is not read as one.
// The browser's message for an import of a name a module does not export, which quotes the
// module's URL before the reason and the name. The URL may hold newlines, and the module's own
// source, inside it, the words too: the last reason in the rest of the text ends it, and in a
// clipped text none does, since the browser's own may be the part cut off.
// Only at the start of an error's line, after the frame's labels, so that a stack frame whose
// module's source holds the words still goes through the data: URL path.
const MISSING_EXPORT_START =
  /^(?:(?:Uncaught|Unhandled promise rejection:) )*(?:SyntaxError: )?The requested module '/
// Chromium's wording, then Firefox's.
const MISSING_EXPORT_REASONS = ["' does not provide an export named", "' doesn't provide an export named"]
const IMPORT_FAILURE = new RegExp(
  '^(?:(?:Uncaught|Unhandled promise rejection:) )?(?:TypeError: )?' +
  '(?:Failed to fetch|error loading) dynamically imported module: ')

// A module's URL as a browser diagnostic names it: the bundle's file, a data: URL elided whole,
// or another URL cut to its origin and path.
const moduleShown = (url: string, paths: ReadonlyMap<string, string>): string =>
  paths.get(url) ?? (url.startsWith('data:') ? 'data:…' : normalizePageLocation(url) ?? '…')

/**
 * `text` with each data: URL in it named by the file `paths` maps it to, or elided as "data:…",
 * and the module a failed dynamic import or a missing export names (its only location) cut to
 * the bundle's file, or to an http(s) URL's origin and path, which is all an error log keeps of a
 * location: a module's data: URL holds its whole source, which an error log has no need of.
 * `paths` names each of the bundle's files by its data: URL and by its import map specifier,
 * which Chromium names an imported module by. A data: URL is one in a stack frame's location
 * (after "(" or "at ", or Firefox's "@"), whatever its header holds, or one whose header reads
 * as a media type elsewhere; prose such as "bad data: expected a number" is none.
 * It runs to the ":line:column" that ends its line, which is kept, or to the end of the line: a
 * module's URL can hold brackets, quotes, colons and spaces, so nothing short of that ends it.
 * One that is not the bundle's and is not ended on its line can hold newlines too, so the rest
 * of the text is taken as part of it. Each http(s) URL before a line's data: URL, a stack frame's
 * location or one a message quotes, is cut to its origin and path: it runs to the next space,
 * quote or angle bracket, less a frame's ":line:column" and closing punctuation, which are kept.
 *
 * `clipped` says `text` was cut from a longer string, so its last line may end anywhere.
 *
 * Each line is read once, so text a frame chose costs time in proportion to its length.
 */
export function withoutDataUrls(
  text: string,
  paths: ReadonlyMap<string, string>,
  clipped = false,
): string {
  const lines = text.split('\n')
  const kept: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    // A failed import names its module after IMPORT_FAILURE, to the end of the line, or of the
    // text for a data: URL the bundle does not name.
    const named = IMPORT_FAILURE.exec(line)
    if (named) {
      const start = named[0].length
      const url = line.slice(start).trim()
      kept.push(`${line.slice(0, start)}${moduleShown(url, paths)}`)
      if (url.startsWith('data:') && !paths.has(url)) break
      continue
    }
    const quoted = MISSING_EXPORT_START.exec(line)
    if (quoted) {
      const start = quoted[0].length
      const rest = lines.slice(index).join('\n')
      const reason = clipped ? -1 : Math.max(...MISSING_EXPORT_REASONS.map(words => rest.lastIndexOf(words)))
      // Cut short, or with no reason in what follows, the rest of the text is the URL.
      if (reason <= start) {
        kept.push(`${line.slice(0, start)}${moduleShown(rest.slice(start), paths)}`)
        break
      }
      // What follows the reason is read as any other text.
      const after = withoutDataUrls(rest.slice(reason), paths, clipped)
      kept.push(`${line.slice(0, start)}${moduleShown(rest.slice(start, reason), paths)}${after}`)
      break
    }
    const located = withoutLineDataUrl(line, paths)
    kept.push(located.line)
    if (located.unended) break
  }
  return kept.join('\n')
}

// `line` with its first data: URL named or elided, and whether that URL, one the bundle does not
// name and no stack position ends, may run on past the line; and each http(s) URL before it cut to
// its origin and path.
function withoutLineDataUrl(line: string, paths: ReadonlyMap<string, string>)
    : { line: string, unended: boolean } {
  const firstSpace = line.search(/\s/)
  const chromeFrame = CHROME_FRAME.test(line)
  for (let from = 0; ;) {
    const at = line.indexOf('data:', from)
    if (at < 0) return { line: withoutHttpQueries(line), unended: false }
    DATA_HEADER.lastIndex = at
    // Chrome writes a frame's location after "(" or "at " on a line that starts "at ", Firefox
    // after the "@" that follows a function's name. A message's own "(data: ..." is no frame's.
    const isLocation = chromeFrame
      ? line.endsWith('(', at) || line.endsWith('at ', at)
      : line.endsWith('@', at) && !(firstSpace >= 0 && firstSpace < at)
    if (isLocation || DATA_HEADER.test(line)) {
      const end = positionStart(line, at)
      const url = line.slice(at, end)
      const path = paths.get(url)
      return {
        line: `${withoutHttpQueries(line.slice(0, at))}${path ?? 'data:…'}${line.slice(end)}`,
        unended: end === line.length && path === undefined,
      }
    }
    from = at + 'data:'.length
  }
}

// `text` with each http(s) URL cut to its origin and path, what ends it (HTTP_URL_TAIL) kept.
function withoutHttpQueries(text: string): string {
  return text.replace(HTTP_URL, url => {
    const tailStart = Math.max(0, url.length - POSITION_TAIL)
    const tail = HTTP_URL_TAIL.exec(url.slice(tailStart))!
    // An IPv6 host's closing bracket is the URL's own.
    const close = /^https?:\/\/\[/i.test(url) ? url.indexOf(']') : -1
    const cut = Math.max(tailStart + tail.index, close + 1)
    return `${normalizePageLocation(url.slice(0, cut)) ?? '…'}${url.slice(cut)}`
  })
}

// Where the ":line:column" that ends `line` starts, if it has one after `from`, or else its end.
function positionStart(line: string, from: number): number {
  const tailStart = Math.max(from, line.length - POSITION_TAIL)
  const position = STACK_POSITION.exec(line.slice(tailStart))
  return position ? tailStart + position.index : line.length
}
