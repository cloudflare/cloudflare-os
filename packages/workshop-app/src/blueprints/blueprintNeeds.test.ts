import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, BlueprintMetadata } from '@gadgets/workshop-shared/api'
import { initialAnswers, needsOf, shortResource, suggestedModelId, unmet } from './blueprintNeeds'

const model = (id: string, name = id): AiChatAuthorInfo => ({ type: 'agent', id, name })

const BINDINGS: BlueprintMetadata['bindings'] = {
  AGENT: { type: 'agentSpawner', title: 'Helper', description: '', env: {} },
  LLM: { type: 'aiModel', title: 'Model', description: 'Writes the summary', suggestedModel: { provider: 'anthropic', modelName: 'claude-sonnet-4-6' } },
  SHEET: { type: 'gatekeeper', title: 'Budget', description: 'The sheet to read', gatekeeperName: 'GOOGLE', typeUrlPattern: 'https://docs.google.com/spreadsheets/d/:id/*', resourceUrl: 'https://docs.google.com/spreadsheets/d/abc/' },
  JUDGE: { type: 'aiModel', title: '', description: '', modelKind: 'decision' },
}

describe('needsOf', () => {
  it('lists connections, then models, then agents, with the service as the vendor list names it', () => {
    const needs = needsOf({ bindings: BINDINGS })
    expect(needs.map(({ key, type }) => [key, type])).toEqual([['SHEET', 'connection'], ['LLM', 'model'], ['JUDGE', 'model'], ['AGENT', 'agent']])
    expect(needs[0]).toMatchObject({ vendorId: 'google', urlPattern: BINDINGS.SHEET.type === 'gatekeeper' ? BINDINGS.SHEET.typeUrlPattern : '' })
  })

  it('names one its author left untitled by the name its code knows it by', () => {
    expect(needsOf({ bindings: BINDINGS }).find(({ key }) => key === 'JUDGE')).toMatchObject({ title: 'JUDGE', kind: 'decision' })
  })
})

describe('suggestedModelId', () => {
  const suggested = { provider: 'anthropic', modelName: 'claude-sonnet-4-6' }

  it('finds the model by its id, alone or after its provider', () => {
    expect(suggestedModelId([model('gpt'), model('claude-sonnet-4-6')], suggested)).toBe('claude-sonnet-4-6')
    expect(suggestedModelId([model('anthropic/claude-sonnet-4-6', 'Sonnet')], suggested)).toBe('anthropic/claude-sonnet-4-6')
  })

  it('finds the only one that mentions both, and guesses none among several', () => {
    expect(suggestedModelId([model('m1', 'Anthropic claude-sonnet-4-6 (fast)')], suggested)).toBe('m1')
    expect(suggestedModelId([model('m1', 'anthropic claude-sonnet-4-6 a'), model('m2', 'anthropic claude-sonnet-4-6 b')], suggested)).toBeUndefined()
  })
})

describe('initialAnswers', () => {
  const models = { language: [model('gpt'), model('claude-sonnet-4-6'), model('mine')], decision: [model('clef')] }

  it('meets each model need with the suggested model, then the preferred, then the first of its kind', () => {
    const needs = needsOf({ bindings: BINDINGS })
    expect(initialAnswers(needs, models, 'mine')).toEqual({
      LLM: { type: 'aiModel', modelId: 'claude-sonnet-4-6' },
      JUDGE: { type: 'aiModel', modelId: 'clef' },
      AGENT: { type: 'agentSpawner', modelId: 'mine' },
    })
    expect(initialAnswers(needs, models).AGENT).toEqual({ type: 'agentSpawner', modelId: 'gpt' })
  })

  it('leaves an agent its author ran with no model with none, and connections to the user', () => {
    const needs = needsOf({ bindings: { AGENT: { type: 'agentSpawner', title: 'Helper', description: '', env: {}, suggestedModel: null }, SHEET: BINDINGS.SHEET } })
    const answers = initialAnswers(needs, models)
    expect(answers).toEqual({ AGENT: { type: 'agentSpawner', modelId: null } })
    expect(unmet(needs, answers).map(({ key }) => key)).toEqual(['SHEET'])
  })

  it('leaves a model need unmet when the user has no model of its kind', () => {
    expect(initialAnswers(needsOf({ bindings: { JUDGE: BINDINGS.JUDGE } }), { language: models.language, decision: [] })).toEqual({})
  })
})

describe('shortResource', () => {
  it('drops the scheme and a trailing slash', () => {
    expect(shortResource('https://github.com/cloudflare/gadgets/')).toBe('github.com/cloudflare/gadgets')
  })
})
