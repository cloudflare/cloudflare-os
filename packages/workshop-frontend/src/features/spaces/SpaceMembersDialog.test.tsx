// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, SpaceInfo, SpaceMemberInfo } from '@gadgets/workshop-shared/api'
import { SpaceMembersDialog } from './SpaceMembersDialog'
import {
  ME,
  alerts,
  button,
  chooseOption,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  hasButton,
  member,
  mount,
  notAMember,
  person,
  personalSpace,
  pressEscape,
  selectOptions,
  settle,
  teamSpace,
  type,
  unmountAll,
} from './spacesTestUtils'

vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const ADA = person('ada@example.com', 'Ada')
const GRACE = person('grace@example.com', 'Grace')

const render = async (
  info: SpaceInfo,
  members: SpaceMemberInfo[],
  api: Partial<{ [K in keyof AuthenticatedApi]: unknown }> = {},
) => {
  const space = fakeSpace(info, members)
  const onClose = vi.fn<() => void>()
  const onLeft = vi.fn<() => void>()
  await mount(
    <SpaceMembersDialog spaceKey={info.key} onClose={onClose} onLeft={onLeft} />,
    fakeApi({ openSpace: () => space.stub, ...api }),
  )
  await settle()
  return { space, onClose, onLeft }
}

// Each member's row as it reads: name, id where it differs from the name, role.
const rows = () => [...document.body.querySelectorAll('ul[aria-label="Members"] > li')]
  .map(row => row.textContent)

const chooseRole = async (label: string, role: string) => {
  await chooseOption(label, role)
  await settle()
}

const roleLabels = async (label: string) =>
  (await selectOptions(label)).map(option => option.textContent)

const peopleField = () =>
  document.body.querySelector<HTMLInputElement>('input[aria-label="Username or email"]')

const stage = async (username: string) => {
  await type(peopleField()!, username)
  await act(async () => peopleField()!.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })))
}

const add = async () => {
  await click(button('Add'))
  await settle()
}

// What the dialog last announced of a change to the members, and what the people field last
// announced of the people entered in it. Each is a polite live region of its own.
const announced = () => document.body
  .querySelector('ul[aria-label="Members"] ~ [role="status"][aria-live="polite"]')?.textContent
const fieldAnnounced = () => document.body
  .querySelector('[data-testid="people-composer"] + [role="status"][aria-live="polite"]')?.textContent

// What every call on a space that could not be opened rejects with.
const lost = async () => { throw new Error('Network connection lost.') }

const openAsAdmin = () =>
  render(teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'admin')])

const openAsMember = () =>
  render(teamSpace('platform', 'Platform', 'use'), [member(ADA, 'admin'), member(ME, 'use')])

