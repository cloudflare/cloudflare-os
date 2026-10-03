// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AdminModelView,
  BuiltInReasoning,
  GatewayModelMode,
  GatewayModelSettings,
  GatewayModelTest,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'
import { GatewayModelRow } from './GatewayModelRow'
import type { GatewayTestState } from './useGatewayTests'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// A catalog model left as it ships: three levels, and a budget that can't be raised.
const SONNET: AdminModelView = {
  provider: 'anthropic', id: 'claude-sonnet', name: 'Claude Sonnet', contextWindow: 264000,
  outputLimit: 64000, mode: 'enabled', defaultMode: 'enabled', added: false,
  reasoningLevels: ['off', 'low', 'high'], builtInReasoning: 'adaptive',
  builtInCompactionInputBudget: 200000, maxCompactionInputBudget: 200000, runtimeKnown: true,
}
// A catalog model whose built-in budget is under what its window has room for.
const GPT: AdminModelView = {
  provider: 'openai', id: 'gpt-next', name: 'GPT Next', contextWindow: 400000, outputLimit: 128000,
  mode: 'enabled', defaultMode: 'enabled', added: false,
  reasoningLevels: ['minimal', 'low', 'medium', 'high'], builtInReasoning: 'medium',
  builtInCompactionInputBudget: 180000, maxCompactionInputBudget: 272000, runtimeKnown: true,
}
// An added model that the runtime has no entry for.
const ADDED: AdminModelView = {
  provider: 'anthropic', id: 'claude-next', name: 'Claude Next', contextWindow: 200000,
  mode: 'enabled', defaultMode: 'enabled', added: true,
  reasoningLevels: ['off', 'low', 'high'], builtInReasoning: null,
  builtInCompactionInputBudget: 200000, maxCompactionInputBudget: 200000, runtimeKnown: false,
}

const tokens = (count: number) => `${count.toLocaleString()} tokens`

const SMALL_BUDGET_WARNING = `A budget under ${tokens(100000)} makes a chat compact very often.`
const AUTH_HINT =
  'The gateway may hold no key or credits for this provider, or CF_AI_GATEWAY_API_TOKEN may not ' +
  'be allowed to run models.'

const button = (name: string) => {
  const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => (b.getAttribute('aria-label') ?? b.textContent) === name)
  if (!element) throw new Error(`No button ${name}`)
  return element
}

const buttons = () => Array.from(document.body.querySelectorAll('button'))
  .map((b) => b.getAttribute('aria-label') ?? b.textContent)

const describedBy = (element: HTMLElement) =>
  (element.getAttribute('aria-describedby') ?? '').split(' ')
    .map((id) => document.getElementById(id)?.textContent ?? '').join(' ')

const click = (element: HTMLElement) => act(async () => { element.click() })

// As typing reports itself.
const type = (element: HTMLInputElement, value: string) => act(() => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

const levelSelect = (modelName = 'Claude Sonnet') => button(`Reasoning level for ${modelName}`)

/** The options of the list that `select` opens, which is left open. */
const openOptions = async (select: HTMLElement) => {
  if (select.getAttribute('aria-expanded') !== 'true') await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  return Array.from(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])
}

// What the level select shows for the deployment default, and its first option.
const deploymentDefaultShown = async () => [
  levelSelect().textContent, (await openOptions(levelSelect()))[0].textContent,
]

// By keyboard. The option turns Enter into a click it builds as a PointerEvent, which jsdom lacks,
// so the window has a stand-in for as long as the choice takes.
const choose = async (select: HTMLElement, label: string) => {
  const option = (await openOptions(select)).find((element) => element.textContent === label)
  if (!option) throw new Error(`No option ${label}`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    delete view.PointerEvent
  }
}

const budgetField = (modelName = 'Claude Sonnet') => {
  const label = Array.from(document.body.querySelectorAll('label'))
    .find((element) => element.textContent === `Compaction budget for ${modelName}`)
  const field = document.getElementById(label?.htmlFor ?? '')
  if (!(field instanceof HTMLInputElement)) throw new Error(`No budget field for ${modelName}`)
  return field
}

const saveBudget = (modelName = 'Claude Sonnet') =>
  button(`Save the compaction budget of ${modelName}`)
const resetBudget = (modelName = 'Claude Sonnet') =>
  button(`Reset the compaction budget of ${modelName}`)

// What the row says of the model it behaves like, if anything.
const behavesLikeLine = () => Array.from(document.body.querySelectorAll('li p'))
  .map((p) => p.textContent).filter((text) => text?.startsWith('Behaves like'))

