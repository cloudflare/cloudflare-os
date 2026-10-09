// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  ApplyBlueprintResult,
  BlueprintPublicInfo,
  GadgetClient,
  GadgetUpstream,
  Overseer,
  PublicApi,
} from '@gadgets/workshop-shared/api'
import { NO_AGENT_OPTION_VALUE } from '../../modelSelection'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', async () => {
  const { createContext, useContext } = await import('react')

  const Dialog = Object.assign(
    ({ children }: { children: ReactNode }) => <dialog open>{children}</dialog>,
    {
      Root: ({ children, onOpenChange }: {
        children: ReactNode
        onOpenChange: (open: boolean) => void
      }) => (
        <>
          <button type="button" onClick={() => onOpenChange(false)}>dismiss dialog</button>
          {children}
        </>
      ),
      Title: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
      Description: ({ children }: { children: ReactNode }) => <p>{children}</p>,
      Close: ({ render }: { render: (props: object) => ReactElement }) =>
        render({ 'aria-label': 'Close' }),
    },
  )

  const RadioContext = createContext<{ value: string; onValueChange: (value: string) => void }>(
    { value: '', onValueChange: () => {} },
  )
  const Radio = {
    Group: ({ children, value, onValueChange, disabled }: {
      children: ReactNode
      value: string
      onValueChange: (value: string) => void
      disabled?: boolean
    }) => (
      <RadioContext.Provider value={{ value, onValueChange }}>
        <fieldset disabled={disabled}>{children}</fieldset>
      </RadioContext.Provider>
    ),
    Legend: ({ children }: { children: ReactNode }) => <legend>{children}</legend>,
    Item: ({ value, label, description }: {
      value: string
      label: ReactNode
      description?: ReactNode
    }) => {
      const group = useContext(RadioContext)
      return (
        <label>
          <input
            type="radio"
            checked={group.value === value}
            onChange={() => group.onValueChange(value)}
          />
          <span data-testid="blueprint-title">{label}</span>
          <span>{description}</span>
        </label>
      )
    },
  }

  const Banner = Object.assign(
    ({ title, description, action }: {
      title?: string
      description?: ReactNode
      action?: ReactNode
    }) => (
      <div data-testid="banner">
        <strong>{title}</strong>
        <span>{description}</span>
        {action}
      </div>
    ),
    {
      Action: (props: ComponentProps<'button'>) => <button type="button" {...props} />,
    },
  )

  const Select = Object.assign(
    ({ children, label, value, onValueChange, disabled }: {
      children: ReactNode
      label: string
      value: string
      onValueChange: (value: string) => void
      disabled?: boolean
    }) => (
      <select
        aria-label={label}
        value={value}
        onChange={event => onValueChange(event.target.value)}
        disabled={disabled}
      >
        {children}
      </select>
    ),
    {
      Option: ({ children, value }: { children: ReactNode; value: string }) =>
        <option value={value}>{children}</option>,
    },
  )

  return { Banner, Dialog, Loader: () => <span>Loading</span>, Radio, Select }
})

vi.mock('@phosphor-icons/react', () => ({ X: () => <span>close</span> }))

vi.mock('../../components/WorkshopControls', () => ({
  WorkshopButton: ({ children, tone: _tone, ...props }: ComponentProps<'button'> & { tone?: string }) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopIconButton: ({ children, ...props }: ComponentProps<'button'>) => (
    <button type="button" {...props}>{children}</button>
  ),
  WorkshopInput: (props: ComponentProps<'input'>) => <input {...props} />,
}))

import { UpdateFromBlueprintDialog } from './UpdateFromBlueprintDialog'

const OPUS: AiChatAuthorInfo = { type: 'agent', id: 'opus', name: 'Opus' }
const SONNET: AiChatAuthorInfo = { type: 'agent', id: 'sonnet', name: 'Sonnet' }

const TRIP_UPSTREAM: GadgetUpstream = { blueprintId: 'trip', commitId: 'release-1' }

const published = (id: string, title: string, commitId?: string): BlueprintPublicInfo => ({
  id,
  metadata: {
    title,
    description: '',
    author: { type: 'user', id: 'alice@example.com', name: 'Alice' },
    created: new Date(0),
    version: 2,
    lastUpdated: new Date(0),
    bindings: {},
    ...(commitId === undefined ? {} : { commitId }),
  },
})

const BLUEPRINTS = [
  published('trip', 'Trip planner', 'release-2'),
  published('budget', 'Budget tracker', 'release-9'),
]

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

