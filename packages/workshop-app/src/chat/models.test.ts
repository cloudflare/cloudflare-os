import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo } from '@gadgets/workshop-shared/api'
import { describeModelProblem, modelFor, type Models } from './models'

const model = (id: string): AiChatAuthorInfo => ({ type: 'agent', id, name: id })
const ready = (preferred?: string): Models => ({ status: 'ready', offered: [model('a'), model('b'), model('c')], preferred })
const idOf = (choice: ReturnType<typeof modelFor>) => (choice.status === 'ready' ? choice.model.id : choice.status)

describe('modelFor', () => {
  it('starts a new chat with the preferred model, or the first offered', () => {
    expect(idOf(modelFor(ready('b')))).toBe('b')
    expect(idOf(modelFor(ready()))).toBe('a')
  })

  it('keeps a chat on its own model, over the preferred one', () => {
    expect(idOf(modelFor(ready('b'), { chat: 'c' }))).toBe('c')
  })

  it('goes with the one chosen for the message, over the chat’s', () => {
    expect(idOf(modelFor(ready('b'), { chat: 'c', picked: 'a' }))).toBe('a')
  })

  it('passes over a model that is no longer offered', () => {
    expect(idOf(modelFor(ready('gone'), { chat: 'gone too', picked: 'also gone' }))).toBe('a')
    expect(idOf(modelFor(ready('b'), { chat: 'gone' }))).toBe('b')
  })

  it('says when there is none, or none yet', () => {
    expect(idOf(modelFor({ status: 'ready', offered: [], preferred: 'a' }))).toBe('none')
    expect(idOf(modelFor({ status: 'loading' }))).toBe('loading')
    expect(describeModelProblem({ status: 'failed', message: 'Offline.' })).toBe('Couldn’t load your AI models: Offline.')
  })
})
