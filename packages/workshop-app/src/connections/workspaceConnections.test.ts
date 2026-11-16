import { describe, expect, it } from 'vitest'
import type { WorkspaceConnectionInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'
import { automaticLine, changesOf, connectionGroups, kindOf, usesLine, type ConnectionServices } from './workspaceConnections'

const DOC = 'https://docs.google.com/document/d/:id'
const SHEET = 'https://docs.google.com/spreadsheets/d/:id'
const kind = (tag: string, label = tag) => ({ tag, label })
const resource = (urlPattern: string, title: string, actionKinds: SupportedResource['actionKinds'] = []): SupportedResource =>
  ({ urlPattern, title, description: '', actionKinds })
const services: ConnectionServices = new Map([
  ['google', { name: 'Google', resources: [
    resource(DOC, 'Google Doc', [{ kind: kind('edit', 'Document edits, in any Doc this connection reaches'), autoApprovable: true }, { kind: kind('share'), autoApprovable: false }]),
    resource(SHEET, 'Google Sheet', [{ kind: kind('cells'), autoApprovable: true }, { kind: kind('share'), autoApprovable: false }]),
  ] }],
  ['github', { name: 'GitHub', resources: [] }],
  ['websearch', { name: 'Web Search', resources: [] }],
])
const connection = (gatekeeperId: number, title: string, vendorId: string, extra: Partial<WorkspaceConnectionInfo> = {}): WorkspaceConnectionInfo =>
  ({ gatekeeperId, title, vendorId, gadgetIds: [], chatIds: [], ...extra })

describe('connectionGroups', () => {
  it('groups by service, by name, each by title, with what every chat has last', () => {
    const groups = connectionGroups([
      connection(1, 'Plan', 'google', { typeUrlPattern: DOC }),
      connection(2, 'Search', 'websearch', { ambient: true }),
      connection(3, 'acme/site', 'github'),
      connection(4, 'Budget', 'google', { typeUrlPattern: SHEET }),
      connection(5, 'Unknown', 'gone'),
    ], services)
    expect(groups.map(({ label, connections }) => [label, connections.map(({ title }) => title)])).toEqual([
      ['GitHub', ['acme/site']],
      ['gone', ['Unknown']],
      ['Google', ['Budget', 'Plan']],
      ['Every chat has', ['Search']],
    ])
  })
})

describe('kindOf', () => {
  it('says the kind of resource, or the service where it is not known', () => {
    expect(kindOf(connection(1, 'Plan', 'google', { typeUrlPattern: DOC }), services)).toBe('Google Doc')
    expect(kindOf(connection(2, 'Search', 'websearch', { ambient: true }), services)).toBe('Web Search')
  })
})

describe('usesLine', () => {
  it('names the gadgets, two at most, then counts the chats', () => {
    expect(usesLine(['Tip Jar'], 2)).toBe('Used by Tip Jar and 2 chats')
    expect(usesLine(['Tip Jar', 'Budget'], 0)).toBe('Used by Tip Jar and Budget')
    expect(usesLine(['Tip Jar', 'Budget', 'Board'], 1)).toBe('Used by Tip Jar, 2 more gadgets, and a chat')
    expect(usesLine([], 1)).toBe('Used in a chat')
    expect(usesLine([], 0)).toBe('Not used yet')
  })

  it('names an agent once, after the gadgets, and counts only the other chats', () => {
    expect(usesLine(['Tip Jar'], 1, ['Joke Agent'])).toBe('Used by Tip Jar, Joke Agent, and a chat')
    expect(usesLine([], 0, ['Joke Agent'])).toBe('Used by Joke Agent')
    expect(usesLine(['Tip Jar', 'Budget'], 0, ['Joke Agent'])).toBe('Used by Tip Jar and 2 more')
    expect(usesLine(2, 0, ['Joke Agent'])).toBe('Used by 2 gadgets and Joke Agent')
  })

  it('counts the gadgets until their names are known', () => {
    expect(usesLine(2, 0)).toBe('Used by 2 gadgets')
    expect(usesLine(1, 3)).toBe('Used by a gadget and 3 chats')
    expect(usesLine(0, 0)).toBe('Not used yet')
  })
})

describe('automaticLine', () => {
  it('names one kind as it reads, and counts more', () => {
    expect(automaticLine([kind('edit', 'Document edits, in any Doc this connection reaches')])).toBe('Document edits allowed')
    expect(automaticLine([kind('a'), kind('b')])).toBe('2 changes allowed')
    expect(automaticLine([])).toBeUndefined()
  })
})

describe('changesOf', () => {
  const doc = connection(1, 'Plan', 'google', { typeUrlPattern: DOC })
  const resources = services.get('google')!.resources

  it('lists what its kind of resource can change, automatic as the workspace chose', () => {
    expect(changesOf(doc, resources, [kind('edit')]).map(({ kind: { tag }, autoApprovable, automatic }) => [tag, autoApprovable, automatic]))
      .toEqual([['edit', true, true], ['share', false, false]])
  })

  it('lists a rule for a kind not declared, so that it can be undone', () => {
    expect(changesOf(doc, resources, [kind('legacy', 'Old kind')]).at(-1)).toEqual({ kind: kind('legacy', 'Old kind'), autoApprovable: true, automatic: true })
  })

  it('never makes automatic a kind that always asks, whatever a rule says', () => {
    expect(changesOf(doc, resources, [kind('share')]).find(({ kind: { tag } }) => tag === 'share')?.automatic).toBe(false)
  })

  it('lists every kind its service declares, once, for one every chat has', () => {
    expect(changesOf(connection(2, 'Google', 'google', { ambient: true }), resources, []).map(({ kind: { tag } }) => tag)).toEqual(['edit', 'share', 'cells'])
  })
})
