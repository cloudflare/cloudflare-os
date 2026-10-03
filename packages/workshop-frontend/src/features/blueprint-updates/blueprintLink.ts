const BLUEPRINT_PATH = /^\/blueprint\/([^/]+)\/?$/

/**
 * The id of the blueprint that a pasted share link names: a URL whose path is `/blueprint/<id>`,
 * as a blueprint's "Copy link" produces. Null for anything else.
 *
 * The link's origin is not compared with this deployment's, which answers to more than one
 * (a custom domain, a preview host). A link to another deployment names a blueprint this one
 * does not have, and looking it up says so.
 */
export const parseBlueprintLink = (text: string): string | null => {
  let url: URL
  try {
    url = new URL(text.trim())
  } catch {
    return null
  }
  const encodedId = BLUEPRINT_PATH.exec(url.pathname)?.[1]
  if (encodedId === undefined) return null
  try {
    return decodeURIComponent(encodedId)
  } catch {
    return null
  }
}