// As Enter in the field does. jsdom submits no form for a key press.
const pressEnter = (field: HTMLInputElement) => act(async () => {
  field.form!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
})

const alerts = () =>
  Array.from(document.body.querySelectorAll('[role="alert"]')).map((alert) => alert.textContent)

// The Test button, which names the model while the test is in flight too.
const testButton = (modelName = 'Claude Sonnet') => {
  const element = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button'))
    .find((b) => [`Test ${modelName}`, `Testing ${modelName}…`].includes(b.getAttribute('aria-label') ?? ''))
  if (!element) throw new Error(`No Test button for ${modelName}`)
  return element
}

const testStatus = () => {
  const regions = document.body.querySelectorAll<HTMLElement>('li [role="status"]')
  if (regions.length !== 1) throw new Error(`${regions.length} status regions`)
  return regions[0]
}

const answered = (result: GatewayModelTest): GatewayTestState => ({ state: 'answered', result })

/** What the row's status region says, one entry for each paragraph of it. */
const testSaid = () => Array.from(testStatus().querySelectorAll('p')).map((p) => p.textContent)

const follows = (earlier: Node, later: Node) =>
  Boolean(earlier.compareDocumentPosition(later) & Node.DOCUMENT_POSITION_FOLLOWING)

describe('GatewayModelRow', () => {
  let root: Root | undefined

  afterEach(() => {
    act(() => root?.unmount())
    document.body.innerHTML = ''
  })

  type Shown = {
    model: AdminModelView
    defaultReasoning?: ReasoningLevel | null
    behavesLikeName?: string
    busy?: boolean
    removable?: boolean
    test?: GatewayTestState
  }

  /** Render the row with its settings open, unless `collapsed`. */
  const render = async (shown: Shown, { collapsed = false } = {}) => {
    const onModeChange = vi.fn<(mode: GatewayModelMode) => void>()
    const onSettingsChange = vi.fn<(settings: GatewayModelSettings) => void>()
    const onTest = vi.fn<() => void>()
    const onRemove = vi.fn<() => void>()
    const container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
    // Shows the row as a re-read of the settings reported it.
    const show = (
      { model, defaultReasoning = null, behavesLikeName, busy = false, removable, test }: Shown,
    ) =>
      act(async () => root!.render(
        <ul>
          <GatewayModelRow
            model={model}
            defaultReasoning={defaultReasoning}
            behavesLikeName={behavesLikeName}
            busy={busy}
            test={test}
            onModeChange={onModeChange}
            onSettingsChange={onSettingsChange}
            onTest={onTest}
            onRemove={removable ? onRemove : undefined}
          />
        </ul>))
    await show(shown)
    if (!collapsed) await click(button(`Settings for ${shown.model.name}`))
    return { onModeChange, onSettingsChange, onTest, onRemove, show }
  }

  describe('the settings disclosure', () => {
    it('keeps the settings out of the row until it is opened, and puts them away again', async () => {
      await render({ model: SONNET }, { collapsed: true })
      const disclosure = button('Settings for Claude Sonnet')

      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(() => levelSelect()).toThrow('No button')
      expect(() => budgetField()).toThrow('No budget field')

      await click(disclosure)

      expect(disclosure.getAttribute('aria-expanded')).toBe('true')
      expect(document.getElementById(disclosure.getAttribute('aria-controls')!)!
        .contains(levelSelect())).toBe(true)
      expect(budgetField().value).toBe('')

      await click(disclosure)

      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    })

    it('keeps a budget that was typed but not saved while it is closed', async () => {
      await render({ model: SONNET })
      await type(budgetField(), '150000')

      await click(button('Settings for Claude Sonnet'))
      await click(button('Settings for Claude Sonnet'))

      expect(budgetField().value).toBe('150000')
    })
  })

  describe('the “Changed” badge', () => {
    it.each<[string, Partial<AdminModelView>, boolean]>([
      ['nothing is set', {}, false],
      ['the mode is off its default', { mode: 'hidden' }, true],
      ['only a reasoning level is set', { settings: { reasoning: 'high' } }, true],
      ['only a compaction budget is set', { settings: { compactionInputBudget: 150000 } }, true],
    ])('when %s', async (_case, changes, changed) => {
      await render({ model: { ...SONNET, ...changes } }, { collapsed: true })

      expect(document.body.querySelector('li')!.textContent!.includes('Changed')).toBe(changed)
    })
  })

  describe('the reasoning level', () => {
    it.each<[BuiltInReasoning, string]>([
      ['adaptive', 'Deployment default (built-in: Adaptive)'],
      ['medium', 'Deployment default (built-in: Medium)'],
      ['xhigh', 'Deployment default (built-in: Extra high)'],
      [null, 'Deployment default (built-in: no level sent)'],
    ])('with no deployment default, offers what a model whose built-in is %s is then asked for, ' +
      'then the model’s own levels', async (builtInReasoning, label) => {
      await render({ model: { ...SONNET, builtInReasoning } })

      expect(levelSelect().textContent).toBe(label)
      expect((await openOptions(levelSelect())).map((option) => option.textContent))
        .toEqual([label, 'Off', 'Low', 'High'])
    })

    it.each<[BuiltInReasoning, ReasoningLevel, string]>([
      ['adaptive', 'xhigh', 'Deployment default (Extra high)'],
      ['medium', 'low', 'Deployment default (Low)'],
      [null, 'off', 'Deployment default (Off)'],
    ])('for a model whose built-in is %s, offers the deployment default of %s by its name, ' +
      'then the model’s own levels', async (builtInReasoning, level, label) => {
      await render({ model: { ...SONNET, builtInReasoning }, defaultReasoning: level })

      expect(levelSelect().textContent).toBe(label)
      expect((await openOptions(levelSelect())).map((option) => option.textContent))
        .toEqual([label, 'Off', 'Low', 'High'])
    })

    it('follows the built-in the server reports for the model, and the deployment default over it', async () => {
      const { show } = await render({ model: SONNET })
      const reads: [Shown, string][] = [
        [{ model: SONNET }, 'Deployment default (built-in: Adaptive)'],
        [{ model: { ...SONNET, builtInReasoning: 'medium' } }, 'Deployment default (built-in: Medium)'],
        [{ model: { ...SONNET, builtInReasoning: null } }, 'Deployment default (built-in: no level sent)'],
        [{ model: { ...SONNET, builtInReasoning: null }, defaultReasoning: 'high' },
          'Deployment default (High)'],
        [{ model: SONNET }, 'Deployment default (built-in: Adaptive)'],
      ]

      for (const [shown, label] of reads) {
        await show(shown)

        expect(await deploymentDefaultShown()).toEqual([label, label])
      }
    })

    it('shows the level the server holds for the model', async () => {
      await render({ model: { ...SONNET, settings: { reasoning: 'low' } }, defaultReasoning: 'high' })

      expect(levelSelect().textContent).toBe('Low')
      expect((await openOptions(levelSelect()))
        .filter((option) => option.getAttribute('aria-selected') === 'true')
        .map((option) => option.textContent)).toEqual(['Low'])
    })

    // The server refuses a budget over the maximum, which a stored one is once the maximum drops.
    it.each<[string, number, GatewayModelSettings]>([
      ['as it is while the maximum allows it', 200000, { reasoning: 'high', compactionInputBudget: 150000 }],
      ['at the maximum once it is over it', 120000, { reasoning: 'high', compactionInputBudget: 120000 }],
      ['no further once the model has room for none', 0, { reasoning: 'high' }],
    ])('sets a level and carries the budget the model already has %s', async (_case, maximum, sent) => {
      const { onSettingsChange } = await render({
        model: {
          ...SONNET, maxCompactionInputBudget: maximum, settings: { compactionInputBudget: 150000 },
        },
      })

      await choose(levelSelect(), 'High')

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(sent)
      expect(Object.keys(onSettingsChange.mock.calls[0][0])).toEqual(Object.keys(sent))
      // The server's value is what the select shows, and the re-read is what changes it.
      expect(levelSelect().textContent).toBe('Deployment default (built-in: Adaptive)')
    })

    it('replaces the model’s level', async () => {
      const { onSettingsChange } = await render({
        model: { ...SONNET, settings: { reasoning: 'low' } },
      })

      await choose(levelSelect(), 'Off')

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ reasoning: 'off' })
    })

    it.each<[string, GatewayModelSettings, GatewayModelSettings]>([
      ['leaving the budget', { reasoning: 'high', compactionInputBudget: 150000 },
        { compactionInputBudget: 150000 }],
      ['leaving nothing', { reasoning: 'high' }, {}],
    ])('clears the level by choosing the deployment default, %s', async (_case, settings, sent) => {
      const { onSettingsChange } = await render({ model: { ...SONNET, settings } })

      await choose(levelSelect(), 'Deployment default (built-in: Adaptive)')

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(sent)
      expect(Object.keys(onSettingsChange.mock.calls[0][0])).toEqual(Object.keys(sent))
    })

    it('sends nothing when the level it already shows is chosen', async () => {
      const { onSettingsChange } = await render({
        model: { ...SONNET, settings: { reasoning: 'high' } },
      })

      await choose(levelSelect(), 'High')

      expect(onSettingsChange).not.toHaveBeenCalled()
    })

    // When its options change under a level that is not one of them, the select reports a change
    // back to the value it started with.
    it('leaves alone a level the model lacks that arrives while the settings are open', async () => {
      const { onSettingsChange, show } = await render({ model: SONNET })
      await openOptions(levelSelect())
      await click(levelSelect())

      await show({ model: { ...SONNET, settings: { reasoning: 'max' } } })
      await show({ model: { ...SONNET, reasoningLevels: ['low', 'high'], settings: { reasoning: 'max' } } })

      expect(levelSelect().textContent).toBe('Max')
      expect(onSettingsChange).not.toHaveBeenCalled()
    })

    it('sets nothing for a letter typed while the select is closed', async () => {
      const { onSettingsChange } = await render({ model: SONNET })
      // A focused select learns its options a moment later, and matches letters against them.
      await act(async () => { levelSelect().focus() })
      await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

      await act(async () => {
        levelSelect().dispatchEvent(new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true }))
      })

      expect(levelSelect().getAttribute('aria-expanded')).toBe('false')
      expect(onSettingsChange).not.toHaveBeenCalled()
    })

    it('has no note while the level in effect is one the model has', async () => {
      await render({ model: { ...SONNET, settings: { reasoning: 'high' } }, defaultReasoning: 'max' })

      expect(describedBy(levelSelect())).toBe('')
    })

    it('has no note while no level is in effect', async () => {
      await render({ model: SONNET })

      expect(describedBy(levelSelect())).toBe('')
    })

    it.each<[string, GatewayModelSettings | undefined, ReasoningLevel, string, string]>([
      ['the model’s own', { reasoning: 'max' }, 'high', 'Max', 'Max'],
      ['the deployment default', undefined, 'medium', 'Deployment default (Medium)', 'Medium'],
    ])('says that a missing level, %s, is fitted when a request is made', async (
      _case, settings, defaultReasoning, shown, missing,
    ) => {
      await render({ model: { ...SONNET, settings }, defaultReasoning })

      expect(levelSelect().textContent).toBe(shown)
      expect(describedBy(levelSelect())).toBe(
        `This model has no “${missing}” level. A request asks for the nearest level it has, ` +
        'which is decided when the request is made.')
      // The level the model lacks is not among the ones to choose.
      expect((await openOptions(levelSelect())).map((option) => option.textContent).slice(1))
        .toEqual(['Off', 'Low', 'High'])
    })

    it('offers no level for a model that takes none, and says none is sent', async () => {
      await render({ model: { ...SONNET, reasoningLevels: [] }, defaultReasoning: 'high' })

      expect(() => levelSelect()).toThrow('No button')
      expect(document.body.textContent)
        .toContain('This model takes no reasoning levels, so none is sent to it.')
    })

    it('still lets a level stored for a model that takes none be cleared', async () => {
      const { onSettingsChange } = await render({
        model: {
          ...SONNET, reasoningLevels: [], builtInReasoning: null, settings: { reasoning: 'high' },
        },
      })

      expect(levelSelect().textContent).toBe('High')
      expect(describedBy(levelSelect()))
        .toBe('This model takes no reasoning levels, so none is sent to it.')
      expect((await openOptions(levelSelect())).map((option) => option.textContent))
        .toEqual(['Deployment default (built-in: no level sent)'])

      await choose(levelSelect(), 'Deployment default (built-in: no level sent)')

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({})
    })
  })

  describe('the compaction budget', () => {
    it('says what the built-in budget and the maximum are, and where a chat compacts', async () => {
      await render({ model: GPT })

      expect(budgetField('GPT Next').value).toBe('')
      expect(budgetField('GPT Next').placeholder).toBe(`${(180000).toLocaleString()} (built-in)`)
      expect(describedBy(budgetField('GPT Next'))).toContain(
        `Leave blank for the built-in budget of ${tokens(180000)}. The maximum is ` +
        `${tokens(272000)}. A chat on this model compacts at about ${tokens(153000)}.`)
      expect(() => resetBudget('GPT Next')).toThrow('No button')
    })

    it('shows the budget the server holds, and where a chat then compacts', async () => {
      await render({ model: { ...GPT, settings: { compactionInputBudget: 250001 } } })

      expect(budgetField('GPT Next').value).toBe('250001')
      // 85% of the budget, rounded.
      expect(describedBy(budgetField('GPT Next')))
        .toContain(`A chat on this model compacts at about ${tokens(212501)}.`)
    })

    it('says where a chat compacts by the maximum when the server holds a budget over it', async () => {
      await render({ model: { ...GPT, settings: { compactionInputBudget: 300000 } } })

      expect(budgetField('GPT Next').value).toBe('300000')
      // 85% of the maximum of 272,000.
      expect(describedBy(budgetField('GPT Next')))
        .toContain(`A chat on this model compacts at about ${tokens(231200)}.`)
    })

    it('saves a budget along with the level the model already has', async () => {
      const { onSettingsChange, show } = await render({
        model: { ...SONNET, settings: { reasoning: 'high' } },
      })
      await type(budgetField(), ' 150000 ')

      await click(saveBudget())

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({
        reasoning: 'high', compactionInputBudget: 150000,
      })
      // The field goes back to the server's value, and the re-read is what changes it.
      expect(budgetField().value).toBe('')

      await show({ model: { ...SONNET, settings: { reasoning: 'high', compactionInputBudget: 150000 } } })

      expect(budgetField().value).toBe('150000')
    })

    it('saves on Enter in the field', async () => {
      const { onSettingsChange } = await render({ model: SONNET })
      await type(budgetField(), '150000')

      await pressEnter(budgetField())

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 150000 })
    })

    it.each<[string, GatewayModelSettings, GatewayModelSettings]>([
      ['leaving the level', { reasoning: 'high', compactionInputBudget: 150000 }, { reasoning: 'high' }],
      ['leaving nothing', { compactionInputBudget: 150000 }, {}],
    ])('resets to the built-in budget, %s, and moves focus to the field', async (_case, settings, sent) => {
      const { onSettingsChange } = await render({ model: { ...SONNET, settings } })
      await type(budgetField(), '160000')

      await click(resetBudget())

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith(sent)
      expect(Object.keys(onSettingsChange.mock.calls[0][0])).toEqual(Object.keys(sent))
      expect(document.activeElement).toBe(budgetField())
      // What was typed is dropped for the server's value.
      expect(budgetField().value).toBe('150000')
    })

    it('offers Reset only while the model has a budget of its own', async () => {
      const { show } = await render({ model: { ...SONNET, settings: { compactionInputBudget: 150000 } } })
      expect(resetBudget().disabled).toBe(false)

      await show({ model: SONNET })

      expect(() => resetBudget()).toThrow('No button')
      expect(budgetField().value).toBe('')
    })

    it('goes back to the built-in budget when a blank field is saved', async () => {
      const { onSettingsChange } = await render({
        model: { ...SONNET, settings: { reasoning: 'low', compactionInputBudget: 150000 } },
      })
      await type(budgetField(), '  ')

      await click(saveBudget())

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ reasoning: 'low' })
    })

    it.each([
      ['the budget the model has', { compactionInputBudget: 150000 }, '150000'],
      ['no budget where the model has none', undefined, ''],
    ])('sends nothing when %s is saved', async (_case, settings, typed) => {
      const { onSettingsChange } = await render({ model: { ...SONNET, settings } })
      await type(budgetField(), typed)

      await click(saveBudget())

      expect(onSettingsChange).not.toHaveBeenCalled()
      expect(budgetField().getAttribute('aria-invalid')).toBe('false')
    })

    it.each([
      ['a fraction', '1500.5'],
      ['zero', '0'],
      ['a negative number', '-150000'],
      ['a number with a unit', '150k'],
    ])('refuses %s without sending it, and points at the field', async (_case, typed) => {
      const { onSettingsChange } = await render({ model: SONNET })
      await type(budgetField(), typed)

      await click(saveBudget())

      expect(onSettingsChange).not.toHaveBeenCalled()
      expect(budgetField().getAttribute('aria-invalid')).toBe('true')
      expect(describedBy(budgetField())).toContain(
        'Enter a positive whole number of tokens, or leave this blank for the built-in budget')
      expect(document.activeElement).toBe(budgetField())
      // Landing on the field announces the error that describes it.
      expect(alerts()).toEqual([])
      expect(budgetField().value).toBe(typed)
    })

    it('refuses a budget over the maximum without sending it, and takes the maximum itself', async () => {
      const { onSettingsChange } = await render({ model: GPT })
      await type(budgetField('GPT Next'), '272001')

      await click(saveBudget('GPT Next'))

      expect(onSettingsChange).not.toHaveBeenCalled()
      expect(budgetField('GPT Next').getAttribute('aria-invalid')).toBe('true')
      expect(describedBy(budgetField('GPT Next'))).toContain(`Enter at most ${tokens(272000)}`)
      expect(document.activeElement).toBe(budgetField('GPT Next'))

      await type(budgetField('GPT Next'), '272000')
      expect(budgetField('GPT Next').getAttribute('aria-invalid')).toBe('false')
      await click(saveBudget('GPT Next'))

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 272000 })
    })

    // Focus can't announce an error on the field it is already in.
    it.each<[string, AdminModelView, string, string]>([
      ['what is no number of tokens', SONNET, '150k',
        'Enter a positive whole number of tokens, or leave this blank for the built-in budget'],
      ['a budget over the maximum', GPT, '272001', `Enter at most ${tokens(272000)}`],
    ])('says the error aloud when Enter in the field is refused %s', async (_case, model, typed, error) => {
      const { onSettingsChange } = await render({ model })
      const field = budgetField(model.name)
      await act(async () => { field.focus() })
      await type(field, typed)

      await pressEnter(field)

      expect(onSettingsChange).not.toHaveBeenCalled()
      expect(document.activeElement).toBe(field)
      expect(alerts()).toEqual([error])

      await type(field, '150000')
      expect(alerts()).toEqual([])
      await pressEnter(field)

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 150000 })
      expect(alerts()).toEqual([])
    })

    it('stops saying a refused budget once the budget is reset', async () => {
      const { onSettingsChange } = await render({
        model: { ...SONNET, settings: { compactionInputBudget: 150000 } },
      })
      await act(async () => { budgetField().focus() })
      await type(budgetField(), '150k')
      await pressEnter(budgetField())
      expect(alerts()).toHaveLength(1)

      await click(resetBudget())

      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({})
      expect(alerts()).toEqual([])
    })

    it('warns about a budget under 100,000 tokens, which it still saves', async () => {
      const { onSettingsChange } = await render({ model: SONNET })
      expect(describedBy(budgetField())).not.toContain(SMALL_BUDGET_WARNING)

      await type(budgetField(), '100000')
      expect(describedBy(budgetField())).not.toContain(SMALL_BUDGET_WARNING)

      await type(budgetField(), '99999')
      expect(describedBy(budgetField())).toContain(SMALL_BUDGET_WARNING)
      // Read with the field, and not spoken while the budget is being typed.
      const warning = Array.from(document.body.querySelectorAll('p'))
        .find((p) => p.textContent === SMALL_BUDGET_WARNING)
      expect(warning).toBeDefined()
      expect(warning!.closest('[role="status"], [role="alert"], [aria-live]')).toBeNull()

      await click(saveBudget())
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 99999 })
    })

    it('warns about a small budget the server holds, and not about what can’t be saved', async () => {
      await render({ model: { ...SONNET, settings: { compactionInputBudget: 50000 } } })
      expect(describedBy(budgetField())).toContain(SMALL_BUDGET_WARNING)

      await type(budgetField(), '50000.5')
      expect(describedBy(budgetField())).not.toContain(SMALL_BUDGET_WARNING)
    })

    it('offers no budget for a model whose window leaves a prompt no room', async () => {
      await render({ model: { ...SONNET, builtInCompactionInputBudget: 0, maxCompactionInputBudget: 0 } })

      expect(levelSelect().textContent).toBe('Deployment default (built-in: Adaptive)')
      expect(() => budgetField()).toThrow('No budget field')
      expect(buttons()).not.toContain('Save the compaction budget of Claude Sonnet')
    })
  })

  describe('an added model that behaves like another', () => {
    const LIKE_SONNET: AdminModelView = { ...ADDED, behavesLike: 'claude-sonnet', behavesLikeKnown: true }

    it('says nothing of it for a model that behaves like none', async () => {
      await render({ model: ADDED, removable: true }, { collapsed: true })

      expect(behavesLikeLine()).toEqual([])
    })

    it('names the model by its catalog name while the choice is used', async () => {
      await render(
        { model: LIKE_SONNET, behavesLikeName: 'Claude Sonnet', removable: true }, { collapsed: true })

      expect(behavesLikeLine()).toEqual(['Behaves like Claude Sonnet'])
    })

    it('names a model the catalog doesn’t list by its ID', async () => {
      await render(
        { model: { ...LIKE_SONNET, behavesLike: 'claude-preview' }, removable: true },
        { collapsed: true })

      expect(behavesLikeLine()).toEqual(['Behaves like claude-preview'])
    })

    it('says the choice is not used once this version knows the model itself', async () => {
      await render(
        { model: { ...LIKE_SONNET, runtimeKnown: true }, behavesLikeName: 'Claude Sonnet', removable: true },
        { collapsed: true })

      expect(behavesLikeLine())
        .toEqual(['Behaves like Claude Sonnet. Not used: this version knows this model itself.'])
    })

    it('says the choice is not used also when this version no longer knows the other model', async () => {
      await render(
        {
          model: { ...LIKE_SONNET, runtimeKnown: true, behavesLike: 'claude-retired', behavesLikeKnown: false },
          removable: true,
        },
        { collapsed: true })

      expect(behavesLikeLine())
        .toEqual(['Behaves like claude-retired. Not used: this version knows this model itself.'])
    })

    it('says nothing is borrowed from a model this version no longer knows', async () => {
      await render(
        { model: { ...LIKE_SONNET, behavesLike: 'claude-retired', behavesLikeKnown: false }, removable: true },
        { collapsed: true })

      expect(behavesLikeLine()).toEqual([
        'Behaves like claude-retired. This version no longer knows that model, so nothing is borrowed.',
      ])
    })
  })

  describe('the test', () => {
    it('is run from a button named after the model, without the settings being opened', async () => {
      const { onTest, onModeChange, onSettingsChange } = await render({ model: SONNET }, { collapsed: true })
      const disclosure = button('Settings for Claude Sonnet')

      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
      expect(testButton().textContent).toBe('Test')
      expect(testButton().getAttribute('aria-label')).toBe('Test Claude Sonnet')
      expect(testButton().disabled).toBe(false)
      expect(testButton().getAttribute('aria-disabled')).toBe('false')
      // Among the row's controls: after the modes, and before the disclosure.
      const modes = Array.from(document.body.querySelectorAll<HTMLElement>('[role="radio"]'))
      expect(modes).toHaveLength(3)
      expect(follows(modes[2], testButton())).toBe(true)
      expect(follows(testButton(), disclosure)).toBe(true)

      await click(testButton())

      expect(onTest).toHaveBeenCalledExactlyOnceWith()
      expect(onModeChange).not.toHaveBeenCalled()
      expect(onSettingsChange).not.toHaveBeenCalled()
      expect(disclosure.getAttribute('aria-expanded')).toBe('false')
    })

    it('stays outside the settings when they are open', async () => {
      await render({ model: SONNET })
      const settings = document.getElementById(
        button('Settings for Claude Sonnet').getAttribute('aria-controls')!)!

      expect(settings.contains(levelSelect())).toBe(true)
      expect(settings.contains(testButton())).toBe(false)
      expect(settings.contains(testStatus())).toBe(false)
    })

    it('comes before Remove in the row of a model that can be removed', async () => {
      const { onTest, onRemove } = await render({ model: ADDED, removable: true }, { collapsed: true })

      expect(testButton('Claude Next').getAttribute('aria-label')).toBe('Test Claude Next')
      expect(follows(testButton('Claude Next'), button('Remove Claude Next'))).toBe(true)

      await click(testButton('Claude Next'))

      expect(onTest).toHaveBeenCalledOnce()
      expect(onRemove).not.toHaveBeenCalled()
    })

    it.each<GatewayModelMode>(['hidden', 'disabled'])('is offered for a %s model', async (mode) => {
      const { onTest } = await render({ model: { ...SONNET, mode } }, { collapsed: true })

      expect(testButton().disabled).toBe(false)
      expect(testButton().getAttribute('aria-disabled')).toBe('false')
      expect(testStatus().childNodes).toHaveLength(0)

      await click(testButton())

      expect(onTest).toHaveBeenCalledOnce()
    })

    it('is not locked while a write is in flight', async () => {
      const { onTest } = await render({ model: SONNET, busy: true, removable: true })

      // The controls that write are.
      expect(levelSelect().disabled).toBe(true)
      expect(button('Remove Claude Sonnet').disabled).toBe(true)
      expect(testButton().disabled).toBe(false)
      expect(testButton().getAttribute('aria-disabled')).toBe('false')

      await click(testButton())

      expect(onTest).toHaveBeenCalledOnce()
    })

    it('says that it is in flight on the button, which keeps focus and is not disabled', async () => {
      const { show } = await render({ model: SONNET }, { collapsed: true })
      const pressed = testButton()
      const region = testStatus()
      await act(async () => { pressed.focus() })

      await show({ model: SONNET, test: { state: 'testing' } })

      expect(testButton()).toBe(pressed)
      expect(pressed.textContent).toBe('Testing…')
      expect(pressed.getAttribute('aria-label')).toBe('Testing Claude Sonnet…')
      expect(pressed.getAttribute('aria-disabled')).toBe('true')
      // A browser takes focus from a button that is disabled, which jsdom does not.
      expect(pressed.disabled).toBe(false)
      expect(document.activeElement).toBe(pressed)
      expect(region.childNodes).toHaveLength(0)

      await show({ model: SONNET, test: answered({ model: 'claude-sonnet', ok: true }) })

      expect(testButton()).toBe(pressed)
      expect(pressed.textContent).toBe('Test')
      expect(pressed.getAttribute('aria-label')).toBe('Test Claude Sonnet')
      expect(pressed.getAttribute('aria-disabled')).toBe('false')
      expect(document.activeElement).toBe(pressed)
      // The region that was there all along is the one that says the result.
      expect(testStatus()).toBe(region)
      expect(region.textContent).toBe('Answered through the gateway.')
    })

    it('has an empty status region before any test, on a line above the disclosure', async () => {
      await render({ model: SONNET }, { collapsed: true })
      const disclosure = button('Settings for Claude Sonnet')

      expect(testStatus().childNodes).toHaveLength(0)
      expect(follows(testButton(), testStatus())).toBe(true)
      expect(follows(testStatus(), disclosure)).toBe(true)
      // On a full-width line of its own. jsdom lays nothing out, so the line is known by its class.
      expect(testStatus().parentElement!.className.split(' ')).toContain('basis-full')
      expect(testStatus().parentElement!.contains(testButton())).toBe(false)
    })

    it.each<[string, GatewayTestState, string[]]>([
      // The row is the model, so a pass does not name it again.
      ['a pass', answered({ model: 'claude-sonnet', ok: true }), ['Answered through the gateway.']],
      [
        'a failure with a status',
        answered({ model: 'claude-sonnet', ok: false, status: 500, message: 'The server had an error.' }),
        ['Failed (500): The server had an error.'],
      ],
      [
        'a failure without a status',
        answered({ model: 'claude-sonnet', ok: false, message: 'API key not valid.' }),
        ['Failed: API key not valid.'],
      ],
      [
        'a 401, with what it may mean',
        answered({ model: 'claude-sonnet', ok: false, status: 401, message: 'invalid x-api-key' }),
        ['Failed (401): invalid x-api-key', AUTH_HINT],
      ],
      [
        'a 403, with what it may mean',
        answered({ model: 'claude-sonnet', ok: false, status: 403, message: 'Forbidden' }),
        ['Failed (403): Forbidden', AUTH_HINT],
      ],
      [
        'a test that could not be run, with the reason',
        { state: 'not-run', reason: 'No such model: claude-sonnet' },
        ['Couldn’t run the test: No such model: claude-sonnet'],
      ],
      [
        'a test that could not be run, without one',
        { state: 'not-run', reason: undefined },
        ['Couldn’t run the test.'],
      ],
    ])('reports %s in the status region', async (_case, test, expected) => {
      const { show } = await render({ model: SONNET }, { collapsed: true })
      const region = testStatus()

      await show({ model: SONNET, test })

      expect(testStatus()).toBe(region)
      expect(testSaid()).toEqual(expected)
      expect(testButton().textContent).toBe('Test')
    })

    it('empties the status region when the test is forgotten', async () => {
      const { show } = await render(
        { model: SONNET, test: answered({ model: 'claude-sonnet', ok: true }) }, { collapsed: true })
      expect(testSaid()).toEqual(['Answered through the gateway.'])

      await show({ model: SONNET })

      expect(testStatus().childNodes).toHaveLength(0)
    })
  })

  describe('while a write is in flight', () => {
    it('locks the settings, and unlocks them afterwards', async () => {
      const model: AdminModelView = { ...SONNET, settings: { compactionInputBudget: 150000 } }
      const { onSettingsChange, show } = await render({ model })
      await type(budgetField(), '160000')

      await show({ model, busy: true })

      expect(levelSelect().disabled).toBe(true)
      expect(budgetField().disabled).toBe(true)
      expect(saveBudget().disabled).toBe(true)
      expect(resetBudget().disabled).toBe(true)
      await pressEnter(budgetField())
      expect(onSettingsChange).not.toHaveBeenCalled()

      await show({ model })

      expect(levelSelect().disabled).toBe(false)
      expect(budgetField().disabled).toBe(false)
      expect(saveBudget().disabled).toBe(false)
      expect(resetBudget().disabled).toBe(false)
      // What was typed is still there to save.
      await pressEnter(budgetField())
      expect(onSettingsChange).toHaveBeenCalledExactlyOnceWith({ compactionInputBudget: 160000 })
    })
  })
})
