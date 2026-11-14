import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiModelProvider } from '@gadgets/workshop-shared/api'
import { MODELS_DEV_URL, fetchModelsDev, suggestModels } from './modelsDev'

// Entries of https://models.dev/api.json, without the fields nothing here reads.
const HAIKU = {
  id: 'claude-haiku-4-5',
  name: 'Claude Haiku 4.5 (latest)',
  tool_call: true,
  reasoning: true,
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  limit: { context: 200000, output: 64000 },
}
const MODELS_DEV = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    models: {
      'claude-haiku-4-5': HAIKU,
      'claude-opus-5-5': {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    models: {
      'gpt-6.1-sol': {
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1050000, input: 922000, output: 128000 },
      },
      'gpt-4': {
        id: 'gpt-4',
        name: 'GPT-4',
        tool_call: true,
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 8192, output: 8192 },
      },
      'gpt-image-1': {
        id: 'gpt-image-1',
        name: 'gpt-image-1',
        tool_call: false,
        reasoning: false,
        modalities: { input: ['text', 'image'], output: ['image'] },
        limit: { context: 0, input: 0, output: 0 },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        tool_call: false,
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 8191, output: 1536 },
      },
    },
  },
  google: {
    id: 'google',
    name: 'Google',
    models: {
      'gemini-3.6-flash': {
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'video', 'audio', 'pdf'], output: ['text'] },
        limit: { context: 1048576, output: 65536 },
      },
      'gemini-2.5-flash-preview-tts': {
        id: 'gemini-2.5-flash-preview-tts',
        name: 'Gemini 2.5 Flash Preview TTS',
        tool_call: false,
        reasoning: false,
        modalities: { input: ['text'], output: ['audio'] },
        limit: { context: 8192, output: 16384 },
      },
    },
  },
  'cloudflare-workers-ai': {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    models: {
      '@cf/meta/llama-guard-3-8b': {
        id: '@cf/meta/llama-guard-3-8b',
        name: 'Llama Guard 3 8B',
        tool_call: false,
        reasoning: false,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 131072, output: 131072 },
      },
      '@cf/moonshotai/kimi-k2.7-code': {
        id: '@cf/moonshotai/kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 262144, output: 262144 },
      },
      '@cf/zai-org/glm-5.2': {
        id: '@cf/zai-org/glm-5.2',
        name: 'Glm 5.2',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 262144, output: 256000 },
      },
      '@cf/openai/gpt-oss-120b': {
        id: '@cf/openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text'], output: ['text'] },
        limit: { context: 128000, output: 16384 },
      },
    },
  },
  'ollama-cloud': {
    id: 'ollama-cloud',
    name: 'Ollama Cloud',
    models: {
      'glm-5.3-flash': {
        id: 'glm-5.3-flash',
        name: 'GLM-5.3-Flash',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'video', 'pdf'], output: ['text'] },
        limit: { context: 1000000, output: 131072 },
      },
    },
  },
  'cloudflare-ai-gateway': {
    id: 'cloudflare-ai-gateway',
    name: 'Cloudflare AI Gateway',
    models: {
      'anthropic/claude-opus-4.6': {
        id: 'anthropic/claude-opus-4.6',
        name: 'Claude Opus 4.6',
        tool_call: true,
        reasoning: true,
        modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
        limit: { context: 1000000, output: 128000 },
      },
    },
  },
}

const HAIKU_WITHOUT_OUTPUT_LIMIT = {
  provider: 'anthropic',
  id: 'claude-haiku-4-5',
  name: 'Claude Haiku 4.5 (latest)',
  contextWindow: 200000,
  capabilities: { imageInput: true },
}
const HAIKU_SUGGESTION = { ...HAIKU_WITHOUT_OUTPUT_LIMIT, outputLimit: 64000 }

const EVERY_PROVIDER: AiModelProvider[] = ['anthropic', 'openai', 'google', 'cloudflare', 'ollama']

/** What is suggested for Anthropic when models.dev lists exactly `entries` under it. */
const suggestFrom = (...entries: unknown[]) =>
  suggestModels({ anthropic: { models: { ...entries } } }, ['anthropic'], [])

const idsOf = (suggestions: { id: string }[]) => suggestions.map((suggestion) => suggestion.id)

