import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'

// Google's default slide, 10in × 5.625in in points.
const SLIDE = { width: 720, height: 405 }
const BLANK_ROWS = 60
const BLANK_COLUMNS = 26

/**
 * A blank file of `kind`, drawn by the same renderer that will draw the file once it loads, so
 * the page, grid or slide is already where the file will appear and nothing moves when it does.
 */
export function loadingPreview(kind: 'document' | 'spreadsheet' | 'presentation'): ResourcePreview {
  const content: ResourcePreview['content'] =
    kind === 'document' ? { type: 'document', tabs: [{ id: '', title: '', markdown: '', edits: [] }] }
    : kind === 'spreadsheet' ? {
      type: 'spreadsheet',
      sheets: [{ id: 0, title: '' }],
      areas: [{ sheetId: 0, row: 0, column: 0, cells: Array.from({ length: BLANK_ROWS }, () => Array<null>(BLANK_COLUMNS).fill(null)) }],
    }
    : { type: 'presentation', ...SLIDE, slides: [{ id: '', changes: [], elements: [] }] }
  return { title: '', actions: [], content }
}
