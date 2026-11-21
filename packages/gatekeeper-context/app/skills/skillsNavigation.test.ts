import { describe, expect, it } from 'vitest'
import { currentView, navigate, previousView, START, type NavigationAction, type Navigation } from './skillsNavigation'

const go = (...actions: NavigationAction[]) => actions.reduce<Navigation>(navigate, START)
const collection = { page: 'collection', id: 'c1', tab: 'skills' } as const
const skill = { page: 'skill', id: 'c1/report/SKILL.md', tab: 'preview' } as const

describe('navigate', () => {
  it('goes back the way it came, but never past the first page', () => {
    const stack = go({ type: 'open', view: collection }, { type: 'open', view: skill })
    expect(currentView(stack)).toEqual(skill)
    expect(previousView(stack)).toEqual(collection)
    const back = go({ type: 'open', view: collection }, { type: 'open', view: skill }, { type: 'back' }, { type: 'back' }, { type: 'back' })
    expect(back).toEqual(START)
    expect(previousView(back)).toBeUndefined()
  })

  it('stays on a page that is opened again, and changes its tab without another step back', () => {
    const stack = go({ type: 'open', view: skill }, { type: 'open', view: skill }, { type: 'change', view: { ...skill, tab: 'files' } })
    expect(stack).toEqual([{ page: 'home' }, { ...skill, tab: 'files' }])
  })

  it('keeps the first page under one changed into from it', () => {
    expect(go({ type: 'change', view: collection })).toEqual([{ page: 'home' }, collection])
  })

  it('follows a skill that moved on every page of it, and goes home when what the pages were of is gone', () => {
    const stack = go({ type: 'open', view: skill }, { type: 'open', view: collection }, { type: 'moved', from: skill.id, to: 'c2/report/SKILL.md' })
    expect(previousView(stack)).toEqual({ ...skill, id: 'c2/report/SKILL.md' })
    expect(navigate(stack, { type: 'home' })).toEqual(START)
  })
})
