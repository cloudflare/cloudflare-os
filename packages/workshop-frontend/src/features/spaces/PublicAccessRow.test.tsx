// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  CollaboratorRole,
  GadgetMetadata,
  Overseer,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { PublicAccessRow } from './PublicAccessRow'
import {
  ME,
  button,
  deferred,
  fakeApi,
  fakeSpace,
  listingEntry,
  member,
  mount,
  person,
  personalSpace,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

afterEach(() => {
  unmountAll()
  vi.restoreAllMocks()
})

const ADA = person('ada@example.com', 'Ada')
const PERSONAL = personalSpace(ME, 'admin')
const DESIGN = teamSpace('design', 'Design', 'build')

const NOTE = 'Not visible to others until \'Onboarding\' is published'

// The tree the workspace, Checklist, sits in:
//   Handbook        (published)
//   └─ Onboarding   (not published)
//      └─ Checklist
const listingWith = (checklist: Partial<SpaceWorkspaceInfo>): SpaceWorkspaceInfo[] => [
  listingEntry('w-handbook', 'Handbook', ME, { position: 0, published: 'use' }),
  listingEntry('w-onboarding', 'Onboarding', ADA, { parentId: 'w-handbook', position: 0 }),
  listingEntry('w-checklist', 'Checklist', ME, { parentId: 'w-onboarding', position: 0, ...checklist }),
]

const HIDDEN = listingWith({ published: 'use', hiddenBy: 'w-onboarding' })

type Metadata = Omit<Parameters<typeof PublicAccessRow>[0]['metadata'], 'id'>

/**
 * The row for Checklist as `metadata` describes it. The space its `listedIn` names lists `listing`,
 * and the user is a `member` of it or not; any other space lists nothing.
 */
const render = async (metadata: Metadata, { listing = HIDDEN, spacesFlag = true, isMember = true }: {
  listing?: SpaceWorkspaceInfo[]
  spacesFlag?: boolean
  isMember?: boolean
} = {}) => {
  const setPublicAccess = vi.fn<(role: CollaboratorRole | null) => Promise<void>>(async () => {})
  const overseer = {
    setPublicAccess,
    getMetadata: async (): Promise<GadgetMetadata> => ({ id: 'w-checklist', title: 'Checklist' }),
  } as unknown as RpcStub<Overseer>
  const holder = metadata.listedIn === DESIGN.key ? DESIGN : PERSONAL
  const space = fakeSpace(holder, isMember ? [member(ME, holder.role)] : [member(ADA, 'admin')], listing)
  const openSpace = vi.fn<(key: string) => unknown>(key => (key === holder.key
    ? space.stub
    : fakeSpace(teamSpace(key, key), [member(ME, 'admin')]).stub))
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL, DESIGN])
  const listGadgets = vi.fn<AuthenticatedApi['listGadgets']>(async () => [])
  const api = fakeApi({ listSpaces, listGadgets, openSpace }, { spacesFlag })
  await mount(
    <PublicAccessRow overseer={overseer} authenticatedApi={api} metadata={{ id: 'w-checklist', ...metadata }} />,
    api,
  )
  await settle()
  return { setPublicAccess, openSpace, listSpaces, listGadgets, space }
}

const text = () => document.body.textContent ?? ''

// Picks `label` from the control's options, and confirms it when it takes access away.
const choose = async (label: string) => {
  await act(async () => {
    button('Access for anyone signed in to this deployment')
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }))
  })
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent === label)!
  await act(async () => { option.click() })
  const confirm = [...document.body.querySelectorAll('button')]
    .find(candidate => candidate.textContent === `Change to ${label}`)
  if (confirm) await act(async () => { confirm.click() })
  await settle()
}

// The row for Checklist, published, as the metadata says first the design space and then the
// user's personal space lists it, the user being a member of both.
const rowMovedBetween = async (design: ReturnType<typeof fakeSpace>, personal: ReturnType<typeof fakeSpace>) => {
  const api = fakeApi({ openSpace: vi.fn<(key: string) => unknown>(key => (key === DESIGN.key ? design : personal).stub) })
  const overseer = { setPublicAccess: async () => {} } as unknown as RpcStub<Overseer>
  const row = (listedIn: string) => (
    <PublicAccessRow
      overseer={overseer}
      authenticatedApi={api}
      metadata={{ id: 'w-checklist', owner: ADA, publicAccess: 'use', listedIn }}
    />
  )
  const { rerender } = await mount(row(DESIGN.key), api)
  await settle()
  return async () => {
    await rerender(row(PERSONAL.key))
    await settle()
  }
}

