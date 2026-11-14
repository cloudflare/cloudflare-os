// An SVG is a document that can run script and load from elsewhere, but given to the browser as an
// image (`<img>`) it does neither. What is left is it being opened in a tab of its own, where it
// is a page: from a `blob:` URL, which is of the app's origin, it would run as the app. From a
// `data:` URL it has no origin, so it can do no more there than any page on the web.

/** What an SVG is typed as, wherever it is given to the browser. */
export const SVG_TYPE = 'image/svg+xml'

/** Whether a file is an SVG, by what it says it is or else by its name. */
export const isSvgImage = ({ name, type }: { name: string; type: string }) => {
  const essence = type.split(';')[0].trim().toLowerCase()
  return essence === SVG_TYPE || (!essence.startsWith('image/') && /\.svg$/i.test(name))
}

/** Whether `text` is drawn as an SVG, as far as can be told without parsing it. */
export const looksLikeSvg = (text: string) => /<svg[\s>]/i.test(text)

// Through `btoa` a piece at a time, as spreading all of a large file into one call overflows the stack.
const CHUNK = 0x8000

/** An address an SVG's bytes are shown from as an image, of no origin. Only ever for an `<img>`. */
export const svgDataUrl = (bytes: Uint8Array) => {
  let binary = ''
  for (let at = 0; at < bytes.length; at += CHUNK) binary += String.fromCharCode(...bytes.subarray(at, at + CHUNK))
  return `data:${SVG_TYPE};base64,${btoa(binary)}`
}
