const BLUEPRINT_PATH = /^\/blueprint\/([^/]+)\/?$/

// Published ids are random hex and bundled ones are names such as `format.document`. A leading
// dot is refused because the blueprint namespace's reserved keys (`.featured`, ...) start with one.
const BARE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The id of the blueprint that pasted text names: either the id itself, or a URL whose path is
 * `/blueprint/<id>`, as a blueprint's "Copy link" produces. Null for anything else.
 *
 * A link's origin is not compared with this deployment's, which answers to more than one
 * (a custom domain, a preview host). A link to another deployment names a blueprint this one
 * does not have, and looking it up says so.
 */
export const parseBlueprintReference = (text: string): string | null => {
  const trimmed = text.trim()
  if (BARE_ID.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const encodedId = BLUEPRINT_PATH.exec(url.pathname)?.[1]
  if (encodedId === undefined) return null
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return null
  }
}