describe('suggestModels', () => {
  it('suggests the given providers’ tool-calling text models, in models.dev’s order', () => {
    expect(suggestModels(MODELS_DEV, EVERY_PROVIDER, [])).toStrictEqual([
      HAIKU_SUGGESTION,
      {
        provider: 'anthropic',
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        contextWindow: 1000000,
        outputLimit: 128000,
        capabilities: { imageInput: true },
      },
      {
        provider: 'openai',
        id: 'gpt-6.1-sol',
        name: 'GPT-6.1 Sol',
        contextWindow: 1050000,
        outputLimit: 128000,
        capabilities: { imageInput: true },
      },
      {
        provider: 'openai',
        id: 'gpt-4',
        name: 'GPT-4',
        contextWindow: 8192,
        capabilities: { imageInput: false, reasoningLevels: ['off'] },
      },
      {
        provider: 'google',
        id: 'gemini-3.6-flash',
        name: 'Gemini 3.6 Flash',
        contextWindow: 1048576,
        outputLimit: 65536,
        capabilities: { imageInput: true },
      },
      {
        provider: 'cloudflare',
        id: '@cf/moonshotai/kimi-k2.7-code',
        name: 'Kimi K2.7 Code',
        contextWindow: 262144,
        capabilities: { imageInput: true },
      },
      {
        provider: 'cloudflare',
        id: '@cf/zai-org/glm-5.2',
        name: 'Glm 5.2',
        contextWindow: 262144,
        capabilities: { imageInput: false },
      },
      {
        provider: 'cloudflare',
        id: '@cf/openai/gpt-oss-120b',
        name: 'GPT OSS 120B',
        contextWindow: 128000,
        capabilities: { imageInput: false },
      },
    ])
  })

  it('lists the providers in the order they are given, each once', () => {
    const suggestions = suggestModels(MODELS_DEV, ['google', 'anthropic', 'google'], [])
    expect(idsOf(suggestions)).toEqual(['gemini-3.6-flash', 'claude-haiku-4-5', 'claude-opus-5-5'])
  })

  describe('providers', () => {
    it.each([
      ['anthropic', 'anthropic'],
      ['openai', 'openai'],
      ['google', 'google'],
      ['cloudflare', 'cloudflare-workers-ai'],
    ] as const)('reads %s from models.dev’s %s', (provider, modelsDevId) => {
      const suggestions = suggestModels({ [modelsDevId]: { models: { HAIKU } } }, [provider], [])
      expect(suggestions.map((suggestion) => [suggestion.provider, suggestion.id]))
        .toEqual([[provider, 'claude-haiku-4-5']])
    })

    it('reads Workers AI from no other Cloudflare list', () => {
      const lists = {
        cloudflare: { models: { HAIKU } },
        'cloudflare-ai-gateway': { models: { HAIKU } },
      }
      expect(suggestModels(lists, ['cloudflare'], [])).toEqual([])
    })

    it('suggests nothing for Ollama, whatever models.dev lists', () => {
      const lists = { ollama: { models: { HAIKU } }, 'ollama-cloud': { models: { HAIKU } } }
      expect(suggestModels(lists, ['ollama'], [])).toEqual([])
    })

    it('never suggests for a provider that was not given', () => {
      const providersOf = (providers: AiModelProvider[]) =>
        [...new Set(suggestModels(MODELS_DEV, providers, []).map(({ provider }) => provider))]
      expect(providersOf(['anthropic'])).toEqual(['anthropic'])
      expect(providersOf(['openai', 'cloudflare'])).toEqual(['openai', 'cloudflare'])
      expect(providersOf([])).toEqual([])
    })
  })

  describe('filters', () => {
    it.each([
      ['does not call tools', { ...HAIKU, tool_call: false }],
      ['states tool calling as text', { ...HAIKU, tool_call: 'true' }],
      ['does not answer in text', { ...HAIKU, modalities: { input: ['text'], output: ['image'] } }],
      ['answers in nothing', { ...HAIKU, modalities: { input: ['text'], output: [] } }],
      ['states no context window', { ...HAIKU, limit: { output: 64000 } }],
      ['states a context window of zero', { ...HAIKU, limit: { context: 0, output: 0 } }],
    ])('drops a model that %s', (_, entry) => {
      expect(suggestFrom(entry)).toEqual([])
    })

    it('drops a model that models.dev marks deprecated, and keeps one in beta', () => {
      expect(suggestFrom({ ...HAIKU, status: 'deprecated' })).toEqual([])
      expect(suggestFrom({ ...HAIKU, status: 'beta' })).toStrictEqual([HAIKU_SUGGESTION])
    })

    it('keeps a model that answers in text among other things', () => {
      const entry = { ...HAIKU, modalities: { ...HAIKU.modalities, output: ['image', 'text'] } }
      expect(suggestFrom(entry)).toStrictEqual([HAIKU_SUGGESTION])
    })

    it('drops the IDs the deployment already has, under whichever provider', () => {
      const existing = ['claude-haiku-4-5', '@cf/zai-org/glm-5.2', 'gpt-4']
      const suggestions = suggestModels(MODELS_DEV, ['anthropic', 'openai', 'cloudflare'], existing)
      expect(idsOf(suggestions)).toEqual([
        'claude-opus-5-5',
        'gpt-6.1-sol',
        '@cf/moonshotai/kimi-k2.7-code',
        '@cf/openai/gpt-oss-120b',
      ])
      expect(suggestModels({ openai: { models: { HAIKU } } }, ['openai'], existing)).toEqual([])
    })

    it('suggests an ID once per provider, as its first entry states it', () => {
      const suggestions = suggestFrom(HAIKU, { ...HAIKU, name: 'Another Haiku' })
      expect(suggestions).toStrictEqual([HAIKU_SUGGESTION])
    })

    it('still suggests one ID under each provider that lists it', () => {
      const lists = { anthropic: { models: { HAIKU } }, openai: { models: { HAIKU } } }
      const suggestions = suggestModels(lists, ['anthropic', 'openai'], [])
      expect(suggestions.map(({ provider }) => provider)).toEqual(['anthropic', 'openai'])
    })
  })

  describe('IDs and names', () => {
    it.each([
      ['an empty ID', { ...HAIKU, id: '' }],
      ['a blank ID', { ...HAIKU, id: ' \t\n' }],
      ['an ID over 200 characters', { ...HAIKU, id: 'm'.repeat(201) }],
      ['an empty name', { ...HAIKU, name: '' }],
      ['a blank name', { ...HAIKU, name: '   ' }],
      ['a name over 200 characters', { ...HAIKU, name: 'n'.repeat(201) }],
    ])('drops a model with %s, which the server would refuse', (_, entry) => {
      expect(suggestFrom(entry)).toEqual([])
    })

    it('keeps an ID and a name of 200 characters', () => {
      const [id, name] = ['m'.repeat(200), 'n'.repeat(200)]
      expect(suggestFrom({ ...HAIKU, id, name })).toStrictEqual([{ ...HAIKU_SUGGESTION, id, name }])
    })

    it('trims them, before measuring them and before matching an existing ID', () => {
      const padded = { ...HAIKU, id: `  ${'m'.repeat(200)}\n`, name: '\tClaude Haiku 4.5  ' }
      expect(suggestFrom(padded)).toStrictEqual([
        { ...HAIKU_SUGGESTION, id: 'm'.repeat(200), name: 'Claude Haiku 4.5' },
      ])
      const lists = { anthropic: { models: { padded: { ...HAIKU, id: ' claude-haiku-4-5 ' } } } }
      expect(suggestModels(lists, ['anthropic'], ['claude-haiku-4-5'])).toEqual([])
    })
  })

  describe('limits', () => {
    const withLimit = (limit: unknown) => suggestFrom({ ...HAIKU, limit })

    it('takes the context window and, when it is smaller, the output limit', () => {
      expect(withLimit({ context: 200000, input: 136000, output: 199999 })).toStrictEqual([
        { ...HAIKU_SUGGESTION, contextWindow: 200000, outputLimit: 199999 },
      ])
    })

    it.each([
      ['equal to the context window', 200000],
      ['over the context window', 200001],
      ['of zero', 0],
      ['below zero', -64000],
      ['that is fractional', 64000.5],
      ['that is not a number', Number.NaN],
      ['stated as text', '64000'],
      ['of null', null],
    ])('leaves the output limit unset for one %s', (_, output) => {
      expect(withLimit({ context: 200000, output })).toStrictEqual([HAIKU_WITHOUT_OUTPUT_LIMIT])
    })

    it('leaves the output limit unset when models.dev states none', () => {
      expect(withLimit({ context: 200000 })).toStrictEqual([HAIKU_WITHOUT_OUTPUT_LIMIT])
    })

    it('leaves every Workers AI output limit unset, even one below the context window', () => {
      const suggestions = suggestModels(MODELS_DEV, ['cloudflare'], [])
      expect(idsOf(suggestions)).toContain('@cf/openai/gpt-oss-120b')
      expect(suggestions.filter((suggestion) => 'outputLimit' in suggestion)).toEqual([])
    })

    // With no output limit of its own, a Workers AI model reserves the server's default of 32768.
    it('drops a Workers AI model whose context window the default output limit fills', () => {
      const workersAi = (id: string, context: number) =>
        ({ ...HAIKU, id, limit: { context, output: context } })
      const models = { a: workersAi('@cf/small', 24000), b: workersAi('@cf/exact', 32768),
        c: workersAi('@cf/roomy', 32769) }
      expect(suggestModels({ 'cloudflare-workers-ai': { models } }, ['cloudflare'], []))
        .toStrictEqual([
          {
            provider: 'cloudflare',
            id: '@cf/roomy',
            name: HAIKU.name,
            contextWindow: 32769,
            capabilities: { imageInput: true },
          },
        ])
      // Another provider's model states its own output limit, or reserves none.
      expect(idsOf(suggestModels({ anthropic: { models } }, ['anthropic'], [])))
        .toEqual(['@cf/small', '@cf/exact', '@cf/roomy'])
    })

    it.each([
      ['of zero', 0],
      ['below zero', -200000],
      ['that is fractional', 200000.5],
      ['that is not a number', Number.NaN],
      ['that is infinite', Number.POSITIVE_INFINITY],
      ['past the safe integers', 2 ** 53],
      ['stated as text', '200000'],
      ['of null', null],
    ])('drops a model with a context window %s', (_, context) => {
      expect(withLimit({ context, output: 64000 })).toEqual([])
    })
  })

  describe('an unexpected document', () => {
    it.each([
      ['undefined', undefined],
      ['null', null],
      ['text', 'models'],
      ['a number', 42],
      ['a boolean', true],
      ['an empty array', []],
      ['an array of providers', [MODELS_DEV.anthropic]],
      ['an empty object', {}],
      ['a provider that is null', { anthropic: null }],
      ['a provider that is text', { anthropic: 'anthropic' }],
      ['a provider that is an array', { anthropic: [{ models: { HAIKU } }] }],
      ['a provider without models', { anthropic: { id: 'anthropic', name: 'Anthropic' } }],
      ['models that are null', { anthropic: { models: null } }],
      ['models that are text', { anthropic: { models: 'claude-haiku-4-5' } }],
      ['models that are an array', { anthropic: { models: [HAIKU] } }],
      ['models at the top level', { models: { HAIKU } }],
    ])('suggests nothing from %s', (_, modelsDev) => {
      expect(suggestModels(modelsDev, EVERY_PROVIDER, [])).toEqual([])
    })

    const without = (field: keyof typeof HAIKU) =>
      Object.fromEntries(Object.entries(HAIKU).filter(([key]) => key !== field))

    it.each([
      ['that is null', null],
      ['that is text', 'claude-haiku-4-5'],
      ['that is a number', 42],
      ['that is a boolean', true],
      ['that is an empty array', []],
      ['that is an array holding a model', [HAIKU]],
      ['that is an empty object', {}],
      ['without an ID', without('id')],
      ['without a name', without('name')],
      ['without tool_call', without('tool_call')],
      ['without modalities', without('modalities')],
      ['without a limit', without('limit')],
      ['with a number for an ID', { ...HAIKU, id: 45 }],
      ['with an array for an ID', { ...HAIKU, id: ['claude-haiku-4-5'] }],
      ['with null for a name', { ...HAIKU, name: null }],
      ['with an object for a name', { ...HAIKU, name: { en: 'Claude Haiku 4.5' } }],
      ['with null for modalities', { ...HAIKU, modalities: null }],
      ['with an array for modalities', { ...HAIKU, modalities: ['text'] }],
      ['with input modalities only', { ...HAIKU, modalities: { input: ['text'] } }],
      ['with text for output modalities', { ...HAIKU, modalities: { output: 'text' } }],
      ['with an object for output modalities', { ...HAIKU, modalities: { output: { text: 1 } } }],
      ['with null for a limit', { ...HAIKU, limit: null }],
      ['with a number for a limit', { ...HAIKU, limit: 200000 }],
      ['with an array for a limit', { ...HAIKU, limit: [200000, 64000] }],
    ])('skips a model entry %s, and suggests the model after it', (_, entry) => {
      const { id, name } = MODELS_DEV.anthropic.models['claude-opus-5-5']
      expect(suggestFrom(entry, MODELS_DEV.anthropic.models['claude-opus-5-5'])).toStrictEqual([
        {
          provider: 'anthropic',
          id,
          name,
          contextWindow: 1000000,
          outputLimit: 128000,
          capabilities: { imageInput: true },
        },
      ])
    })
  })

  describe('capabilities', () => {
    const { capabilities: _stated, ...HAIKU_WITH_NOTHING_STATED } = HAIKU_SUGGESTION

    it.each([
      ['images among other things', ['text', 'image', 'pdf'], true],
      ['images alone', ['image'], true],
      ['text alone', ['text'], false],
      ['audio and video', ['text', 'audio', 'video'], false],
      ['nothing', [], false],
      ['entries that name no kind of input', [1, null, {}, ['image']], false],
    ])('states whether a model takes images for one that takes %s', (_, input, imageInput) => {
      expect(suggestFrom({ ...HAIKU, modalities: { input, output: ['text'] } }))
        .toStrictEqual([{ ...HAIKU_SUGGESTION, capabilities: { imageInput } }])
    })

    it.each([
      ['is missing', { output: ['text'] }],
      ['is null', { input: null, output: ['text'] }],
      ['is text', { input: 'image', output: ['text'] }],
      ['is an object', { input: { image: true }, output: ['text'] }],
    ])('states nothing of images when the list of inputs %s', (_, modalities) => {
      expect(suggestFrom({ ...HAIKU, modalities })).toStrictEqual([HAIKU_WITH_NOTHING_STATED])
    })

    it('states no reasoning for a model that models.dev says does none', () => {
      expect(suggestFrom({ ...HAIKU, reasoning: false })).toStrictEqual([
        { ...HAIKU_SUGGESTION, capabilities: { imageInput: true, reasoningLevels: ['off'] } },
      ])
    })

    it('states no reasoning alone where the list of inputs is missing', () => {
      expect(suggestFrom({ ...HAIKU, modalities: { output: ['text'] }, reasoning: false }))
        .toStrictEqual([{ ...HAIKU_WITH_NOTHING_STATED, capabilities: { reasoningLevels: ['off'] } }])
    })

    it.each([
      ['the efforts it names, least to most',
        [{ type: 'effort', values: ['max', 'low', 'high'] }], ['low', 'high', 'max']],
      ['“none” as Off', [{ type: 'effort', values: ['none', 'high'] }], ['off', 'high']],
      // A switch does not say that the model takes “off” as an effort.
      ['its efforts alone beside a switch and a budget',
        [{ type: 'toggle' }, { type: 'effort', values: ['low', 'medium', 'xhigh'] },
          { type: 'budget_tokens', min: 1024 }],
        ['low', 'medium', 'xhigh']],
      ['only the efforts that are levels, once each',
        [{ type: 'effort', values: ['default', null, 3, ['high'], 'medium', 'medium'] }],
        ['medium']],
      ['the efforts of every list that names some',
        [{ type: 'effort', values: ['high'] }, { type: 'effort', values: ['minimal'] }],
        ['minimal', 'high']],
    ])('states %s for a model that reasons', (_, reasoning_options, reasoningLevels) => {
      expect(suggestFrom({ ...HAIKU, reasoning: true, reasoning_options })).toStrictEqual([
        { ...HAIKU_SUGGESTION, capabilities: { imageInput: true, reasoningLevels } },
      ])
    })

    it.each([
      ['a switch alone', [{ type: 'toggle' }]],
      ['a token budget alone', [{ type: 'budget_tokens', min: 1024, max: 32768 }]],
      ['no way at all', []],
      ['no effort above “none”', [{ type: 'effort', values: ['none'] }]],
      ['efforts that are not a list', [{ type: 'effort', values: 'high' }]],
      ['efforts of another kind of option', [{ type: 'budget_tokens', values: ['high'] }]],
      ['ways that are not a list', { type: 'effort', values: ['high'] }],
      ['ways that are not objects', ['effort', null, ['high']]],
    ])('states no reasoning levels for a model whose reasoning is set by %s', (_, reasoning_options) => {
      expect(suggestFrom({ ...HAIKU, reasoning: true, reasoning_options }))
        .toStrictEqual([HAIKU_SUGGESTION])
    })

    it('states no reasoning for a model said to do none, whatever efforts it names', () => {
      const reasoning_options = [{ type: 'effort', values: ['low', 'high'] }]
      expect(suggestFrom({ ...HAIKU, reasoning: false, reasoning_options })).toStrictEqual([
        { ...HAIKU_SUGGESTION, capabilities: { imageInput: true, reasoningLevels: ['off'] } },
      ])
    })

    // An entry that names no efforts states no levels for a model that reasons.
    it.each([
      ['says reasons', true],
      ['says nothing of reasoning for', undefined],
      ['states null for', null],
      ['states zero for', 0],
      ['states “false” as text for', 'false'],
    ])('states no reasoning levels for a model that models.dev %s', (_, reasoning) => {
      const { reasoning: _reasons, ...entry } = HAIKU
      expect(suggestFrom(reasoning === undefined ? entry : { ...entry, reasoning }))
        .toStrictEqual([HAIKU_SUGGESTION])
    })
  })

  describe('prototype keys', () => {
    const PROTOTYPE_KEYS = ['__proto__', 'constructor', 'toString', 'hasOwnProperty']

    it('reads only what the document itself holds', () => {
      expect(suggestModels(Object.create(MODELS_DEV), EVERY_PROVIDER, [])).toEqual([])
      const inheritedModels = { anthropic: Object.create(MODELS_DEV.anthropic) }
      expect(suggestModels(inheritedModels, ['anthropic'], [])).toEqual([])
      expect(suggestFrom(Object.create(HAIKU))).toEqual([])
      expect(suggestFrom({ ...HAIKU, limit: Object.create(HAIKU.limit) })).toEqual([])
    })

    it('suggests nothing for a provider named after one', () => {
      // What looking each name up in a plain object finds, as the key it would then be read as.
      const reached = PROTOTYPE_KEYS.map((key) => String(Reflect.get({}, key)))
      const modelsDev = Object.fromEntries(
        [...PROTOTYPE_KEYS, ...reached].map((key) => [key, { models: { HAIKU } }]),
      )
      expect(Object.keys(modelsDev)).toHaveLength(2 * PROTOTYPE_KEYS.length)
      // The cast stands in for a provider list that does not match its type at run time.
      expect(suggestModels(modelsDev, PROTOTYPE_KEYS as AiModelProvider[], [])).toEqual([])
    })

    it('takes a model’s ID from its entry, whatever key the entry is listed under', () => {
      const modelsDev = JSON.parse(`{
        "__proto__": { "models": { "stray": ${JSON.stringify(HAIKU)} } },
        "constructor": { "models": { "stray": ${JSON.stringify(HAIKU)} } },
        "anthropic": { "models": {
          "__proto__": ${JSON.stringify(HAIKU)},
          "constructor": "claude-haiku-4-5",
          "toString": null,
          "hasOwnProperty": ${JSON.stringify({ ...HAIKU, id: 'claude-opus-5-5' })}
        } }
      }`)
      expect(idsOf(suggestModels(modelsDev, EVERY_PROVIDER, [])))
        .toEqual(['claude-haiku-4-5', 'claude-opus-5-5'])
    })
  })
})

