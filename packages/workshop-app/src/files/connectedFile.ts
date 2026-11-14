/**
 * A file that lives with a connected service rather than in a chat, such as a Google Doc: what it
 * is, from the provider's media type for it or the address it opens at.
 */
export type ConnectedFileKind = 'document' | 'spreadsheet' | 'presentation'

const MEDIA_KINDS: Record<string, ConnectedFileKind> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheet',
  'application/vnd.google-apps.presentation': 'presentation',
}

/** What a file of the provider's media type `mediaType` is, when it is one drawn as itself. */
export const connectedFileKind = (mediaType: string | undefined): ConnectedFileKind | undefined =>
  mediaType === undefined ? undefined : MEDIA_KINDS[mediaType]

/** What a file is from the address its editor opens at, when that says. */
export const connectedKindOfUrl = (url: string): ConnectedFileKind | undefined => {
  if (/^https:\/\/docs\.google\.com\/document\//.test(url)) return 'document'
  if (/^https:\/\/docs\.google\.com\/spreadsheets\//.test(url)) return 'spreadsheet'
  if (/^https:\/\/docs\.google\.com\/presentation\//.test(url)) return 'presentation'
  return undefined
}

/** The provider's id for a file, from its editor's address: `/document/d/<id>/edit` and the like. */
export const connectedFileIdOfUrl = (url: string): string | undefined => /\/d\/([^/?#]+)/.exec(url)?.[1]

/** What the way to its own editor says. */
export const OPEN_IN: Record<ConnectedFileKind, string> = {
  document: 'Open in Docs',
  spreadsheet: 'Open in Sheets',
  presentation: 'Open in Slides',
}
