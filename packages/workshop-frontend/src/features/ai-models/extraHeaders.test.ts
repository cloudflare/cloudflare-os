import { describe, expect, it } from 'vitest'
import { headerRowsToRecord, validateHeaderRows, type HeaderRow } from './extraHeaders'

const row = (id: number, name: string, value: string): HeaderRow => ({ id, name, value })

describe('validateHeaderRows', () => {
  it('accepts valid rows and ignores blank ones', () => {
    expect(validateHeaderRows([
      row(1, 'X-Api-Key', 'secret'),
      row(2, '  ', ''),
      row(3, 'cf-aig-authorization', ''),
    ])).toEqual({})
  })

  it('requires a name when a value is given', () => {
    expect(Object.keys(validateHeaderRows([row(1, ' ', 'orphan')]))).toEqual(['1'])
  })

  it('rejects names that are not HTTP tokens', () => {
    const errors = validateHeaderRows([row(1, 'Bad Header', 'x'), row(2, 'X-Colon:', 'x')])
    expect(Object.keys(errors)).toEqual(['1', '2'])
  })

  it('rejects names that differ only by case', () => {
    const errors = validateHeaderRows([row(1, 'X-Key', 'a'), row(2, 'x-key', 'b')])
    expect(Object.keys(errors)).toEqual(['2'])
  })
})

describe('headerRowsToRecord', () => {
  it('trims names and values and skips rows without a name', () => {
    expect(headerRowsToRecord([row(1, ' X-Key ', ' v '), row(2, '', '')])).toEqual({ 'X-Key': 'v' })
  })

  it('returns undefined when no headers remain', () => {
    expect(headerRowsToRecord([row(1, '', '')])).toBeUndefined()
  })
})
