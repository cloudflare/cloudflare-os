const WEB = ['http:', 'https:']

/**
 * `url` when it is an address on the web (http or https, or one of `schemes` instead), and nothing
 * otherwise. What is linked can come from anyone, so this is what keeps a `javascript:` URL, which
 * would run as the app when clicked, from ever being an `href`.
 */
export const webUrl = (url: string | undefined, schemes: readonly string[] = WEB): string | undefined => {
  try {
    return url && schemes.includes(new URL(url).protocol) ? url : undefined
  } catch {
    return undefined
  }
}

const LINKED = [...WEB, 'mailto:']
// What an image may be shown from: a picture carried in the text, or bytes the app already has.
// Anything else would be fetched, which tells whoever is at the other end what is being read and
// when, so it is linked instead (`Markdown`).
const SHOWN = /^(data:image\/|blob:)/i

/** Whether an image's source fetches nothing, so it can be shown rather than linked. */
export const isShownImage = (src: string) => SHOWN.test(src)

/**
 * What Markdown may use of a URL in it, for `react-markdown`'s `urlTransform`: a web or mail
 * address, and for an image's source also one that fetches nothing. Nothing, for the rest, which
 * drops it.
 */
export const markdownUrl = (url: string, key: string): string | undefined =>
  key === 'src' && isShownImage(url) ? url : webUrl(url, LINKED)
