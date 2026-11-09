import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'

/**
 * `preview` of a file not created yet, drawn as the new file it will be rather than as changes:
 * every part of it is new, so nothing is marked, and nothing a later change rewrote is singled
 * out, since the person decides it whole.
 */
export function newFilePreview(preview: ResourcePreview): ResourcePreview {
  const { content } = preview
  const base = { title: preview.title, ...(preview.url ? { url: preview.url } : {}), actions: [] }
  switch (content.type) {
    case 'document':
      return { ...base, content: { ...content, tabs: content.tabs.map(tab => ({ ...tab, edits: [] })) } }
    case 'spreadsheet':
      return {
        ...base,
        content: {
          ...content,
          sheets: content.sheets.filter(sheet => sheet.status !== 'removed')
            .map(({ status: _status, ...sheet }) => sheet),
          areas: content.areas.map(({ insertedRows: _r, insertedColumns: _c, deletedRows: _dr, deletedColumns: _dc, ...area }) => ({
            ...area,
            cells: area.cells.map(row => row.map(cell => {
              if (!cell) return cell
              const { change: _change, previous: _previous, ...rest } = cell
              return Object.keys(rest).length > 0 ? rest : null
            })),
          })),
        },
      }
    case 'presentation':
      return {
        ...base,
        content: {
          ...content,
          slides: content.slides.filter(slide => slide.status !== 'removed').map(({ status: _status, ...slide }) => ({
            ...slide,
            changes: [],
            elements: slide.elements.map(({ change: _change, ...element }) => element),
          })),
        },
      }
  }
}
