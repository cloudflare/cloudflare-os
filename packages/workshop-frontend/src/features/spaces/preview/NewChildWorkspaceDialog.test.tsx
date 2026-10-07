// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  BlueprintPublicInfo,
  CollaboratorRole,
  OutputFormatOffer,
  PublicApi,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { RpcContext } from '../../../RpcContext'
import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  mountRouted,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import { NewChildWorkspaceDialog } from './NewChildWorkspaceDialog'

const DAY = new Date('2026-09-01T00:00:00Z')

const entry = (id: string, title: string, extra: Partial<SpaceWorkspaceInfo> = {}): SpaceWorkspaceInfo =>
  ({ id, title, owner: ME, created: DAY, ...extra })

const HANDBOOK = entry('w-handbook', 'Handbook', { published: 'use' })
const DRAFTS = entry('w-drafts', 'Drafts')
const ARCHIVE = entry('w-archive', 'Archive', { parentId: 'w-drafts', published: 'use', hiddenBy: 'w-drafts' })
const LISTING = [HANDBOOK, DRAFTS, ARCHIVE]

const format = (blueprintId: string, noun: string, extra: Partial<OutputFormatOffer> = {}): OutputFormatOffer => ({
  blueprintId,
  output: { id: blueprintId, noun, plural: `${noun}s`, icon: 'fileText' },
  description: `A ${noun.toLowerCase()}.`,
  requiresSetup: false,
  ...extra,
})

const NOTE = format('bp-note', 'Note')
const BOARD = format('bp-board', 'Board')
const SYNCED = format('bp-synced', 'Synced sheet', { requiresSetup: true })

// What each blueprint declares it is published with; an Error makes reading it fail.
type Declared = Record<string, CollaboratorRole | null | Error>

const blueprint = (publication: CollaboratorRole | null): BlueprintPublicInfo => ({
  id: 'bp',
  metadata: {
    title: 'Blueprint',
    description: '',
    author: ME,
    created: DAY,
    version: 1,
    lastUpdated: DAY,
    bindings: {},
    ...(publication && { publication }),
  },
})

type Props = Omit<Parameters<typeof NewChildWorkspaceDialog>[0], 'onClose' | 'onCreated'>

const render = async (props: Props, {
  formats = [NOTE, BOARD, SYNCED],
  listOutputFormats = async (): Promise<OutputFormatOffer[]> => formats,
  declared = { 'bp-note': 'use', 'bp-board': null, 'bp-synced': null } as Declared,
  created = async (): Promise<{ id: string }> => ({ id: 'w-new' }),
} = {}) => {
  const dispose = vi.fn<() => void>()
  const newGadgetFromBlueprint = vi.fn<(id: string, bindings: object, options: object) => unknown>(() => ({
    getMetadata: created,
    [Symbol.dispose]: dispose,
  }))
  const getBlueprint = vi.fn<(id: string) => Promise<BlueprintPublicInfo>>(async (id) => {
    const publication = declared[id]
    if (publication instanceof Error) throw publication
    return blueprint(publication ?? null)
  })
  const onCreated = vi.fn<(workspaceId: string) => void>()
  const onClose = vi.fn<() => void>()
  const publicApi = { getBlueprint } as unknown as RpcStub<PublicApi>
  const Page = () => (
    <RpcContext.Provider value={{ stub: publicApi, connectionLost: false }}>
      <NewChildWorkspaceDialog {...props} onClose={onClose} onCreated={onCreated} />
    </RpcContext.Provider>
  )
  await mountRouted(fakeApi({ listOutputFormats, newGadgetFromBlueprint }), {
    at: '/workspaces',
    pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/workspaces', component: Page })],
  })
  await settle()
  return { newGadgetFromBlueprint, getBlueprint, dispose, onCreated, onClose }
}

