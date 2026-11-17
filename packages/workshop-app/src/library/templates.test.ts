import { describe, expect, it } from 'vitest'
import type { BlueprintBinding, BlueprintOutput } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { mostUsed, recentlyAdded, templateList, templatesByType } from './templateList'
import { templateNeeds, templateSearchText, templateTypes, type Template } from './templates'

const DOCUMENT: BlueprintOutput = { id: 'document', noun: 'Document', plural: 'Documents', icon: 'fileText' }

const service = (title: string, spawnerOnly?: true): BlueprintBinding =>
  ({ type: 'gatekeeper', title, description: `What it does with ${title}`, gatekeeperName: title.toLowerCase(), typeUrlPattern: '*', spawnerOnly })

const template = (title: string, { output, bindings = {}, uses = 0, day = 1 }: { output?: BlueprintOutput; bindings?: Record<string, BlueprintBinding>; uses?: number; day?: number } = {}): Template => ({
  id: title,
  uses,
  metadata: {
    title,
    description: `What ${title} is for`,
    author: { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' },
    created: new Date(2026, 0, day),
    version: 1,
    lastUpdated: new Date(2026, 0, day),
    output,
    bindings,
  },
})

const titles = (templates: Template[]) => templates.map(({ metadata }) => metadata.title)

describe('templates', () => {
  it('needs the services a template is bound to, not its models nor what only its agents are given', () => {
    const needs = templateNeeds(template('Triage', {
      bindings: {
        JIRA: service('Jira'),
        MODEL: { type: 'aiModel', title: 'Model', description: '' },
        SLACK: service('Slack', true),
        GITHUB: service('GitHub'),
      },
    }))
    expect(needs).toEqual([
      { key: 'JIRA', name: 'Jira', description: 'What it does with Jira' },
      { key: 'GITHUB', name: 'GitHub', description: 'What it does with GitHub' },
    ])
  })

  it('lists each type once, in the order they are first met, with an app for no format', () => {
    const types = templateTypes([template('Notes', { output: DOCUMENT }), template('Dashboard'), template('Retro', { output: DOCUMENT })])
    expect(types.map(({ id }) => id)).toEqual(['document', 'app'])
  })

  it('finds a template by what it makes, who published it and what it needs', () => {
    const text = templateSearchText(template('Triage', { output: DOCUMENT, bindings: { JIRA: service('Jira') } }))
    for (const word of ['Triage', 'Documents', 'Lovelace', 'Jira']) expect(text).toContain(word)
  })
})

describe('templateList', () => {
  const NOTES = template('Notes', { output: DOCUMENT, uses: 5, day: 1 })
  const DASHBOARD = template('Dashboard', { uses: 9, day: 2, bindings: { JIRA: service('Jira') } })
  const RETRO = template('Retro', { output: DOCUMENT, uses: 5, day: 3 })
  const TRIAGE = template('Triage', { uses: 1, day: 4, bindings: { JIRA: service('Jira'), GMAIL: service('Gmail') } })
  const ALL = [NOTES, DASHBOARD, RETRO, TRIAGE]
  const spec = templateList(ALL, new Set(['Retro']))
  const left = (...ids: string[]) => titles(narrowList(ALL, { query: '', searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }))

  it('puts the most used first, and of those used as much, the latest published', () => {
    expect(titles(mostUsed(ALL))).toEqual(['Dashboard', 'Retro', 'Notes', 'Triage'])
  })

  it('puts the latest published first', () => {
    expect(titles(recentlyAdded(ALL))).toEqual(['Triage', 'Retro', 'Dashboard', 'Notes'])
  })

  it('gathers them under what they make, the kind of the most used first', () => {
    expect(templatesByType(ALL).map(({ type, templates }) => [type.plural, titles(templates)])).toEqual([
      ['Apps', ['Dashboard', 'Triage']],
      ['Documents', ['Retro', 'Notes']],
    ])
  })

  it('has a filter for each service needed, by name, as alternatives', () => {
    expect(spec.filters!.filter(({ facet }) => facet === 'needs').map(({ label }) => label)).toEqual(['Gmail', 'Jira'])
    expect(left('needs:Gmail')).toEqual(['Triage'])
    expect(left('needs:Gmail', 'needs:Jira')).toEqual(['Dashboard', 'Triage'])
  })

  it('narrows to the starred, and to those that need nothing connected', () => {
    expect(left('starred')).toEqual(['Retro'])
    expect(left('ready')).toEqual(['Notes', 'Retro'])
    expect(left('ready', 'needs:Jira')).toEqual([])
  })
})
