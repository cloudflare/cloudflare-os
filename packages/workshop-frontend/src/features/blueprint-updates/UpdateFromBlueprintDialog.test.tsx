// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactElement, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  ApplyBlueprintResult,
  AuthenticatedApi,
  BlueprintLibrarySummary,
  BlueprintPublicInfo,
  BlueprintUserSummary,
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

  return { Banner, Dialog, Loader: () => <span>Loading</span>, Radio }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => { resolve = resolvePromise })
  return { promise, resolve }
}

const applyBlueprint = vi.fn<GadgetClient['applyBlueprint']>()
const getBlueprint = vi.fn<(id: string) => Promise<BlueprintPublicInfo | null>>()
const listModels = vi.fn<() => Promise<AiChatAuthorInfo[]>>()
const listOwnBlueprints = vi.fn<() => Promise<BlueprintUserSummary[]>>()
const listLibraryBlueprints = vi.fn<() => Promise<BlueprintLibrarySummary[]>>()
const listFeaturedBlueprints = vi.fn<() => Promise<BlueprintPublicInfo[]>>()
const onClose = vi.fn<() => void>()
const onProposed = vi.fn<(chatId: number) => void>()

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  listModels.mockResolvedValue([OPUS, SONNET])
  getBlueprint.mockImplementation(async id =>
    id === 'trip' ? published('trip', 'Trip planner', 'release-2') : null)
  listOwnBlueprints.mockResolvedValue([])
  listLibraryBlueprints.mockResolvedValue([])
  listFeaturedBlueprints.mockResolvedValue([published('budget', 'Budget tracker', 'release-9')])
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
        authenticatedApi={{
          listOwnBlueprints, listLibraryBlueprints, listFeaturedBlueprints,
        } as unknown as RpcStub<AuthenticatedApi>}
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
  if (!label) throw new Error(`No "${title}" blueprint in: ${container.textContent}`)
  return label.querySelector('input')!
}

async function pasteLink(link: string) {
  const input = container.querySelector<HTMLInputElement>('[aria-label="Blueprint link"]')!
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, link)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

const bannerText = () => container.querySelector('[data-testid="banner"]')?.textContent ?? null

describe('UpdateFromBlueprintDialog', () => {
  it('starts on the blueprint the gadget follows and opens its update in a new chat', async () => {
    localStorage.setItem('lastSelectedModel', 'sonnet')
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)

    expect(radio('Trip planner').checked).toBe(true)
    expect(radio('Trip planner').closest('label')!.textContent).toContain('Update available')
    expect(radio('Budget tracker').checked).toBe(false)

    await click('Update')

    // The model is the one a new chat would start on, which is where the proposal lands.
    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: 'sonnet' })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(7)
  })

  it('names no model when the user has chosen to chat with no agent', async () => {
    localStorage.setItem('lastSelectedModel', NO_AGENT_OPTION_VALUE)
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 7 })

    await open(TRIP_UPSTREAM)
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('trip', { modelId: null })
  })

  it('switches the gadget to another blueprint the user picks', async () => {
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 8 })

    await open(TRIP_UPSTREAM)
    await act(async () => { radio('Budget tracker').click() })
    await click('Update')

    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('budget', { modelId: 'opus' })
    expect(onProposed).toHaveBeenCalledExactlyOnceWith(8)
  })

  it('offers a blueprint from a pasted link, and nothing to apply before one is chosen', async () => {
    getBlueprint.mockImplementation(async id =>
      id === 'shared' ? published('shared', 'Shared itinerary', 'release-5') : null)
    applyBlueprint.mockResolvedValue({ outcome: 'proposed', chatId: 9 })

    await open(undefined)
    expect(button('Update').disabled).toBe(true)

    await pasteLink('https://gadgets.example/blueprint/missing')
    expect(container.textContent).toContain('No blueprint was found at that link.')
    expect(button('Update').disabled).toBe(true)

    await pasteLink('https://gadgets.example/blueprint/shared')
    expect(radio('Shared itinerary').checked).toBe(true)

    await click('Update')
    expect(applyBlueprint).toHaveBeenCalledExactlyOnceWith('shared', { modelId: 'opus' })
  })

  it('warns before merging an unrelated blueprint, and guesses a base only once confirmed', async () => {
    applyBlueprint.mockResolvedValueOnce({ outcome: 'unrelated' })
    applyBlueprint.mockResolvedValueOnce({ outcome: 'proposed', chatId: 11 })

    await open(TRIP_UPSTREAM)
    await act(async () => { radio('Budget tracker').click() })
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
    await click('Update')
    await click('Back')

    expect(applyBlueprint).toHaveBeenCalledTimes(1)
    expect(radio('Trip planner').checked).toBe(true)
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

  it('says that the followed blueprint is gone, and lets the user pick another', async () => {
    getBlueprint.mockResolvedValue(null)

    await open(TRIP_UPSTREAM)

    expect(container.textContent).toContain('The blueprint this gadget follows is no longer available.')
    expect(button('Update').disabled).toBe(true)

    await act(async () => { radio('Budget tracker').click() })
    expect(button('Update').disabled).toBe(false)
  })

  it('can reload the blueprints after failing to', async () => {
    listFeaturedBlueprints.mockRejectedValueOnce(new Error('KV unavailable'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    await open(TRIP_UPSTREAM)
    expect(bannerText()).toContain('Your blueprints could not be loaded')

    await click('Try again')

    expect(radio('Trip planner').checked).toBe(true)
    consoleError.mockRestore()
  })
})