const applyBlueprint = vi.fn<GadgetClient['applyBlueprint']>()
const getBlueprint = vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>()
const listModels = vi.fn<() => Promise<AiChatAuthorInfo[]>>()
const onClose = vi.fn<() => void>()
const onProposed = vi.fn<(chatId: number) => void>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  listModels.mockResolvedValue([OPUS, SONNET])
  getBlueprint.mockImplementation(async id => BLUEPRINTS.find(blueprint => blueprint.id === id) ?? null)
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
})

async function open(upstream?: GadgetUpstream) {
  await act(async () => {
    root.render(
      <UpdateFromBlueprintDialog
        gadget={{
          title: 'My trips',
          upstream,
          client: { applyBlueprint } as unknown as RpcStub<GadgetClient>,
        }}
        overseer={{ listModels } as unknown as RpcStub<Overseer>}
        publicApi={{ getBlueprint } as unknown as RpcStub<PublicApi>}
        onClose={onClose}
        onProposed={onProposed}
      />,
    )
  })
}

function button(name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll('button')]
    .find(candidate => candidate.textContent === name)
  if (!found) throw new Error(`No "${name}" button in: ${container.textContent}`)
  return found
}

async function click(name: string) {
  await act(async () => { button(name).click() })
}

function radio(title: string): HTMLInputElement {
  const label = [...container.querySelectorAll('label')].find(candidate =>
    candidate.querySelector('[data-testid="blueprint-title"]')?.textContent === title)
  if (!label) throw new Error(`No "${title}" option in: ${container.textContent}`)
  return label.querySelector('input')!
}

const FOLLOWED = 'Update from Trip planner'
const SWITCH = 'Advanced: Switch blueprints'

const referenceInput = () =>
  container.querySelector<HTMLInputElement>('[aria-label="Blueprint ID or link"]')

async function paste(text: string) {
  const input = referenceInput()!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function switchTo(text: string) {
  await act(async () => { radio(SWITCH).click() })
  await paste(text)
}

const reviewerSelect = () =>
  container.querySelector<HTMLSelectElement>('select[aria-label="Reviewing agent"]')!

async function pickReviewer(value: string) {
  const select = reviewerSelect()
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value)
    select.dispatchEvent(new Event('change', { bubbles: true }))
  })
}

const bannerText = () => container.querySelector('[data-testid="banner"]')?.textContent ?? null

