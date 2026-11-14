import { attachmentKind } from './attachmentKind'

/**
 * How a file's content can be drawn, beyond what the browser draws by itself: an Office file's
 * own layout (Word, PowerPoint and Excel, the Open XML formats only), a CSV or TSV as a grid, the
 * start of any text, a PDF's first page. Nothing for a file only its kind's icon can stand for.
 */
export type PreviewFormat = 'document' | 'slides' | 'workbook' | 'delimited' | 'text' | 'pdf'

const extensionOf = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot < 0 ? '' : name.slice(dot + 1).toLowerCase()
}

/** The format a file is drawn in, from its name and type, which choose its previewer. */
export const previewFormat = (file: { name: string; type: string }): PreviewFormat | undefined => {
  const mime = file.type.toLowerCase()
  const extension = extensionOf(file.name)
  // Before the kind, which goes by type first: browsers type a TSV as plain text.
  if (mime === 'text/csv' || mime === 'text/tab-separated-values' || extension === 'csv' || extension === 'tsv') return 'delimited'
  switch (attachmentKind(file)) {
    case 'document':
      return mime.includes('wordprocessingml') || extension === 'docx' ? 'document' : undefined
    case 'presentation':
      return mime.includes('presentationml') || extension === 'pptx' ? 'slides' : undefined
    case 'spreadsheet':
      return mime.includes('spreadsheetml') || extension === 'xlsx' ? 'workbook' : undefined
    case 'pdf':
      return 'pdf'
    case 'text':
    case 'code':
      return 'text'
    default:
      return undefined
  }
}