describe('SpaceMembersDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  describe('for an admin of a team space', () => {
    it('lists the members with their roles', async () => {
      await openAsAdmin()
      expect(document.body.querySelector('h2')?.textContent).toBe('Members of Platform')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comAdmin'])
    })

    it('adds the people entered with the role chosen for them', async () => {
      const { space } = await openAsAdmin()

      await stage(GRACE.id)
      await chooseRole('Role for the people added', 'Build')
      await add()

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'build')
      expect(rows()).toContain('grace@example.comBuild')
      expect(hasButton(`Remove ${GRACE.id}`)).toBe(true)
      expect(alerts()).toEqual([])
      expect(announced()).toBe('Added grace@example.com with the role Build.')
    })

    it('offers every role, and makes a member an admin', async () => {
      const { space } = await render(
        teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'use')])
      expect(await roleLabels('Role for the people added')).toEqual(['Admin', 'Build', 'Use'])
      await pressEscape()

      await chooseRole('Role of Ada', 'Admin')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'admin')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comAdmin'])
    })

    it('says of a person entered, or taken back out, that they are listed, not that they were added or removed', async () => {
      const { space } = await openAsAdmin()

      await stage(GRACE.id)
      expect(fieldAnnounced()).toBe('grace@example.com is listed to add.')
      expect(announced()).toBe('')

      await act(async () => peopleField()!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })))
      expect(fieldAnnounced()).toBe('grace@example.com is no longer listed.')
      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(space.removeMember).not.toHaveBeenCalled()
    })

    it('holds back someone another admin made a member after the list was read', async () => {
      const { space } = await openAsAdmin()
      // Another admin's change: the list on show does not have Carol.
      await space.setMemberRole('carol@example.com', 'admin')
      space.setMemberRole.mockClear()

      await stage('carol@example.com')
      await add()

      // Sending her would have lowered her from admin to the role picked for newcomers.
      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(alerts()).toEqual(['carol@example.com: Already a member. Change their role in the list.'])
      expect(rows()).toContain('carol@example.comAdmin')
      expect(announced()).toBe('')
    })

    it('keeps everyone entered, with the reason, when the members cannot be read for the add', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.listMembers.mockRejectedValueOnce(new Error('The space is busy.'))

      await stage(GRACE.id)
      await add()

      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(alerts()).toEqual(['grace@example.com: The space is busy.'])
    })

    it('adds the name still in the field along with the people entered', async () => {
      const { space } = await openAsAdmin()

      await stage('carol@example.com')
      await type(peopleField()!, GRACE.id)
      await click(button('Add 2 people'))
      await settle()

      expect(space.setMemberRole.mock.calls).toEqual([['carol@example.com', 'use'], [GRACE.id, 'use']])
      expect(peopleField()!.value).toBe('')
    })

    it('keeps whoever could not be added, with the reason, and adds the rest', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.setMemberRole.mockImplementationOnce(async () => null)
      space.setMemberRole.mockImplementationOnce(async () => {
        throw new Error('Only an admin of this space can change its members.')
      })

      await stage('nobody')
      await stage('carol@example.com')
      await stage(GRACE.id)
      // Already a member: sending her would set her role to the one picked for the newcomers.
      await stage(ADA.id)
      await click(button('Add 4 people'))
      await settle()

      expect(space.setMemberRole.mock.calls.map(([username]) => username))
        .toEqual(['nobody', 'carol@example.com', GRACE.id])
      expect(rows()).toEqual([
        'Me (you)me@example.comAdmin',
        'Adaada@example.comAdmin',
        'grace@example.comUse',
      ])
      expect(alerts()).toEqual([[
        'nobody: No account found for that username or email.',
        'carol@example.com: Only an admin of this space can change its members.',
        'ada@example.com: Already a member. Change their role in the list.',
      ].join('')])
    })

    it('lowers a member’s role', async () => {
      const { space } = await openAsAdmin()

      await chooseRole('Role of Ada', 'Use')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comUse'])
      expect(announced()).toBe('Ada’s role is now Use.')
    })

    it('shows on the member’s row a role change that found no account, and leaves the role as it is', async () => {
      const { space } = await openAsAdmin()
      space.setMemberRole.mockImplementationOnce(async () => null)

      await chooseRole('Role of Ada', 'Use')

      expect(rows()).toEqual([
        'Me (you)me@example.comAdmin',
        'Adaada@example.comAdminNo account found for that username or email.',
      ])
      expect(announced()).toBe('')
    })

    it('removes a member, and offers the viewer no remove button for themself', async () => {
      const { space } = await openAsAdmin()
      expect(hasButton('Remove Me')).toBe(false)

      await click(button('Remove Ada'))
      await settle()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ADA.id)
      expect(rows()).toEqual(['Me (you)me@example.comAdmin'])
      expect(announced()).toBe('Removed Ada.')
    })

    it('offers no removal and no leave while it does not know which member the viewer is', async () => {
      // The session never learnt who its user is.
      await render(
        teamSpace('platform', 'Platform'),
        [member(ME, 'admin'), member(ADA, 'admin')],
        { whoami: async () => { throw new Error('Network connection lost.') } },
      )

      expect(rows()).toEqual(['Meme@example.comAdmin', 'Adaada@example.comAdmin'])
      // Any row may be the viewer's own, where a removal would be a leave that asks nothing first.
      expect(hasButton('Remove Me')).toBe(false)
      expect(hasButton('Remove Ada')).toBe(false)
      expect(hasButton('Leave space')).toBe(false)
      expect(hasButton('Role of Ada')).toBe(true)
    })

    it('shows the last-admin refusal on the member it was about and leaves the role as it is', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await render(teamSpace('platform', 'Platform'), [member(ME, 'admin')])
      space.setMemberRole.mockRejectedValueOnce(new Error('A space must keep at least one admin.'))

      await chooseRole('Role of Me', 'Use')

      expect(alerts()).toEqual(['A space must keep at least one admin.'])
      expect(document.body.querySelector('ul[aria-label="Members"] [role="alert"]')).not.toBeNull()
      expect(rows()).toEqual(['Me (you)me@example.comAdminA space must keep at least one admin.'])
    })

    it('starts no add, and does not close, while another change is in flight', async () => {
      const { space, onClose } = await openAsAdmin()
      const removal = deferred<void>()
      space.removeMember.mockImplementationOnce(() => removal.promise)
      await stage(GRACE.id)

      await click(button('Remove Ada'))
      expect(button('Add').disabled).toBe(true)
      // Enter in the empty field is the keyboard's way to send the people entered.
      await stage('')
      await pressEscape()
      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => removal.resolve())
      await settle()
      expect(button('Add').disabled).toBe(false)
      await pressEscape()
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('says so when the space stops counting the viewer as a member', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      // Another admin removed the viewer after the dialog opened: every call is refused now.
      await space.removeMember(ME.id)
      space.removeMember.mockRejectedValueOnce(notAMember())

      await click(button('Remove Ada'))
      await settle()

      expect(alerts()).toEqual(['You are no longer a member of this space.'])
      expect(document.body.querySelector('ul[aria-label="Members"]')).toBeNull()
      expect(peopleField()).toBeNull()
    })
  })

  describe('for a member who is not an admin', () => {
    it('shows the list read-only', async () => {
      await openAsMember()

      expect(rows()).toEqual(['Adaada@example.comAdmin', 'Me (you)me@example.comUse'])
      expect(peopleField()).toBeNull()
      expect(document.body.querySelector('[role="combobox"]')).toBeNull()
      expect(hasButton('Remove Ada')).toBe(false)
    })

    it('lets them leave, after confirming', async () => {
      const { space, onLeft } = await openAsMember()

      // Focus follows the question and comes back when it is declined.
      await click(button('Leave space'))
      expect(document.activeElement).toBe(button('Cancel'))
      await click(button('Cancel'))
      expect(document.activeElement).toBe(button('Leave space'))
      expect(space.removeMember).not.toHaveBeenCalled()

      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
      expect(onLeft).toHaveBeenCalledOnce()
    })

    it('shows a refused leave and reports nothing', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space, onLeft } = await openAsMember()
      space.removeMember.mockRejectedValueOnce(new Error('A space must keep at least one admin.'))

      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      expect(alerts()).toEqual(['A space must keep at least one admin.'])
      expect(onLeft).not.toHaveBeenCalled()
    })
  })

  describe('in a personal space', () => {
    it('offers its owner no admin role to give, no change to their own row and no way to leave', async () => {
      await render(personalSpace(ME, 'admin'), [member(ME, 'admin'), member(ADA, 'build')])

      expect(document.body.querySelector('h2')?.textContent).toBe('Members of your personal space')
      expect(hasButton('Role of Me')).toBe(false)
      expect(hasButton('Leave space')).toBe(false)
      expect(await roleLabels('Role for the people added')).toEqual(['Build', 'Use'])
    })

    it('offers no admin role for an existing member either', async () => {
      await render(personalSpace(ME, 'admin'), [member(ME, 'admin'), member(ADA, 'build')])

      expect(await roleLabels('Role of Ada')).toEqual(['Build', 'Use'])
      expect(hasButton('Remove Ada')).toBe(true)
    })

    it('lets a member who is not the owner leave', async () => {
      const { space, onLeft } = await render(
        personalSpace(ADA, 'use'), [member(ADA, 'admin'), member(ME, 'use')])
      expect(document.body.querySelector('h2')?.textContent).toBe('Members of Ada’s personal space')

      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
      expect(onLeft).toHaveBeenCalledOnce()
    })
  })

  it('offers another try when the space cannot be opened, busy until the space has been read again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')])
    const openSpace = vi.fn<(key: string) => unknown>()
      .mockReturnValueOnce({ getInfo: lost, listMembers: lost, [Symbol.dispose]() {} })
      .mockReturnValue(space.stub)
    await mount(
      <SpaceMembersDialog spaceKey="platform" onClose={() => {}} onLeft={() => {}} />,
      fakeApi({ openSpace }),
    )
    await settle()
    expect(alerts()).toEqual(['Couldn’t load this space.Try again'])

    // The space is opened again, and the button is busy until it has been read.
    const members = deferred<SpaceMemberInfo[]>()
    space.listMembers.mockImplementationOnce(() => members.promise)
    await click(button('Try again'))
    expect(button('Try again').disabled).toBe(true)

    await act(async () => members.resolve(space.members()))
    await settle()
    expect(rows()).toEqual(['Me (you)me@example.comAdmin'])
  })
})