const radios = () => [...document.body.querySelectorAll<HTMLElement>('[role="radio"]')]
// The radio whose label reads `name`.
const radio = (name: string) => {
  const found = radios().find(candidate => candidate.closest('label')?.textContent?.startsWith(name))
  if (!found) throw new Error(`No radio “${name}”`)
  return found
}
// Kumo's radios and checkboxes turn a click into one they build as a PointerEvent, which jsdom
// lacks, so the window has a stand-in for as long as the click takes.
const press = async (element: HTMLElement) => {
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await click(element)
  } finally {
    delete view.PointerEvent
  }
}
const checkbox = () => document.body.querySelector<HTMLElement>('[role="checkbox"]')
const dialogText = () => document.body.querySelector('[role="dialog"]')?.textContent ?? ''

const IN_DESIGN: Props = { spaceKey: 'design', parent: HANDBOOK, listing: LISTING }

describe('NewChildWorkspaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('offers the deployment’s formats, one needing setup shown but not to be chosen, the first chosen', async () => {
    await render(IN_DESIGN)

    expect(dialogText()).toContain('New child workspace')
    expect(dialogText()).toContain('Under “Handbook”.')
    expect(document.body.querySelector('fieldset legend, [role="radiogroup"]')).not.toBeNull()
    expect(radios()).toHaveLength(3)
    expect(radio('Note').getAttribute('aria-checked')).toBe('true')
    expect(radio('Synced sheet').getAttribute('aria-disabled') === 'true'
      || radio('Synced sheet').hasAttribute('data-disabled')).toBe(true)
    expect(dialogText()).toContain('Its connections have to be set up first, from its own page.')
  })

  it('says the formats are loading until they are, not that there are none', async () => {
    const list = deferred<OutputFormatOffer[]>()
    await render(IN_DESIGN, { listOutputFormats: () => list.promise })

    expect(document.body.querySelector('[role="dialog"] [role="status"]')?.textContent).toBe('Loading formats…')
    expect(dialogText()).not.toContain('There are no formats')
    expect(button('Create').disabled).toBe(true)

    await act(async () => list.resolve([NOTE]))
    await settle()
    expect(radios()).toHaveLength(1)
    expect(dialogText()).not.toContain('Loading formats…')
  })

  it('says when the formats could not be read, and reads them again when asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listOutputFormats = vi.fn<() => Promise<OutputFormatOffer[]>>()
      .mockRejectedValueOnce(new Error('Connection lost.'))
      .mockResolvedValue([NOTE])
    await render(IN_DESIGN, { listOutputFormats })

    expect(alerts()).toEqual([expect.stringContaining('Couldn’t load the formats.')])
    expect(dialogText()).not.toContain('There are no formats')
    expect(button('Create').disabled).toBe(true)

    await click(button('Try again'))
    await settle()
    expect(listOutputFormats).toHaveBeenCalledTimes(2)
    expect(alerts()).toEqual([])
    expect(radios()).toHaveLength(1)
  })

  it('says so when the deployment has no formats', async () => {
    await render(IN_DESIGN, { formats: [] })

    expect(dialogText()).toContain('There are no formats to create from.')
    expect(button('Create').disabled).toBe(true)
  })

  it('offers a format’s default publication checked, says what it means, and creates it published', async () => {
    const { newGadgetFromBlueprint, dispose, onCreated } = await render(IN_DESIGN)

    expect(checkbox()?.getAttribute('aria-checked')).toBe('true')
    expect(dialogText()).toContain('Publish to everyone signed in')
    expect(dialogText()).toContain('A new Note is published by default: anyone signed in can use it without being invited.')

    await click(button('Create'))
    await settle()
    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-note', {}, {
      spaceKey: 'design',
      parentId: 'w-handbook',
      publish: true,
    })
    expect(onCreated).toHaveBeenCalledWith('w-new')
    expect(dispose).toHaveBeenCalledTimes(1)
  })

  it('opts out of the default publication when it is unchecked', async () => {
    const { newGadgetFromBlueprint } = await render(IN_DESIGN)

    await press(checkbox()!)
    expect(checkbox()?.getAttribute('aria-checked')).toBe('false')
    await click(button('Create'))
    await settle()
    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-note', {}, expect.objectContaining({ publish: false }))
  })

  it('offers no publication for a format that declares none, and asks for none', async () => {
    const { newGadgetFromBlueprint } = await render(IN_DESIGN)

    await press(radio('Board'))
    expect(radio('Board').getAttribute('aria-checked')).toBe('true')
    expect(checkbox()).toBeNull()
    await click(button('Create'))
    await settle()
    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-board', {}, { spaceKey: 'design', parentId: 'w-handbook' })
  })

  it('creates at the top of the personal space with no space or parent named', async () => {
    const { newGadgetFromBlueprint } = await render(
      { spaceKey: undefined, parent: null, listing: LISTING },
      { declared: { 'bp-note': null, 'bp-board': null } },
    )

    expect(dialogText()).toContain('New workspace')
    expect(dialogText()).toContain('At the top of the space.')
    await click(button('Create'))
    await settle()
    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-note', {}, {})
  })

  it('says a publication under an unpublished workspace is not visible until that one is', async () => {
    await render({ ...IN_DESIGN, parent: DRAFTS })
    expect(dialogText()).toContain('Not visible to others until “Drafts” is published.')

    unmountAll()
    await render({ ...IN_DESIGN, parent: ARCHIVE })
    expect(dialogText()).toContain('Not visible to others until “Drafts” is published.')

    unmountAll()
    await render({ ...IN_DESIGN, parent: ARCHIVE, listing: [HANDBOOK, ARCHIVE] })
    expect(dialogText()).toContain('Not visible to others until a workspace above it is published.')

    unmountAll()
    await render(IN_DESIGN)
    expect(dialogText()).not.toContain('Not visible to others')
  })

  it('publishes nothing it could not tell the user about', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { newGadgetFromBlueprint } = await render(IN_DESIGN, {
      declared: { 'bp-note': new Error('Blueprint store unavailable'), 'bp-board': null },
    })

    expect(checkbox()).toBeNull()
    await click(button('Create'))
    await settle()
    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-note', {}, expect.objectContaining({ publish: false }))
  })

  it('waits to create until it knows whether the format is published by default', async () => {
    const pending = deferred<BlueprintPublicInfo>()
    const dispose = vi.fn<() => void>()
    const getBlueprint = vi.fn<() => Promise<BlueprintPublicInfo>>(() => pending.promise)
    const Page = () => (
      <RpcContext.Provider value={{ stub: { getBlueprint } as unknown as RpcStub<PublicApi>, connectionLost: false }}>
        <NewChildWorkspaceDialog {...IN_DESIGN} onClose={() => {}} onCreated={() => {}} />
      </RpcContext.Provider>
    )
    await mountRouted(fakeApi({
      listOutputFormats: async () => [NOTE],
      newGadgetFromBlueprint: () => ({ getMetadata: async () => ({ id: 'w-new' }), [Symbol.dispose]: dispose }),
    }), {
      at: '/workspaces',
      pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/workspaces', component: Page })],
    })
    await settle()

    expect(button('Create').disabled).toBe(true)
    pending.resolve(blueprint('build'))
    await settle()
    expect(button('Create').disabled).toBe(false)
    expect(dialogText()).toContain('anyone signed in can use it and build in it without being invited.')
  })

  it('shows why a creation failed, stays open, and lets go of what it asked for', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { dispose, onCreated, onClose } = await render(IN_DESIGN, {
      created: async () => { throw new Error('Workspace limit reached.') },
    })

    await click(button('Create'))
    await settle()
    expect(alerts()).toEqual(['Workspace limit reached.'])
    expect(onCreated).not.toHaveBeenCalled()
    expect(onClose).not.toHaveBeenCalled()
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(button('Create').disabled).toBe(false)
  })
})
