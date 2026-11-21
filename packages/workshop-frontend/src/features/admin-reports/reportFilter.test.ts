import { describe, expect, it } from 'vitest'
import { ISSUE_REPORT_PRIORITIES, ISSUE_REPORT_STATUSES } from '@gadgets/workshop-shared/api'
import { isFiltered, matchesChangingFilters, reportSearchOf } from './reportFilter'

describe('reportSearchOf', () => {
  it('keeps every filter and the open report', () => {
    const search = {
      tab: 'reports', status: 'withAdmin', priority: 'high', reporter: 'rita', workspace: 'ws-1',
      assignee: 'grace', report: 'r-1',
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

  it('keeps the assignee, by id, and that only reports nobody holds are listed', () => {
    expect(reportSearchOf({ assignee: 'grace@example.test' })).toEqual({ assignee: 'grace@example.test' })
    expect(reportSearchOf({ assignee: 42 })).toEqual({ assignee: '42' })
    expect(reportSearchOf({ unassigned: true })).toEqual({ unassigned: true })
  })

  it('leaves out an empty or malformed assignee, and any `unassigned` but true', () => {
    expect(reportSearchOf({ assignee: '' })).toEqual({})
    expect(reportSearchOf({ assignee: ['grace'] })).toEqual({})
    expect(reportSearchOf({ assignee: true })).toEqual({})
    expect(reportSearchOf({ unassigned: false })).toEqual({})
    expect(reportSearchOf({ unassigned: 'true' })).toEqual({})
    expect(reportSearchOf({ unassigned: 1 })).toEqual({})
  })

  // The server matches nothing for the two together: what the URL holds is sent as it is.
  it('keeps an assignee and `unassigned` that the URL holds together', () => {
    expect(reportSearchOf({ assignee: 'grace', unassigned: true })).toEqual({ assignee: 'grace', unassigned: true })
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
    { assignee: 'grace' }, { unassigned: true },
  ] as const)('is true for %o', (filter) => {
    expect(isFiltered(filter)).toBe(true)
  })

  // The open report is not a filter of the list.
  it('does not count the open report', () => {
    expect(isFiltered(reportSearchOf({ report: 'r-1' }))).toBe(false)
  })
})

describe('matchesChangingFilters', () => {
  const at = new Date('2026-10-12T12:00:00Z')
  const held = { status: 'new', assignee: { id: 'grace', name: 'Grace Admin', at, via: 'api' } } as const
  const free = { status: 'answered' } as const

  it('is true under no filter', () => {
    expect(matchesChangingFilters(held, {})).toBe(true)
    expect(matchesChangingFilters(free, {})).toBe(true)
  })

  it('tells a report by its status', () => {
    expect(matchesChangingFilters(held, { status: 'new' })).toBe(true)
    expect(matchesChangingFilters(free, { status: 'new' })).toBe(false)
  })

  it('tells a report by who holds it, and by whether anybody does', () => {
    expect(matchesChangingFilters(held, { assignee: 'grace' })).toBe(true)
    expect(matchesChangingFilters(held, { assignee: 'ada' })).toBe(false)
    expect(matchesChangingFilters(free, { assignee: 'grace' })).toBe(false)
    expect(matchesChangingFilters(free, { unassigned: true })).toBe(true)
    expect(matchesChangingFilters(held, { unassigned: true })).toBe(false)
  })

  it('needs every filter met, and matches nothing for an assignee together with nobody', () => {
    expect(matchesChangingFilters(held, { status: 'new', assignee: 'grace' })).toBe(true)
    expect(matchesChangingFilters(held, { status: 'closed', assignee: 'grace' })).toBe(false)
    expect(matchesChangingFilters(held, { assignee: 'grace', unassigned: true })).toBe(false)
    expect(matchesChangingFilters(free, { assignee: 'grace', unassigned: true })).toBe(false)
  })

  // No write to a report changes these, so a report listed under them stays listed.
  it('leaves the priority, the reporter and the workspace out', () => {
    expect(matchesChangingFilters(held, { priority: 'high', reporter: 'rita', workspace: 'ws-1' })).toBe(true)
  })
})