describe('UpdateFromBlueprintDialog', () => {
  it('starts on the blueprint the gadget follows and opens its update in a new chat', async () => {
    localStorage.setItem('lastSelectedModel', 'sonnet')
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)

    expect(radio(FOLLOWED).checked).toBe(true)
    expect(radio(FOLLOWED).closest('label')!.textContent).toContain('Update available')
    expect(radio(SWITCH).checked).toBe(false)
    expect(referenceInput()).toBeNull()

    await click('Update')

    // The model is the one a new chat would start on, which is where the proposal lands.
    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: 'sonnet' })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(7)
  })

  // A gadget made before gadgets recorded the release they took names its blueprint alone.
  it('starts on the followed blueprint, with no status, when the release taken is unknown', async () => {
    await open({ blueprintId: 'trip' })

    expect(radio(FOLLOWED).checked).toBe(true)
    const description = radio(FOLLOWED).closest('label')!.textContent
    expect(description).toContain('Version 2')
    expect(description).not.toContain('Update available')
    expect(description).not.toContain('Up to date')
  })

  it('names no model when the user has chosen to chat with no agent', async () => {
    localStorage.setItem('lastSelectedModel', NO_AGENT_OPTION_VALUE)
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: null })
  })

  it('starts the reviewer on the model a new chat would, and lets the user pick another', async () => {
    localStorage.setItem('lastSelectedModel', 'sonnet')
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)
    expect(reviewerSelect().value).toBe('sonnet')
    expect([...reviewerSelect().options].map(option => option.textContent))
      .toEqual(['Opus', 'Sonnet', 'No agent'])

    await pickReviewer('opus')
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: 'opus' })
    // Like the composer's selector, the pick carries over to the next chat.
    expect(localStorage.getItem('lastSelectedModel')).toBe('opus')
  })

  it('reviews with no agent when the user picks none', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)
    await pickReviewer(NO_AGENT_OPTION_VALUE)
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: null })
  })

  it('switches the gadget to another blueprint named by its id', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 8 })

    await open(TRIP_UPSTREAM)
    await act(async () => { radio(SWITCH).click() })
    // Nothing is named yet, and the followed blueprint is no longer what Update would apply.
    expect(button('Update').disabled).toBe(true)

    await paste('budget')
    expect(container.textContent).toContain('Budget tracker')
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('budget', { modelId: 'opus' })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(8)
  })

  it('goes back to the followed blueprint when the user unselects switching', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 8 })

    await open(TRIP_UPSTREAM)
    await switchTo('budget')
    await act(async () => { radio(FOLLOWED).click() })
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: 'opus' })
  })

  it('asks for a blueprint by id or link when the gadget follows none known', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 9 })

    await open(undefined)
    expect(container.querySelector('input[type="radio"]')).toBeNull()
    expect(button('Update').disabled).toBe(true)

    await paste('my blueprint')
    expect(container.textContent).toContain('That is not a blueprint ID or link.')

    await paste('https://gadgets.example/blueprint/missing')
    expect(container.textContent).toContain('No blueprint was found with that ID.')
    expect(button('Update').disabled).toBe(true)

    await paste('https://gadgets.example/blueprint/budget')
    await click('Update')
    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('budget', { modelId: 'opus' })
  })

  it('warns before merging an unrelated blueprint, and guesses a base only once confirmed', async () => {
    applyBlueprint.mockResolvedValueOnce({ outcome: 'unrelated' })
    applyBlueprint.mockResolvedValueOnce({ outcome: 'proposed', chatId: 11 })

    await open(TRIP_UPSTREAM)
    await switchTo('budget')
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('budget', { modelId: 'opus' })
    expect(container.textContent).toContain('This gadget shares no history with Budget tracker.')
    expect(bannerText()).toContain('Your own changes may be undone')
    expect(onProposed).not.toHaveBeenCalled()

    await click('Update anyway')

    expect(applyBlueprint).toHaveBeenLastCalledWith('budget', { modelId: 'opus', allowUnrelated: true })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(11)
  })

  it('applies nothing when the user backs out of the unrelated-blueprint warning', async () => {
    applyBlueprint.mockResolvedValueOnce({ outcome: 'unrelated' })

    await open(TRIP_UPSTREAM)
    await switchTo('budget')
    await click('Update')
    await click('Back')

    expect(applyBlueprint).toHaveBeenCalledTimes(1)
    expect(radio(SWITCH).checked).toBe(true)
    expect(referenceInput()!.value).toBe('budget')
    expect(bannerText()).toBeNull()
  })

  it('says so when the gadget already has the blueprint\'s latest version', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'upToDate' })

    await open(TRIP_UPSTREAM)
    await click('Update')

    expect(bannerText()).toContain('This gadget already has the latest version of Trip planner.')
    expect(onProposed).not.toHaveBeenCalled()
  })

  it('says so when the version the two share has no files to merge against', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'baseUnavailable' })

    await open(TRIP_UPSTREAM)
    await click('Update')

    expect(bannerText()).toContain('its files are not available to merge against')
    expect(onProposed).not.toHaveBeenCalled()
  })

  it('offers to try again when the gadget changed while the update was being prepared', async () => {
    const gadgetChanged =
      'The gadget changed while the blueprint was being applied; please retry.'
    applyBlueprint.mockRejectedValueOnce(new Error(gadgetChanged))
    applyBlueprint.mockResolvedValueOnce({ outcome: 'proposed', chatId: 12 })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await open(TRIP_UPSTREAM)
    await click('Update')

    expect(bannerText()).toContain(gadgetChanged)
    expect(onProposed).not.toHaveBeenCalled()

    await click('Try again')

    expect(applyBlueprint).toHaveBeenCalledTimes(2)
    expect(applyBlueprint).toHaveBeenLastCalledWith('trip', { modelId: 'opus' })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(12)
    consoleError.mockRestore()
  })

  // Otherwise a proposal that arrives after the dialog was dismissed would pull the user into a
  // chat they did not ask to open.
  it('cannot be dismissed while an update is being prepared', async () => {
    const pending = deferred<ApplyBlueprintResult>()
    applyBlueprint.mockReturnValue(pending.promise)

    await open(TRIP_UPSTREAM)
    await click('Update')
    await click('dismiss dialog')

    expect(onClose).not.toHaveBeenCalled()
    expect(button('Cancel').disabled).toBe(true)

    await act(async () => { pending.resolve({ outcome: 'upToDate' }) })
    await click('dismiss dialog')

    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('says that the followed blueprint is gone, and lets the user name another', async () => {
    getBlueprint.mockImplementation(async id =>
      id === 'budget' ? BLUEPRINTS[1] : null)

    await open(TRIP_UPSTREAM)

    expect(container.textContent).toContain('The blueprint this gadget follows is no longer available')
    expect(button('Update').disabled).toBe(true)

    await paste('budget')
    expect(button('Update').disabled).toBe(false)
  })

  it('can reload the followed blueprint after failing to', async () => {
    getBlueprint.mockRejectedValueOnce(new Error('KV unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await open(TRIP_UPSTREAM)
    expect(bannerText()).toContain('The blueprint could not be loaded')

    await click('Try again')

    expect(radio(FOLLOWED).checked).toBe(true)
    consoleError.mockRestore()
  })
})
