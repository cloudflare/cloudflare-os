import { describe, expect, it } from 'vitest'
import { previewFormat } from './previewFormat'

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
const PPTX = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

describe('previewFormat', () => {
  it('draws the Open XML Office files in their own layout, by type or, untyped, by name', () => {
    expect(previewFormat({ name: 'brief', type: DOCX })).toBe('document')
    expect(previewFormat({ name: 'deck.pptx', type: 'application/octet-stream' })).toBe('slides')
    expect(previewFormat({ name: 'budget.xlsx', type: XLSX })).toBe('workbook')
    expect(previewFormat({ name: 'deck', type: PPTX })).toBe('slides')
  })

  it('leaves the older binary Office files to their icon, which nothing here can read', () => {
    expect(previewFormat({ name: 'old.doc', type: 'application/msword' })).toBeUndefined()
    expect(previewFormat({ name: 'old.ppt', type: 'application/vnd.ms-powerpoint' })).toBeUndefined()
    expect(previewFormat({ name: 'old.xls', type: 'application/vnd.ms-excel' })).toBeUndefined()
  })

  it('draws a CSV or TSV as a grid, even typed as plain text', () => {
    expect(previewFormat({ name: 'rows.csv', type: 'text/csv' })).toBe('delimited')
    expect(previewFormat({ name: 'rows.tsv', type: 'text/plain' })).toBe('delimited')
  })

  it('draws text, code and PDFs, and nothing for pictures, recordings or archives', () => {
    expect(previewFormat({ name: 'notes.md', type: 'text/markdown' })).toBe('text')
    expect(previewFormat({ name: 'worker.ts', type: '' })).toBe('text')
    expect(previewFormat({ name: 'report.pdf', type: 'application/pdf' })).toBe('pdf')
    expect(previewFormat({ name: 'photo.png', type: 'image/png' })).toBeUndefined()
    expect(previewFormat({ name: 'call.mp3', type: 'audio/mpeg' })).toBeUndefined()
    expect(previewFormat({ name: 'site.zip', type: 'application/zip' })).toBeUndefined()
  })
})
