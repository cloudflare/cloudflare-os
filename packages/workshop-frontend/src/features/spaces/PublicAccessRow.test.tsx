// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type {
  CollaboratorRole,
  GadgetMetadata,
  GadgetMetadataWithTimestamps,
  Overseer,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { PublicAccessRow } from './PublicAccessRow'
import {
  ME,
  button,
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
const DAY = new Date('2026-09-01T00:00:00Z')

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
 * The row for Checklist as `metadata` describes it. Checklist is in `spaceKey` (the owner's
 * personal space when absent), which lists `listing` and of which the user is a `member` or not;
 * only the owner's own record of it says which space that is.
 */
const render = async (metadata: Metadata, { listing = HIDDEN, spaceKey, spacesFlag = true, isMember = true }: {
  listing?: SpaceWorkspaceInfo[]
  spaceKey?: string
  spacesFlag?: boolean
  isMember?: boolean
} = {}) => {
  const setPublicAccess = vi.fn<(role: CollaboratorRole | null) => Promise<void>>(async () => {})
  const overseer = {
    setPublicAccess,
    getMetadata: async (): Promise<GadgetMetadata> => ({ id: 'w-checklist', title: 'Checklist' }),
  } as unknown as RpcStub<Overseer>
  const holder = spaceKey ? DESIGN : PERSONAL
  const space = fakeSpace(holder, isMember ? [member(ME, holder.role)] : [member(ADA, 'admin')], listing)
  const openSpace = vi.fn<(key: string) => unknown>(key => (key === holder.key
    ? space.stub
    : fakeSpace(PERSONAL, [member(ME, 'admin')]).stub))
  const records: GadgetMetadataWithTimestamps[] = [{
    id: 'w-checklist',
    title: 'Checklist',
    created: DAY,
    lastActive: DAY,
    ...(metadata.owner ? { owner: metadata.owner } : { spaceKey }),
  }]
  const api = fakeApi({
    listGadgets: async () => records,
    listSpaces: async () => (isMember || !spaceKey ? [PERSONAL, DESIGN] : [PERSONAL]),
    openSpace,
  }, { spacesFlag })
  await mount(
    <PublicAccessRow overseer={overseer} authenticatedApi={api} metadata={{ id: 'w-checklist', ...metadata }} />,
    api,
  )
  await settle()
  return { setPublicAccess, openSpace, space }
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

describe('PublicAccessRow', () => {
  it('tells the owner which workspace above keeps a published workspace from being visible', async () => {
    const { openSpace, space } = await render({ publicAccess: 'use' })

    expect(openSpace).toHaveBeenCalledWith(PERSONAL.key)
    expect(text()).toContain(NOTE)
    expect(space[Symbol.dispose]).toHaveBeenCalled()
  })

  it('reads the team space the owner’s record groups the workspace in', async () => {
    const { openSpace } = await render({ publicAccess: 'build' }, { spaceKey: 'design' })

    expect(openSpace).toHaveBeenCalledWith('design')
    expect(text()).toContain(NOTE)
  })

  it('says nothing of it while the workspace is not published, and says it once it is', async () => {
    const { setPublicAccess, openSpace } = await render({}, { listing: listingWith({}) })
    expect(openSpace).not.toHaveBeenCalled()
    expect(text()).not.toContain('Not visible to others')

    await choose('Can use')

    expect(setPublicAccess).toHaveBeenCalledWith('use')
    expect(text()).toContain(NOTE)
  })

  it('does not show what it read for an earlier publication while it reads again', async () => {
    const { space } = await render({ publicAccess: 'use' })
    expect(text()).toContain(NOTE)

    await choose('No access')
    expect(text()).not.toContain('Not visible to others')

    space.listWorkspaces.mockImplementationOnce(() => new Promise(() => {}))
    await choose('Can use')

    expect(text()).toContain('Can open this workspace and use its gadgets without being invited.')
    expect(text()).not.toContain('Not visible to others')
  })

  it('says nothing of it when nothing above the workspace is unpublished', async () => {
    await render({ publicAccess: 'use' }, {
      listing: [listingEntry('w-checklist', 'Checklist', ME, { position: 0, published: 'use' })],
    })

    expect(text()).toContain('Can open this workspace and use its gadgets without being invited.')
    expect(text()).not.toContain('Not visible to others')
  })

  it('takes a space that refuses the owner for one that does not list the workspace, not for a failure', async () => {
    const failures = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { openSpace } = await render({ publicAccess: 'use' }, {
      spaceKey: 'design',
      isMember: false,
      listing: [listingEntry('w-checklist', 'Checklist', ME, { position: 0 })],
    })

    expect(openSpace).toHaveBeenCalledWith('design')
    expect(text()).not.toContain('Not visible to others')
    expect(failures).not.toHaveBeenCalled()
  })

  it('tells a member of the space who is not the owner, looking through the team spaces they are in', async () => {
    const { openSpace } = await render({ publicAccess: 'build', owner: ADA }, { spaceKey: 'design' })

    expect(text()).toContain('Can build')
    expect(openSpace).toHaveBeenCalledWith('design')
    expect(openSpace).not.toHaveBeenCalledWith(PERSONAL.key)
    expect(text()).toContain(NOTE)
  })

  it('tells no one else who is not the owner', async () => {
    const { openSpace } = await render({ publicAccess: 'build', owner: ADA }, { spaceKey: 'design', isMember: false })

    expect(text()).toContain('Can build')
    expect(openSpace).not.toHaveBeenCalledWith('design')
    expect(text()).not.toContain('Not visible to others')
  })

  it('shows nothing, and reads nothing, with the spaces flag off', async () => {
    const { openSpace } = await render({ publicAccess: 'use' }, { spacesFlag: false })

    expect(text()).toBe('')
    expect(openSpace).not.toHaveBeenCalled()
  })
})
