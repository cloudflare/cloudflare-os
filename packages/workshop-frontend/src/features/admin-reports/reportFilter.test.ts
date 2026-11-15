import { describe, expect, it } from 'vitest'
import { ISSUE_REPORT_PRIORITIES, ISSUE_REPORT_STATUSES } from '@gadgets/workshop-shared/api'
import { isFiltered, reportSearchOf } from './reportFilter'

describe('reportSearchOf', () => {
  it('keeps every filter and the open report', () => {
    const search = {
      tab: 'reports', status: 'withAdmin', priority: 'high', reporter: 'rita', workspace: 'ws-1', report: 'r-1',
    }
    const { tab: _tab, ...kept } = search

    expect(reportSearchOf(search)).toEqual(kept)
  })

  it.each(ISSUE_REPORT_STATUSES)('keeps the status %s', (status) => {
    expect(reportSearchOf({ status })).toEqual({ status })
  })

  it.each(ISSUE_REPORT_PRIORITIES)('keeps the priority %s', (priority) => {
    expect(reportSearchOf({ priority })).toEqual({ priority })
  })

  it('leaves out a status or a priority that is not one', () => {
    expect(reportSearchOf({ status: 'open', priority: 'urgent' })).toEqual({})
    expect(reportSearchOf({ status: ['new'], priority: 1 })).toEqual({})
  })

  it('leaves out an empty or malformed reporter, workspace or report', () => {
    expect(reportSearchOf({ reporter: '', workspace: '', report: '' })).toEqual({})
    expect(reportSearchOf({ reporter: ['rita'], workspace: { id: 'ws-1' }, report: true })).toEqual({})
  })

  // The router parses a search value as JSON where it can.
  it('keeps an id made of digits, which the router read as a number', () => {
    expect(reportSearchOf({ reporter: 42, workspace: 7, report: 2026 }))
      .toEqual({ reporter: '42', workspace: '7', report: '2026' })
  })

  it('leaves out a parameter that belongs to another tab', () => {
    expect(reportSearchOf({ tab: 'reports', admin: 'ada', kind: 'write', exposed: 'content' })).toEqual({})
  })
})

describe('isFiltered', () => {
  it('is false for no filter', () => {
    expect(isFiltered({})).toBe(false)
  })

  it.each([
    { status: 'new' }, { priority: 'low' }, { reporter: 'rita' }, { workspace: 'ws-1' },
  ] as const)('is true for %o', (filter) => {
    expect(isFiltered(filter)).toBe(true)
  })

  // The open report is not a filter of the list.
  it('does not count the open report', () => {
    expect(isFiltered(reportSearchOf({ report: 'r-1' }))).toBe(false)
  })
})