describe('PublicAccessRow', () => {
  it('tells the owner which workspace above keeps a published workspace from being visible', async () => {
    const { openSpace, space } = await render({ publicAccess: 'use', listedIn: PERSONAL.key })

    expect(openSpace).toHaveBeenCalledWith(PERSONAL.key)
    expect(text()).toContain(NOTE)
    expect(space[Symbol.dispose]).toHaveBeenCalled()
  })

  it('reads the team space the metadata says lists the workspace', async () => {
    const { openSpace } = await render({ publicAccess: 'build', listedIn: 'design' })

    expect(openSpace.mock.calls).toEqual([['design']])
    expect(text()).toContain(NOTE)
  })

  it('says nothing of it while the workspace is not published, and says it once it is', async () => {
    const { setPublicAccess, openSpace } = await render({ listedIn: PERSONAL.key }, { listing: listingWith({}) })
    expect(openSpace).not.toHaveBeenCalled()
    expect(text()).not.toContain('Not visible to others')

    await choose('Can use')

    expect(setPublicAccess).toHaveBeenCalledWith('use')
    expect(text()).toContain(NOTE)
  })

  it('does not show what it read for an earlier publication while it reads again', async () => {
    const { space } = await render({ publicAccess: 'use', listedIn: PERSONAL.key })
    expect(text()).toContain(NOTE)

    await choose('No access')
    expect(text()).not.toContain('Not visible to others')

    space.listWorkspaces.mockImplementationOnce(() => new Promise(() => {}))
    await choose('Can use')

    expect(text()).toContain('Can open this workspace and use its gadgets without being invited.')
    expect(text()).not.toContain('Not visible to others')
  })

  it('says nothing of it when nothing above the workspace is unpublished', async () => {
    await render({ publicAccess: 'use', listedIn: PERSONAL.key }, {
      listing: [listingEntry('w-checklist', 'Checklist', ME, { position: 0, published: 'use' })],
    })

    expect(text()).toContain('Can open this workspace and use its gadgets without being invited.')
    expect(text()).not.toContain('Not visible to others')
  })

  it('opens no space, and says nothing of it, while no space lists the workspace', async () => {
    const { openSpace, listSpaces, listGadgets } = await render({ publicAccess: 'use' })

    expect(text()).toContain('Can open this workspace and use its gadgets without being invited.')
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
    expect(listGadgets).not.toHaveBeenCalled()
    expect(text()).not.toContain('Not visible to others')
  })

  it('takes a space that refuses the owner for one that does not list the workspace, not for a failure', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { openSpace } = await render({ publicAccess: 'use', listedIn: 'design' }, {
      isMember: false,
      listing: [listingEntry('w-checklist', 'Checklist', ME, { position: 0 })],
    })

    expect(openSpace).toHaveBeenCalledWith('design')
    expect(text()).not.toContain('Not visible to others')
    expect(failures).not.toHaveBeenCalled()
  })

  it('tells a member of the space who is not the owner, reading only the space that lists it', async () => {
    const { openSpace, listSpaces } = await render({ publicAccess: 'build', owner: ADA, listedIn: 'design' })

    expect(text()).toContain('Can build')
    expect(openSpace.mock.calls).toEqual([['design']])
    expect(listSpaces).not.toHaveBeenCalled()
    expect(text()).toContain(NOTE)
  })

  it('tells no one else who is not the owner', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { openSpace } = await render(
      { publicAccess: 'build', owner: ADA, listedIn: 'design' },
      { isMember: false },
    )

    expect(text()).toContain('Can build')
    expect(openSpace.mock.calls).toEqual([['design']])
    expect(text()).not.toContain('Not visible to others')
    expect(failures).not.toHaveBeenCalled()
  })

  it('ignores what the space of a workspace the row no longer shows answers', async () => {
    const pending = deferred<SpaceWorkspaceInfo[]>()
    const design = fakeSpace(DESIGN, [member(ME, 'build')], HIDDEN)
    design.listWorkspaces.mockImplementationOnce(() => pending.promise)
    const personal = fakeSpace(PERSONAL, [member(ME, 'admin')], [
      listingEntry('w-other', 'Other', ME, { position: 0, published: 'use' }),
    ])
    const openSpace = vi.fn<(key: string) => unknown>(key => (key === DESIGN.key ? design.stub : personal.stub))
    const api = fakeApi({ openSpace })
    const overseer = { setPublicAccess: async () => {} } as unknown as RpcStub<Overseer>
    const row = (id: string, listedIn: string) => (
      <PublicAccessRow
        overseer={overseer}
        authenticatedApi={api}
        metadata={{ id, owner: ADA, publicAccess: 'use', listedIn }}
      />
    )
    const { rerender } = await mount(row('w-checklist', DESIGN.key), api)
    await settle()

    await rerender(row('w-other', PERSONAL.key))
    await settle()
    expect(design[Symbol.dispose]).toHaveBeenCalled()

    await act(async () => { pending.resolve(HIDDEN) })
    await settle()

    expect(openSpace.mock.calls).toEqual([[DESIGN.key], [PERSONAL.key]])
    expect(text()).not.toContain('Not visible to others')
  })

  it('shows nothing of what the space the metadata named before answered while it reads the one it names now', async () => {
    const design = fakeSpace(DESIGN, [member(ME, 'build')], HIDDEN)
    const personal = fakeSpace(PERSONAL, [member(ME, 'admin')], HIDDEN)
    personal.listWorkspaces.mockImplementationOnce(() => new Promise(() => {}))
    const move = await rowMovedBetween(design, personal)
    expect(text()).toContain(NOTE)

    await move()

    expect(personal.listWorkspaces).toHaveBeenCalled()
    expect(text()).not.toContain('Not visible to others')
  })

  it('keeps what the space the metadata names answers over what the one it named before answers later', async () => {
    const pending = deferred<SpaceWorkspaceInfo[]>()
    const unblocked = [listingEntry('w-checklist', 'Checklist', ME, { position: 0, published: 'use' })]
    const design = fakeSpace(DESIGN, [member(ME, 'build')], unblocked)
    design.listWorkspaces.mockImplementationOnce(() => pending.promise)
    const personal = fakeSpace(PERSONAL, [member(ME, 'admin')], HIDDEN)
    const move = await rowMovedBetween(design, personal)

    await move()
    expect(text()).toContain(NOTE)

    await act(async () => { pending.resolve(unblocked) })
    await settle()

    expect(text()).toContain(NOTE)
  })

  it('shows nothing, and reads nothing, with the spaces flag off', async () => {
    const { openSpace } = await render({ publicAccess: 'use', listedIn: PERSONAL.key }, { spacesFlag: false })

    expect(text()).toBe('')
    expect(openSpace).not.toHaveBeenCalled()
  })
})
