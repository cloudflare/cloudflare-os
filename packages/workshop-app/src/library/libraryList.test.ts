import { describe, expect, it } from 'vitest'
import type { BlueprintOutput, OutputSummary } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { libraryList, outputKey, ownApps } from './libraryList'

const NOW = new Date(2026, 10, 12, 15)
const hoursAgo = (hours: number) => new Date(NOW.getTime() - hours * 60 * 60 * 1000)

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }
const SPREADSHEET: BlueprintOutput = { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table' }
const PRESENTATION: BlueprintOutput = { id: 'presentation', noun: 'Presentation', plural: 'Presentations', icon: 'presentation' }
const WORKFLOW: BlueprintOutput = { id: 'workflow', noun: 'Workflow', plural: 'Workflows', icon: 'flowArrow' }

let made = 0
const output = (title: string, workspace: string, rest: Partial<OutputSummary> = {}): OutputSummary => ({
  workspaceId: workspace.toLowerCase(),
  workpieceId: ++made,
  title,
  workspaceTitle: workspace,
  created: NOW,
  lastActive: NOW,
  ...rest,
})

const OUTPUTS = [
  output('Review', 'Notes', { output: DOCUMENT, lastActive: hoursAgo(3) }),
  output('Dashboard', 'Jira', { lastActive: hoursAgo(1) }),
  output('Cutover', 'Atlas', { output: WORKFLOW, owner: { type: 'user', id: 'grace', name: 'Grace Hopper' }, lastActive: hoursAgo(2) }),
  output('Retro', 'Notes', { output: DOCUMENT, lastActive: hoursAgo(1) }),
]
// Offered in this order, with nothing made as a presentation or a spreadsheet yet; the dashboard is starred.
const spec = libraryList(OUTPUTS, [PRESENTATION, DOCUMENT, SPREADSHEET], new Set([outputKey(OUTPUTS[1])]))
const options = (facet: string) => spec.filters!.filter((filter) => filter.facet === facet).map(({ id, label }) => [id, label])
const titles = (outputs: OutputSummary[]) => outputs.map(({ title }) => title)
const left = (query: string, ...ids: string[]) =>
  titles(narrowList(OUTPUTS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }))

describe('libraryList', () => {
  it('has a filter for apps, then each format the deployment offers in its order, made as or not, then any other made as', () => {
    expect(options('type')).toEqual([
      ['type:app', 'Apps'],
      ['type:presentation', 'Presentations'],
      ['type:document', 'Documents'],
      ['type:spreadsheet', 'Spreadsheets'],
      ['type:workflow', 'Workflows'],
    ])
  })

  it('has no filters for types while apps are all there is', () => {
    expect(libraryList([output('Dashboard', 'Jira')], [], new Set()).filters!.some(({ facet }) => facet === 'type')).toBe(false)
  })

  it('narrows to the starred, whatever else is asked for', () => {
    expect(left('', 'starred')).toEqual(['Dashboard'])
    expect(left('', 'starred', 'type:document')).toEqual([])
  })

  it('narrows to a type, taking types as alternatives, and one with no format as an app', () => {
    expect(left('', 'type:document')).toEqual(['Review', 'Retro'])
    expect(left('', 'type:app', 'type:workflow')).toEqual(['Dashboard', 'Cutover'])
    expect(left('', 'type:document', 'shared')).toEqual([])
  })

  it('has a filter for each workspace by title, once there is more than one', () => {
    expect(options('workspace')).toEqual([['workspace:atlas', 'Atlas'], ['workspace:jira', 'Jira'], ['workspace:notes', 'Notes']])
    expect(left('', 'workspace:notes', 'workspace:jira')).toEqual(['Review', 'Dashboard', 'Retro'])
    expect(libraryList(OUTPUTS.filter(({ workspaceId }) => workspaceId === 'notes'), [], new Set()).filters!.some(({ facet }) => facet === 'workspace')).toBe(false)
  })

  it('finds an output by what it is, the workspace it is in, and who shared it', () => {
    expect(left('documents')).toEqual(['Review', 'Retro'])
    expect(left('app')).toEqual(['Dashboard'])
    expect(left('atlas')).toEqual(['Cutover'])
    expect(left('hopper')).toEqual(['Cutover'])
  })

  it('orders by type as the filters list them, each type on its own and the latest active first within it', () => {
    const byType = spec.orders.find(({ id }) => id === 'type')!
    expect(byType.arrange(OUTPUTS, 4).map(({ label, entries }) => [label, titles(entries.map(({ value }) => value))])).toEqual([
      ['Apps', ['Dashboard']],
      ['Documents', ['Retro', 'Review']],
      ['Workflows', ['Cutover']],
    ])
  })
})

describe('ownApps', () => {
  it('has the user’s own apps by title, and not those shared with them or made as a format', () => {
    const outputs = [
      output('Zebra counter', 'Launch'),
      output('Budget', 'Budget', { output: SPREADSHEET }),
      output('Atlas board', 'Atlas', { owner: { type: 'user', id: 'grace', name: 'Grace Hopper' } }),
      output('', 'Scratch'),
      output('Jira dashboard', 'Jira'),
    ]
    // The untitled one by what it is called where it is listed.
    expect(ownApps(outputs).map(({ title }) => title)).toEqual(['Jira dashboard', '', 'Zebra counter'])
  })
})
