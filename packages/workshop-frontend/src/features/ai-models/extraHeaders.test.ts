import { describe, expect, it } from 'vitest'
import {
  canKeepStoredValue, headerRowsFromRecord, headerRowsToRecord, validateHeaderRows, type HeaderRow,
} from './extraHeaders'

const row = (id: number, name: string, value: string | null): HeaderRow => ({ id, name, value })

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

  it('passes withheld values through as null', () => {
    expect(headerRowsToRecord([row(1, 'X-Key', null)])).toEqual({ 'X-Key': null })
  })
})

describe('stored header rows', () => {
  it('may keep a withheld value only under the name it was stored with', () => {
    const [stored, plain] = headerRowsFromRecord({ 'X-Key': null, 'X-Plain': 'v' })
    expect(canKeepStoredValue(stored)).toBe(true)
    expect(canKeepStoredValue({ ...stored, name: 'x-key' })).toBe(false)
    expect(canKeepStoredValue(plain)).toBe(false)
    expect(headerRowsToRecord([stored, plain])).toEqual({ 'X-Key': null, 'X-Plain': 'v' })
  })
})