const stubFetch = (respond: () => Promise<Response>) => {
  const fetch = vi.fn<typeof globalThis.fetch>(respond)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

describe('fetchModelsDev', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves to the parsed list', async () => {
    stubFetch(async () => new Response(JSON.stringify(MODELS_DEV)))
    const modelsDev = await fetchModelsDev(new AbortController().signal)
    expect(modelsDev).toEqual(MODELS_DEV)
  })

  it('makes one plain GET of models.dev, without credentials, that the signal aborts', async () => {
    const fetch = stubFetch(async () => new Response('{}'))
    const controller = new AbortController()
    await fetchModelsDev(controller.signal)

    expect(fetch).toHaveBeenCalledOnce()
    const [url, init] = fetch.mock.calls[0]
    expect(url).toBe(MODELS_DEV_URL)
    expect(url).toBe('https://models.dev/api.json')
    const request = new Request(url, init)
    expect(request.method).toBe('GET')
    expect(request.credentials).toBe('omit')
    expect([...request.headers]).toEqual([])
    expect(request.signal.aborted).toBe(false)
    controller.abort()
    expect(request.signal.aborted).toBe(true)
  })

  it('rejects when models.dev answers with an error', async () => {
    stubFetch(async () => new Response(JSON.stringify(MODELS_DEV), { status: 503 }))
    await expect(fetchModelsDev(new AbortController().signal)).rejects.toThrow('503')
  })

  it('rejects when the answer is not JSON', async () => {
    stubFetch(async () => new Response('<!doctype html><title>models.dev</title>'))
    await expect(fetchModelsDev(new AbortController().signal)).rejects.toThrow(SyntaxError)
  })

  it('rejects when the request fails', async () => {
    stubFetch(async () => { throw new TypeError('Failed to fetch') })
    await expect(fetchModelsDev(new AbortController().signal)).rejects.toThrow('Failed to fetch')
  })
})
