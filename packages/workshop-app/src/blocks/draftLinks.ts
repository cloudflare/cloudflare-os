// A link, up to whatever usually ends one in prose.
const LINK = /https:\/\/[^\s<>()[\]"']+[^\s<>()[\]"'.,;:!?]/g

/** `text` as its words and the links among them, in the order they come: what a sent message draws each link as a pill for. */
export const splitLinks = (text: string): ({ text: string } | { url: string })[] => {
  const pieces: ({ text: string } | { url: string })[] = []
  let at = 0
  for (const { 0: url, index } of text.matchAll(LINK)) {
    if (index > at) pieces.push({ text: text.slice(at, index) })
    pieces.push({ url })
    at = index + url.length
  }
  if (at < text.length) pieces.push({ text: text.slice(at) })
  return pieces
}

/** The links in `text`, each once, in the order they come: those pasted into a draft together. */
export const linksIn = (text: string): string[] => [...new Set(text.match(LINK) ?? [])]

/**
 * The link just finished in a draft: the one that ends where the space or new line before `caret`
 * was typed, which is when a link written out by hand is done. Nothing while it is still being
 * typed, or where what ends there is not a link.
 */
export const linkEndedAt = (text: string, caret: number): string | undefined => {
  if (caret < 1 || !/\s/.test(text[caret - 1])) return undefined
  const before = text.slice(0, caret - 1)
  const start = before.search(/https:\/\/\S*$/)
  return start < 0 ? undefined : linksIn(before.slice(start))[0]
}
