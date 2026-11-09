export type AttachmentKind =
  | 'image'
  | 'pdf'
  | 'audio'
  | 'video'
  | 'spreadsheet'
  | 'document'
  | 'presentation'
  | 'archive'
  | 'code'
  | 'text'
  | 'file'

const EXTENSION_KINDS = new Map<string, AttachmentKind>([
  ['pdf', 'pdf'],
  ['csv', 'spreadsheet'], ['tsv', 'spreadsheet'], ['xls', 'spreadsheet'], ['xlsx', 'spreadsheet'],
  ['doc', 'document'], ['docx', 'document'], ['rtf', 'document'],
  ['ppt', 'presentation'], ['pptx', 'presentation'], ['key', 'presentation'],
  ['zip', 'archive'], ['gz', 'archive'], ['tar', 'archive'], ['tgz', 'archive'], ['7z', 'archive'],
  ['json', 'code'], ['js', 'code'], ['ts', 'code'], ['tsx', 'code'], ['jsx', 'code'],
  ['py', 'code'], ['rs', 'code'], ['go', 'code'], ['html', 'code'], ['css', 'code'],
  ['yaml', 'code'], ['yml', 'code'], ['xml', 'code'], ['sh', 'code'],
  ['txt', 'text'], ['md', 'text'], ['log', 'text'],
])

const MIME_KINDS: [prefix: string, kind: AttachmentKind][] = [
  ['application/pdf', 'pdf'],
  ['text/csv', 'spreadsheet'],
  ['application/vnd.ms-excel', 'spreadsheet'],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml', 'spreadsheet'],
  ['application/msword', 'document'],
  ['application/vnd.openxmlformats-officedocument.wordprocessingml', 'document'],
  ['application/vnd.ms-powerpoint', 'presentation'],
  ['application/vnd.openxmlformats-officedocument.presentationml', 'presentation'],
  ['application/zip', 'archive'], ['application/gzip', 'archive'], ['application/x-tar', 'archive'],
  ['application/json', 'code'], ['application/javascript', 'code'], ['application/xml', 'code'],
  ['text/html', 'code'], ['text/css', 'code'], ['text/javascript', 'code'], ['text/x-', 'code'],
  ['text/', 'text'], ['image/', 'image'], ['audio/', 'audio'], ['video/', 'video'],
]

/** MIME type wins; the extension covers files the browser reports as application/octet-stream. */
export const attachmentKind = (file: File): AttachmentKind => {
  const mime = file.type.toLowerCase()
  const byMime = MIME_KINDS.find(([prefix]) => mime.startsWith(prefix))
  if (byMime) return byMime[1]
  const dot = file.name.lastIndexOf('.')
  return dot < 0 ? 'file' : EXTENSION_KINDS.get(file.name.slice(dot + 1).toLowerCase()) ?? 'file'
}
