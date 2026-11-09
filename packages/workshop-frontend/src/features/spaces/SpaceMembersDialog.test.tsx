// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, StrictMode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcPromise } from 'capnweb'
import type {
  AuthenticatedApi,
  ServerConfig,
  SpaceInfo,
  SpaceMemberInfo,
  SpaceMemberRole,
  UserDirectoryRecord,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
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
  const { unmount } = await mount(
    <SpaceMembersDialog spaceId={info.id} onClose={onClose} onLeft={onLeft} />,
    fakeApi({ openSpace: () => space.stub, ...api }),
  )
  await settle()
  return { space, onClose, onLeft, unmount }
}

type SearchUsers = (query: string, excludeIds: string[]) => RpcPromise<UserDirectoryRecord[]>

// The directory answering every search with these people.
const directoryOf = (...people: UserDirectoryRecord[]) =>
  vi.fn<SearchUsers>(() => new RpcPromise(Promise.resolve(people)))

// The dialog for an admin on a deployment where people are searched for in the user directory.
const openWithSearch = async (
  searchUsers: SearchUsers,
  members = [member(ME, 'admin'), member(ADA, 'admin')],
) => {
  // jsdom does not implement it, and the field scrolls its highlighted result into view.
  Element.prototype.scrollIntoView = () => {}
  const space = fakeSpace(teamSpace('platform', 'Platform'), members)
  await mount(
    <ServerConfigContext.Provider value={{ userSearchEnabled: true } as ServerConfig}>
      <SpaceMembersDialog spaceId="platform" onClose={() => {}} onLeft={() => {}} />
    </ServerConfigContext.Provider>,
    fakeApi({ openSpace: () => space.stub, searchUsers }),
  )
  await settle()
  return { space }
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

const personField = () => document.body.querySelector<HTMLInputElement>('input[type="search"]')

// Enter, pressed in the field.
const pressEnter = (init: KeyboardEventInit = {}) => act(async () => personField()!.dispatchEvent(
  new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init })))

// Enters a username in the field and has the field take it as the person to add: with user
// search off, the text is taken as typed.
const pick = async (username: string) => {
  await type(personField()!, username)
  await pressEnter()
}

const add = async () => {
  await click(button('Add'))
  await settle()
}

const offeredPeople = () => [...document.body
  .querySelectorAll<HTMLElement>('[aria-label="Matching people"] [role="option"]')]

// Waits, within a bound, for what the field shows once typing has paused and the directory has
// been asked.
const eventually = async (shown: () => boolean) => {
  for (let turn = 0; turn < 100 && !shown(); turn++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
}

// The people the field offers for what was typed.
const directoryResults = async () => {
  await eventually(() => offeredPeople().length > 0)
  return offeredPeople()
}

// What the field says of a search that offers nobody.
const searchStatus = () => document.body
  .querySelector('[aria-label="Matching people"] [role="status"]')?.textContent

const useAsTyped = (text: string) => `Use “${text}” as a username or email`

// Whether the dialog offers any text, whatever it is, for use as typed.
const offersText = () => [...document.body.querySelectorAll('button')]
  .some(candidate => candidate.textContent?.startsWith('Use “'))

// The row of the member with this name.
const rowOf = (name: string) => {
  const found = [...document.body.querySelectorAll<HTMLElement>('ul[aria-label="Members"] > li')]
    .find(row => row.textContent?.startsWith(name))
  if (!found) throw new Error(`No member named “${name}”`)
  return found
}

const memberList = () => document.body.querySelector('ul[aria-label="Members"]')

// Which of these controls are disabled.
const held = (...labels: string[]) => labels.filter(label => button(label).disabled)

// What the dialog last announced of a change to the members.
const announced = () => document.body
  .querySelector('ul[aria-label="Members"] ~ [role="status"][aria-live="polite"]')?.textContent

// What every call on a space that could not be opened rejects with.
const lost = async () => { throw new Error('Network connection lost.') }

// Another admin adds Carol after the members were read for an add and before its change. The
// space knows her by her name, which is not the text she is typed as.
const addedMeanwhile = (space: ReturnType<typeof fakeSpace>, role: SpaceMemberInfo['role']) =>
  space.listMembers.mockImplementationOnce(async () => {
    const before = space.members()
    const carol = await space.setMemberRole('carol@example.com', role)
    carol!.profile.name = 'Carol'
    return before
  })

const openAsAdmin = () =>
  render(teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'admin')])

const openAsMember = () =>
  render(teamSpace('platform', 'Platform', 'use'), [member(ADA, 'admin'), member(ME, 'use')])

// What the dialog of a sub-space says and shows.
const NOTE = (role: string) =>
  'Members of the spaces above this one also have access, with the roles they hold there or higher. '
  + `Only the people added to this space itself are listed. Your role here: ${role}.`
const LEFT = 'You are no longer one of this space’s own members. You still have access through a space above it.'
const NOBODY = 'Nobody has been added to this space itself.'

// Infra, inside Platform: `members` are the people added to Infra itself, and `inherited`
// the role the viewer holds in Platform, when they hold one.
const openSubspace = async (members: SpaceMemberInfo[], inherited?: SpaceMemberRole) => {
  const space = fakeSpace(teamSpace('infra', 'Infra', 'use', 'platform'), members, [], { inherited })
  const onClose = vi.fn<() => void>()
  const onLeft = vi.fn<() => void>()
  await mount(
    <SpaceMembersDialog spaceId="infra" onClose={onClose} onLeft={onLeft} />,
    fakeApi({ openSpace: () => space.stub }),
  )
  await settle()
  return { space, onClose, onLeft }
}

const notes = () => [...document.body.querySelectorAll('[role="note"]')]

// The line that announces a change, whether or not anybody is listed above it.
const statusLine = () => document.body.querySelector('[role="dialog"] p[role="status"][aria-live="polite"]')

// Every paragraph on screen, and not only announced, that says the viewer left the list.
const leftShown = () => [...document.body.querySelectorAll('[role="dialog"] p')].filter(paragraph =>
  paragraph.textContent === LEFT && !paragraph.matches('.sr-only, [role="status"]'))

// The line in the list's place when nobody is listed.
const nobodyLine = () => [...document.body.querySelectorAll('[role="dialog"] p')]
  .find(paragraph => paragraph.textContent === NOBODY)

// Leaves the space, confirming the question.
const confirmLeave = async () => {
  await click(button('Leave space'))
  await click(button('Leave'))
  await settle()
}

describe('SpaceMembersDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    Reflect.deleteProperty(Element.prototype, 'scrollIntoView')
  })

  describe('for an admin of a team space', () => {
    it('lists the members with their roles', async () => {
      await openAsAdmin()
      expect(document.body.querySelector('h2')?.textContent).toBe('Members of Platform')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comAdmin'])
    })

    it('adds the person picked with the role chosen for them, and gives the emptied field the focus', async () => {
      const { space } = await openAsAdmin()

      await pick(GRACE.id)
      await chooseRole('Role for the new member', 'Build')
      button('Add').focus()
      await add()

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'build')
      expect(rows()).toContain('grace@example.comBuild')
      expect(hasButton(`Remove ${GRACE.id}`)).toBe(true)
      expect(alerts()).toEqual([])
      expect(announced()).toBe('Added grace@example.com with the role Build.')
      // The button the add started from has nothing left to add.
      expect(personField()!.value).toBe('')
      expect(document.activeElement).toBe(personField())
    })

    it('offers the people the directory finds who are not members yet, and adds the one picked', async () => {
      const searchUsers = directoryOf({ id: GRACE.id, name: 'Grace Hopper' })
      const { space } = await openWithSearch(searchUsers)

      await type(personField()!, 'gra')
      const [result] = await directoryResults()
      // The directory leaves the searcher out itself.
      expect(searchUsers).toHaveBeenCalledExactlyOnceWith('gra', [ADA.id])
      // Text that is not a result is nobody to add.
      expect(button('Add').disabled).toBe(true)

      await click(result)
      expect(personField()!.value).toBe('Grace Hopper')
      await add()

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
      expect(personField()!.value).toBe('')
    })

    it('offers every role, and makes a member an admin', async () => {
      const { space } = await render(
        teamSpace('platform', 'Platform'), [member(ME, 'admin'), member(ADA, 'use')])
      expect(await roleLabels('Role for the new member')).toEqual(['Admin', 'Build', 'Use'])
      await pressEscape()

      await chooseRole('Role of Ada', 'Admin')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'admin')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comAdmin'])
    })

    it('holds back someone another admin made a member after the list was read', async () => {
      const { space } = await openAsAdmin()
      // Another admin's change: the list on show does not have Carol.
      await space.setMemberRole('carol@example.com', 'admin')
      space.setMemberRole.mockClear()

      await pick('carol@example.com')
      await add()

      // Sending her would have lowered her from admin to the role picked for the newcomer.
      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(alerts()).toEqual(['carol@example.com: Already a member. Change their role in the list.'])
      expect(rows()).toContain('carol@example.comAdmin')
      expect(announced()).toBe('')
    })

    it('keeps the person picked, with the reason, when the members cannot be read for the add', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.listMembers.mockRejectedValueOnce(new Error('The space is busy.'))

      await pick(GRACE.id)
      await add()

      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(alerts()).toEqual(['grace@example.com: The space is busy.'])
      expect(personField()!.value).toBe(GRACE.id)
    })

    it('keeps whoever could not be added, with the reason, until the field is edited, and adds the next', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.setMemberRole.mockImplementationOnce(async () => null)
      space.setMemberRole.mockImplementationOnce(async () => {
        throw new Error('Only an admin of this space can change its members.')
      })

      await pick('nobody')
      await add()
      expect(alerts()).toEqual(['nobody: No account found for that username or email.'])
      expect(personField()!.value).toBe('nobody')

      // The reason was about the person the edit gives up, before anyone else is taken.
      await type(personField()!, 'nobody2')
      expect(alerts()).toEqual([])

      await pick('carol@example.com')
      expect(alerts()).toEqual([])
      await add()
      expect(alerts()).toEqual(['carol@example.com: Only an admin of this space can change its members.'])

      // Already a member: sending her would set her role to the one picked for the newcomer.
      await pick(ADA.id)
      await add()
      expect(alerts()).toEqual(['ada@example.com: Already a member. Change their role in the list.'])

      await pick(GRACE.id)
      await add()
      expect(alerts()).toEqual([])
      expect(space.setMemberRole.mock.calls.map(([username]) => username))
        .toEqual(['nobody', 'carol@example.com', GRACE.id])
      expect(rows()).toEqual([
        'Me (you)me@example.comAdmin',
        'Adaada@example.comAdmin',
        'grace@example.comUse',
      ])
    })

    it('leaves in the field what was typed there while the add was in flight', async () => {
      const { space } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)

      await pick(GRACE.id)
      await add()
      expect(button('Adding…').disabled).toBe(true)
      await type(personField()!, 'carol')
      await act(async () => answer.resolve(member(GRACE, 'use')))
      await settle()

      expect(announced()).toBe('Added Grace with the role Use.')
      expect(personField()!.value).toBe('carol')
    })

    it('shows why an add was refused to a viewer who has lost the admin role, without the means to add', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      // Another admin lowered the viewer's role after the dialog opened.
      await space.setMemberRole(ME.id, 'build')
      space.setMemberRole.mockClear()
      space.setMemberRole.mockRejectedValueOnce(
        new Error('Only an admin of this space can change its members.'))

      await pick(GRACE.id)
      await add()

      expect(alerts()).toEqual(['grace@example.com: Only an admin of this space can change its members.'])
      expect(personField()).toBeNull()
      expect(rows()).toEqual(['Me (you)me@example.comBuild', 'Adaada@example.comAdmin'])
    })

    it('lowers a member’s role', async () => {
      const { space } = await openAsAdmin()

      await chooseRole('Role of Ada', 'Use')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
      expect(rows()).toEqual(['Me (you)me@example.comAdmin', 'Adaada@example.comUse'])
      expect(announced()).toBe('Ada’s role is now Use.')
    })

    it('sends nothing when the role chosen is the one the member has', async () => {
      const { space } = await openAsAdmin()

      await chooseRole('Role of Ada', 'Admin')

      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(announced()).toBe('')
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

    it('sends no role change for someone another admin has removed, whom it would let back in, and says so', async () => {
      const { space } = await openAsAdmin()
      // Removed by another admin, with the dialog still showing them.
      await space.removeMember(ADA.id)

      await chooseRole('Role of Ada', 'Use')

      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(space.members()).toEqual([member(ME, 'admin')])
      expect(rows()).toEqual(['Me (you)me@example.comAdmin'])
      expect(alerts()).toEqual(['Ada is no longer a member of this space. Their role was not changed.'])
      expect(announced()).toBe('')
    })

    it('says on their row that a role change let back in someone removed just before it', async () => {
      const { space } = await openAsAdmin()
      // Another admin removes Ada after the members were read for the change and before it.
      space.listMembers.mockImplementationOnce(async () => {
        const before = space.members()
        await space.removeMember(ADA.id)
        return before
      })

      await chooseRole('Role of Ada', 'Use')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
      expect(alerts()).toEqual(['Ada was no longer a member of this space. They are one again, as Use.'])
      expect(document.body.querySelector('ul[aria-label="Members"] [role="alert"]')).not.toBeNull()
      // Not announced as an ordinary change of role.
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
      await pick(GRACE.id)

      await click(button('Remove Ada'))
      expect(button('Add').disabled).toBe(true)
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
      expect(personField()).toBeNull()
    })
  })

  describe('taking the person to add', () => {
    it('adds on Enter once a person is held, and not on the Enter that took them', async () => {
      const { space } = await openAsAdmin()

      await pick(GRACE.id)
      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(personField()!.value).toBe(GRACE.id)
      expect(button('Add').disabled).toBe(false)

      await pressEnter()
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
      expect(announced()).toBe('Added grace@example.com with the role Use.')
    })

    it('takes text typed with spaces around it as the person without them', async () => {
      const { space } = await openAsAdmin()

      await pick(`  ${GRACE.id}  `)
      expect(personField()!.value).toBe(GRACE.id)

      await pressEnter()
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
    })

    it('offers text typed with spaces around it as a username or email without them', async () => {
      const { space } = await openWithSearch(directoryOf({ id: 'carol.b@example.com', name: 'Carol B' }))

      await type(personField()!, ' carol@example.com ')
      await directoryResults()
      await click(button(useAsTyped('carol@example.com')))

      expect(personField()!.value).toBe('carol@example.com')
      await add()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith('carol@example.com', 'use')
    })

    it('ignores Enter while the person is being composed', async () => {
      const { space } = await openAsAdmin()

      await type(personField()!, GRACE.id)
      await pressEnter({ isComposing: true })
      expect(button('Add').disabled).toBe(true)

      await pressEnter()
      await pressEnter({ isComposing: true })
      await settle()
      expect(space.setMemberRole).not.toHaveBeenCalled()
    })

    it('offers the typed text as a username or email once the search has settled, and adds it', async () => {
      const { space } = await openWithSearch(directoryOf({ id: 'carol.b@example.com', name: 'Carol B' }))

      await type(personField()!, 'carol@example.com')
      await directoryResults()
      await click(button(useAsTyped('carol@example.com')))

      expect(personField()!.value).toBe('carol@example.com')
      expect(document.activeElement).toBe(personField())
      expect(hasButton(useAsTyped('carol@example.com'))).toBe(false)
      await add()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith('carol@example.com', 'use')
    })

    it('takes the typed text on Enter when the directory has nobody to offer', async () => {
      const { space } = await openWithSearch(directoryOf())

      await type(personField()!, 'carol@example.com')
      await eventually(() => searchStatus() === 'No users found.')
      await pressEnter()

      expect(space.setMemberRole).not.toHaveBeenCalled()
      expect(button('Add').disabled).toBe(false)
      await pressEnter()
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith('carol@example.com', 'use')
    })

    it('takes the typed text on Enter when the directory search failed', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openWithSearch(vi.fn<SearchUsers>(
        () => new RpcPromise(Promise.reject<UserDirectoryRecord[]>(new Error('The directory is down.')))))

      await type(personField()!, 'carol@example.com')
      await eventually(() => searchStatus() === 'User search is temporarily unavailable.')
      expect(hasButton(useAsTyped('carol@example.com'))).toBe(true)
      await pressEnter()
      await add()

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith('carol@example.com', 'use')
    })

    it('leaves Enter to the field while it has results to offer', async () => {
      const { space } = await openWithSearch(directoryOf({ id: GRACE.id, name: 'Grace Hopper' }))

      await type(personField()!, 'gra')
      await directoryResults()
      await pressEnter()

      // The highlighted result is taken, and never the text.
      expect(personField()!.value).toBe('Grace Hopper')
      await add()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
    })

    it('offers nothing to use exactly while the search is under way', async () => {
      const answer = deferred<UserDirectoryRecord[]>()
      const searchUsers = vi.fn<SearchUsers>(() => new RpcPromise(answer.promise))
      await openWithSearch(searchUsers)

      await type(personField()!, 'carol@example.com')
      await eventually(() => searchUsers.mock.calls.length > 0)
      expect(searchStatus()).toBe('Searching…')
      expect(hasButton(useAsTyped('carol@example.com'))).toBe(false)
      await pressEnter()
      expect(button('Add').disabled).toBe(true)

      await act(async () => answer.resolve([]))
      expect(hasButton(useAsTyped('carol@example.com'))).toBe(true)
    })

    it('takes the offer of the typed text back as the text is edited, before the directory is asked about the edit', async () => {
      const searchUsers = directoryOf()
      await openWithSearch(searchUsers)
      await type(personField()!, 'carol')
      await eventually(() => hasButton(useAsTyped('carol')))
      const offer = button(useAsTyped('carol'))

      await type(personField()!, 'carol@example.com')

      // The search the field last told of was for the text before the edit. The offer goes as
      // it read then: it is never shown for text the directory has not been asked about.
      expect(searchUsers).toHaveBeenCalledOnce()
      expect(offer.isConnected).toBe(false)
      expect(offer.textContent).toBe(useAsTyped('carol'))
    })

    it('offers no text to use, and takes none on Enter, while the field holds nothing but spaces', async () => {
      await openWithSearch(directoryOf())

      expect(offersText()).toBe(false)
      await pressEnter()
      expect(button('Add').disabled).toBe(true)

      await type(personField()!, '   ')
      expect(offersText()).toBe(false)
      await pressEnter()
      expect(button('Add').disabled).toBe(true)
    })

    it('sends the directory the members to leave out, the viewer’s own id not among them, and no more than 999', async () => {
      const others = Array.from({ length: 1000 }, (_, index) =>
        member(person(`user${index}@example.com`, `User ${index}`), 'use'))
      const searchUsers = directoryOf()
      await openWithSearch(searchUsers, [member(ME, 'admin'), ...others])

      await type(personField()!, 'gra')
      await eventually(() => searchUsers.mock.calls.length > 0)

      const [, excluded] = searchUsers.mock.calls[0]
      expect(excluded).toHaveLength(999)
      expect(excluded).not.toContain(ME.id)
    })

    it('offers nobody who is a member, whatever the directory answers', async () => {
      await openWithSearch(directoryOf(ADA, { id: GRACE.id, name: 'Grace Hopper' }))

      await type(personField()!, 'a')

      expect((await directoryResults()).map(result => result.textContent))
        .toEqual(['Grace Hoppergrace@example.com'])
    })
  })

  describe('what an add comes to', () => {
    it('says that the person was a member already, and what the add did to their role', async () => {
      const { space } = await openAsAdmin()
      addedMeanwhile(space, 'admin')

      await pick('carol@example.com')
      await add()

      // By the name the space answered with.
      expect(alerts()).toEqual(['Carol was already a member, as Admin. Their role is now Use.'])
      expect(announced()).toBe('')
      expect(personField()!.value).toBe('')
      expect(rows()).toContain('Carolcarol@example.comUse')
    })

    it('says that the person was a member already when the add left their role as it was', async () => {
      const { space } = await openAsAdmin()
      addedMeanwhile(space, 'use')

      await pick('carol@example.com')
      await add()

      expect(alerts()).toEqual(['Carol was already a member, as Use.'])
      expect(announced()).toBe('')
      expect(personField()!.value).toBe('')
    })

    it('names the person an add with no answer was for when the field holds other text by then', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise.then(() => {
        throw new Error('Peer closed WebSocket')
      }))

      await pick(GRACE.id)
      await add()
      await type(personField()!, 'carol')
      await act(async () => answer.resolve(member(GRACE, 'use')))
      await settle()

      expect(alerts()).toEqual(['grace@example.com: Couldn’t add this person. Try again.'])
      expect(personField()!.value).toBe('carol')
      expect(announced()).toBe('')
    })

    it('names a person the directory found by name and id when they could not be added', async () => {
      const { space } = await openWithSearch(directoryOf({ id: GRACE.id, name: 'Grace Hopper' }))
      space.setMemberRole.mockImplementationOnce(async () => null)

      await type(personField()!, 'gra')
      await click((await directoryResults())[0])
      await add()

      // Two accounts may share a display name.
      expect(alerts()).toEqual([
        'Grace Hopper (grace@example.com): No account found for that username or email.',
      ])
      expect(personField()!.value).toBe('Grace Hopper')
    })

    it('takes the reason an add failed away when the person is added again', async () => {
      const { space } = await openAsAdmin()
      space.setMemberRole.mockImplementationOnce(async () => null)
      await pick('carol@example.com')
      await add()
      expect(alerts()).toEqual(['carol@example.com: No account found for that username or email.'])

      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)
      await add()
      // Gone as the add starts, not when it has worked.
      expect(alerts()).toEqual([])

      await act(async () => answer.resolve(member(person('carol@example.com', 'Carol'), 'use')))
      await settle()
      expect(alerts()).toEqual([])
      expect(announced()).toBe('Added Carol with the role Use.')
    })
  })

  describe('one change at a time', () => {
    it('keeps the control a change was started from enabled, and holds the others, until it has settled', async () => {
      const { space } = await openAsAdmin()
      await pick(GRACE.id)
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)

      await chooseOption('Role of Ada', 'Use')
      // A disabled select would drop the focus the choice left on it.
      expect(button('Role of Ada').disabled).toBe(false)
      expect(button('Role of Me').disabled).toBe(true)
      expect(button('Remove Ada').disabled).toBe(true)
      expect(button('Add').disabled).toBe(true)

      await act(async () => answer.resolve(member(ADA, 'use')))
      await settle()
      expect(['Role of Ada', 'Role of Me', 'Remove Ada', 'Add'].filter(label => button(label).disabled))
        .toEqual([])
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
    })

    it('marks the row of a member whose change is in flight as busy, and no other', async () => {
      const { space } = await openAsAdmin()
      const roleAnswer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => roleAnswer.promise)

      await chooseOption('Role of Ada', 'Use')
      expect(rowOf('Ada').getAttribute('aria-busy')).toBe('true')
      expect(rowOf('Me').hasAttribute('aria-busy')).toBe(false)
      await act(async () => roleAnswer.resolve(member(ADA, 'admin')))
      await settle()
      expect(rowOf('Ada').hasAttribute('aria-busy')).toBe(false)

      const removal = deferred<void>()
      space.removeMember.mockImplementationOnce(() => removal.promise)
      await click(button('Remove Ada'))
      expect(rowOf('Ada').getAttribute('aria-busy')).toBe('true')
      expect(rowOf('Me').hasAttribute('aria-busy')).toBe(false)
      await act(async () => removal.resolve())
      await settle()
      expect(rowOf('Ada').hasAttribute('aria-busy')).toBe(false)
      expect(rowOf('Me').hasAttribute('aria-busy')).toBe(false)
    })

    it('does nothing more on a second choice while the first is in flight', async () => {
      const { space } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)

      await chooseOption('Role of Ada', 'Use')
      await chooseOption('Role of Ada', 'Build')

      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')
    })

    it('marks a removal in flight on its button without disabling it', async () => {
      const { space } = await openAsAdmin()
      const removal = deferred<void>()
      space.removeMember.mockImplementationOnce(() => removal.promise)

      await click(button('Remove Ada'))
      expect(button('Remove Ada').disabled).toBe(false)
      expect(button('Remove Ada').getAttribute('aria-disabled')).toBe('true')

      await click(button('Remove Ada'))
      expect(space.removeMember).toHaveBeenCalledOnce()
    })

    it('marks a leave in flight on its button without disabling it, and holds the way back', async () => {
      const { space } = await openAsMember()
      const leave = deferred<void>()
      space.removeMember.mockImplementationOnce(() => leave.promise)

      await click(button('Leave space'))
      await click(button('Leave'))
      expect(button('Leaving…').disabled).toBe(false)
      expect(button('Leaving…').getAttribute('aria-disabled')).toBe('true')
      expect(button('Cancel').disabled).toBe(true)

      await click(button('Leaving…'))
      expect(space.removeMember).toHaveBeenCalledOnce()
    })

    it('holds every other change back, and does not close, while a leave is in flight', async () => {
      const { space, onClose, onLeft } = await openAsAdmin()
      const leave = deferred<void>()
      space.removeMember.mockImplementationOnce(() => leave.promise)
      const others = ['Role of Me', 'Role of Ada', 'Remove Ada', 'Add']
      await pick(GRACE.id)
      expect(held(...others)).toEqual([])

      await click(button('Leave space'))
      await click(button('Leave'))
      expect(held(...others)).toEqual(others)
      await pressEscape()
      expect(onClose).not.toHaveBeenCalled()
      expect(onLeft).not.toHaveBeenCalled()

      // Closing is the caller's once it is told of the leave, which a dialog that had closed
      // meanwhile would not report.
      await act(async () => leave.resolve())
      await settle()
      expect(onLeft).toHaveBeenCalledOnce()
    })

    it('does not close while an add is in flight', async () => {
      const { space, onClose } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)

      await pick(GRACE.id)
      await add()
      await pressEscape()
      expect(onClose).not.toHaveBeenCalled()

      await act(async () => answer.resolve(member(GRACE, 'use')))
      await settle()
      await pressEscape()
      expect(onClose).toHaveBeenCalledOnce()
    })

    it('holds every other change back while an add is in flight', async () => {
      const { space } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)
      const others = ['Role for the new member', 'Role of Me', 'Role of Ada', 'Remove Ada', 'Leave space']

      await pick(GRACE.id)
      await add()
      expect(held(...others)).toEqual(others)

      await act(async () => answer.resolve(member(GRACE, 'use')))
      await settle()
      expect(held(...others)).toEqual([])
    })

    it('holds the leave back, and its question once asked, while a member’s change is in flight', async () => {
      const { space } = await openAsAdmin()
      const changeRole = async (role: string) => {
        const answer = deferred<SpaceMemberInfo>()
        space.setMemberRole.mockImplementationOnce(() => answer.promise)
        await chooseOption('Role of Ada', role)
        return async () => {
          await act(async () => answer.resolve(member(ADA, 'admin')))
          await settle()
        }
      }

      let settleChange = await changeRole('Use')
      expect(held('Leave space')).toEqual(['Leave space'])
      await settleChange()
      expect(held('Leave space')).toEqual([])

      await click(button('Leave space'))
      settleChange = await changeRole('Build')
      expect(held('Cancel', 'Leave')).toEqual(['Cancel', 'Leave'])
      await settleChange()
      expect(held('Cancel', 'Leave')).toEqual([])
      expect(space.removeMember).not.toHaveBeenCalled()
    })

    it('sends an add once, however often Enter is pressed while it is in flight', async () => {
      const { space } = await openAsAdmin()
      const answer = deferred<SpaceMemberInfo>()
      space.setMemberRole.mockImplementationOnce(() => answer.promise)

      await pick(GRACE.id)
      await pressEnter()
      await settle()
      await pressEnter()
      await pressEnter()
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')

      await act(async () => answer.resolve(member(GRACE, 'use')))
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledOnce()
      expect(announced()).toBe('Added Grace with the role Use.')
    })

    it('starts no add from Enter in the field while another change is in flight', async () => {
      const { space } = await openAsAdmin()
      const removal = deferred<void>()
      space.removeMember.mockImplementationOnce(() => removal.promise)
      await pick(GRACE.id)

      await click(button('Remove Ada'))
      await pressEnter()
      await settle()
      expect(space.setMemberRole).not.toHaveBeenCalled()

      // The person is still held, and Enter adds them once the removal has settled.
      await act(async () => removal.resolve())
      await settle()
      await pressEnter()
      await settle()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
    })
  })

  describe('what the change before came to', () => {
    it('is taken off the status line and off the member’s row when the next change starts', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      const refusal = 'Only an admin of this space can change its members.'

      await chooseRole('Role of Ada', 'Use')
      expect(announced()).toBe('Ada’s role is now Use.')

      space.setMemberRole.mockRejectedValueOnce(new Error(refusal))
      await chooseRole('Role of Ada', 'Build')
      expect(announced()).toBe('')
      expect(rowOf('Ada').querySelector('[role="alert"]')?.textContent).toBe(refusal)

      const removal = deferred<void>()
      space.removeMember.mockImplementationOnce(() => removal.promise)
      await click(button('Remove Ada'))
      expect(alerts()).toEqual([])
      await act(async () => removal.resolve())
      await settle()
      expect(alerts()).toEqual([])
    })
  })

  describe('the focus of a control that a change took away', () => {
    it('gives the member list the focus when the removed member’s row goes', async () => {
      await openAsAdmin()
      button('Remove Ada').focus()

      await click(button('Remove Ada'))
      await settle()

      expect(hasButton('Remove Ada')).toBe(false)
      expect(document.activeElement).toBe(memberList())
    })

    it('gives the member list the focus when an admin lowers their own role', async () => {
      await openAsAdmin()

      await chooseRole('Role of Me', 'Use')

      expect(hasButton('Role of Me')).toBe(false)
      expect(document.activeElement).toBe(memberList())
    })

    it('leaves the focus where the user has put it meanwhile', async () => {
      const { space } = await openAsAdmin()
      const removal = deferred<void>()
      const remove = space.removeMember.getMockImplementation()!
      space.removeMember.mockImplementationOnce(async (profileId) => {
        await removal.promise
        await remove(profileId)
      })
      button('Remove Ada').focus()
      await click(button('Remove Ada'))

      personField()!.focus()
      await act(async () => removal.resolve())
      await settle()

      expect(hasButton('Remove Ada')).toBe(false)
      expect(document.activeElement).toBe(personField())
    })
  })

  describe('a refusal where the user acted', () => {
    it('shows a refused removal on the member it was about, and keeps the member', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.removeMember.mockRejectedValueOnce(
        new Error('Only an admin of this space can remove other members.'))

      await click(button('Remove Ada'))
      await settle()

      expect(alerts()).toEqual(['Only an admin of this space can remove other members.'])
      expect(rowOf('Ada').querySelector('[role="alert"]')).not.toBeNull()
      expect(rows()).toHaveLength(2)
      expect(announced()).toBe('')
    })

    it.each([
      ['removal', 'Couldn’t remove this member. Try again.', () => click(button('Remove Ada'))],
      ['role change', 'Couldn’t change the role. Try again.', () => chooseOption('Role of Ada', 'Use')],
    ])('says on the member’s row that a %s got no answer', async (_change, words, start) => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      const { space } = await openAsAdmin()
      space.removeMember.mockRejectedValueOnce(new Error('Peer closed WebSocket'))
      space.setMemberRole.mockRejectedValueOnce(new Error('Peer closed WebSocket'))

      await start()
      await settle()

      expect(alerts()).toEqual([words])
      expect(rowOf('Ada').querySelector('[role="alert"]')?.textContent).toBe(words)
      expect(rows()).toHaveLength(2)
    })
  })

  describe('an answer that comes after the dialog has gone', () => {
    it('reports no leave that is answered after the dialog has gone', async () => {
      const { space, onLeft, unmount } = await openAsMember()
      const leave = deferred<void>()
      space.removeMember.mockImplementationOnce(() => leave.promise)
      await click(button('Leave space'))
      await click(button('Leave'))

      await unmount()
      await act(async () => leave.resolve())
      await settle()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
      expect(onLeft).not.toHaveBeenCalled()
    })

    it('reports the leave when its effects are run twice, as a development build runs them', async () => {
      const space = fakeSpace(
        teamSpace('platform', 'Platform', 'use'), [member(ADA, 'admin'), member(ME, 'use')])
      const onLeft = vi.fn<() => void>()
      // A development build runs the effects of what mounts under `StrictMode` twice only when
      // what is around it was mounted before, as the page is before its dialog opens.
      const { rerender } = await mount(null, fakeApi({ openSpace: () => space.stub }))
      await rerender(
        <StrictMode>
          <SpaceMembersDialog spaceId="platform" onClose={() => {}} onLeft={onLeft} />
        </StrictMode>,
      )
      await settle()

      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      expect(onLeft).toHaveBeenCalledOnce()
    })
  })

  describe('for the owner of a personal space', () => {
    it('offers the owner of a personal space no way to add, change, remove or leave', async () => {
      await render(personalSpace(ME), [member(ME, 'admin')])

      expect(rows()).toEqual(['Me (you)me@example.comAdmin'])
      expect(personField()).toBeNull()
      expect(hasButton('Role of Me')).toBe(false)
      expect(hasButton('Leave space')).toBe(false)
    })
  })

  describe('for a member who is not an admin', () => {
    it('shows the list read-only', async () => {
      await openAsMember()

      expect(rows()).toEqual(['Adaada@example.comAdmin', 'Me (you)me@example.comUse'])
      expect(personField()).toBeNull()
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

    it('says that a leave got no answer, and reports nothing', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      const { space, onLeft } = await openAsMember()
      space.removeMember.mockRejectedValueOnce(new Error('Peer closed WebSocket'))

      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      expect(alerts()).toEqual(['Couldn’t leave the space. Try again.'])
      expect(onLeft).not.toHaveBeenCalled()
    })

    it('takes the reason a leave was refused away when the leave is tried again, and when it is declined', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const { space } = await openAsMember()
      const refusal = 'A space must keep at least one admin.'
      space.removeMember.mockRejectedValueOnce(new Error(refusal))
      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()
      expect(alerts()).toEqual([refusal])

      const again = deferred<void>()
      space.removeMember.mockImplementationOnce(() => again.promise.then(() => {
        throw new Error(refusal)
      }))
      await click(button('Leave'))
      expect(alerts()).toEqual([])
      await act(async () => again.resolve())
      await settle()
      expect(alerts()).toEqual([refusal])

      await click(button('Cancel'))
      await click(button('Leave space'))
      expect(alerts()).toEqual([])
    })
  })

  describe('for a sub-space', () => {
    it('says once that the members of the spaces above also have access, and the role the user holds here', async () => {
      // Given `use` in Infra itself, and an admin of Platform above it.
      await openSubspace([member(ME, 'use'), member(ADA, 'build')], 'admin')

      expect(notes().map(note => note.textContent)).toEqual([NOTE('Admin')])
      // Above the row that adds a person, and so above the list.
      expect(notes()[0].compareDocumentPosition(memberList()!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    })

    it('says nothing of spaces above for a space that reports no parent', async () => {
      await openAsAdmin()
      expect(notes()).toEqual([])
      expect(document.body.textContent).not.toContain('above')

      // A sub-space the user was only added to: the server does not tell them it is inside one.
      unmountAll()
      await openSubspace([member(ME, 'use'), member(ADA, 'admin')])
      expect(rows()).toEqual(['Me (you)me@example.comUse', 'Adaada@example.comAdmin'])
      expect(notes()).toEqual([])
      expect(document.body.textContent).not.toContain('above')
    })

    it('lists only the people added to the space itself', async () => {
      await openSubspace([member(ADA, 'build')], 'admin')

      expect(rows()).toEqual(['Adaada@example.comBuild'])
    })

    it('says that nobody has been added when the space has no member of its own', async () => {
      await openSubspace([], 'use')

      expect(memberList()).toBeNull()
      expect(nobodyLine()).toBeDefined()

      // With a member the line gives way to the list.
      unmountAll()
      await openSubspace([member(ADA, 'build')], 'use')
      expect(nobodyLine()).toBeUndefined()
    })

    it('lets an admin by inheritance who is not in the list add a person, change a role and remove a member', async () => {
      const { space } = await openSubspace([member(ADA, 'use')], 'admin')

      await pick(GRACE.id)
      await add()
      expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
      expect(rows()).toEqual(['Adaada@example.comUse', 'grace@example.comUse'])

      await chooseRole('Role of Ada', 'Build')
      expect(space.setMemberRole).toHaveBeenLastCalledWith(ADA.id, 'build')
      expect(rows()).toEqual(['Adaada@example.comBuild', 'grace@example.comUse'])

      await click(button('Remove Ada'))
      await settle()
      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ADA.id)
      expect(rows()).toEqual(['grace@example.comUse'])
      expect(alerts()).toEqual([])
    })

    it('goes by the role the space reports: a member given use there who is an admin above manages', async () => {
      await openSubspace([member(ME, 'use'), member(ADA, 'use')], 'admin')

      expect(personField()).not.toBeNull()
      expect(hasButton('Role of Me')).toBe(true)
      expect(hasButton('Remove Ada')).toBe(true)
    })

    it('gives a use member by inheritance nothing to change the members with', async () => {
      await openSubspace([member(ADA, 'admin')], 'use')

      expect(rows()).toEqual(['Adaada@example.comAdmin'])
      expect(personField()).toBeNull()
      expect(hasButton('Add')).toBe(false)
      expect(hasButton('Role of Ada')).toBe(false)
      expect(hasButton('Remove Ada')).toBe(false)
    })

    it('offers no leave to a user who is not in the list', async () => {
      await openSubspace([member(ADA, 'admin')], 'admin')

      expect(hasButton('Leave space')).toBe(false)

      // One who is in it is offered the leave, whatever they hold above.
      unmountAll()
      await openSubspace([member(ADA, 'admin'), member(ME, 'use')], 'admin')
      expect(hasButton('Leave space')).toBe(true)
    })

    it('lets a member of the space itself who also holds a role above leave it, stays open, and does not report that the user left', async () => {
      const { space, onLeft, onClose } = await openSubspace([member(ME, 'use'), member(ADA, 'admin')], 'build')

      await confirmLeave()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
      expect(onLeft).not.toHaveBeenCalled()
      expect(onClose).not.toHaveBeenCalled()
      expect(document.body.querySelector('h2')?.textContent).toBe('Members of Infra')
      expect(rows()).toEqual(['Adaada@example.comAdmin'])
      expect(hasButton('Leave space')).toBe(false)
      expect(hasButton('Leave')).toBe(false)
      expect(notes().map(note => note.textContent)).toEqual([NOTE('Build')])
    })

    it('says on screen, and announces, that the user is no longer one of the space’s own members but still has access', async () => {
      await openSubspace([member(ME, 'use'), member(ADA, 'admin')], 'build')
      expect(leftShown()).toEqual([])
      expect(statusLine()?.textContent).toBe('')

      await confirmLeave()

      // Once on screen, above the note, and once more in the line that is announced.
      expect(leftShown()).toHaveLength(1)
      expect(leftShown()[0].compareDocumentPosition(notes()[0]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
      expect(statusLine()?.textContent).toBe(LEFT)
    })

    it('does not say that the user left the list to one who was never in it', async () => {
      await openSubspace([member(ADA, 'admin')], 'admin')

      expect(notes()).toHaveLength(1)
      expect(leftShown()).toEqual([])
      expect(statusLine()?.textContent).toBe('')
    })

    it('takes that sentence away when the user is added to the space again', async () => {
      const { space } = await openSubspace([member(ME, 'use')], 'admin')
      await confirmLeave()
      expect(leftShown()).toHaveLength(1)
      expect(nobodyLine()).toBeDefined()

      // An admin by inheritance, they add themself back from the add row.
      await pick(ME.id)
      await add()

      expect(space.members().map(({ profile }) => profile.id)).toEqual([ME.id])
      expect(rows()).toHaveLength(1)
      expect(rows()[0]).toContain('(you)')
      expect(hasButton('Leave space')).toBe(true)
      expect(leftShown()).toEqual([])
    })

    it('gives the line that says nobody has been added the focus of the Remove that took the last member with it', async () => {
      await openSubspace([member(ADA, 'use')], 'admin')
      button('Remove Ada').focus()

      await click(button('Remove Ada'))
      await settle()

      expect(hasButton('Remove Ada')).toBe(false)
      expect(nobodyLine()).toBeDefined()
      expect(document.activeElement).toBe(nobodyLine())
    })

    it('reports the leave of a member of a sub-space who holds no role above it', async () => {
      const { space, onLeft } = await openSubspace([member(ADA, 'admin'), member(ME, 'use')])

      await confirmLeave()

      expect(space.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
      expect(onLeft).toHaveBeenCalledOnce()
    })
  })

  it('offers another try when the space cannot be opened, busy until the space has been read again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')])
    const openSpace = vi.fn<(id: string) => unknown>()
      .mockReturnValueOnce({ getInfo: lost, listMembers: lost, [Symbol.dispose]() {} })
      .mockReturnValue(space.stub)
    await mount(
      <SpaceMembersDialog spaceId="platform" onClose={() => {}} onLeft={() => {}} />,
      fakeApi({ openSpace }),
    )
    await settle()
    expect(alerts()).toEqual(['Couldn’t load this space.Try again'])

    // The space is opened again, and the button is busy until it has been read.
    const members = deferred<SpaceMemberInfo[]>()
    space.listMembers.mockImplementationOnce(() => members.promise)
    await click(button('Try again'))
    // Busy, and not disabled: a disabled button would drop the focus it has.
    expect(button('Try again').disabled).toBe(false)
    expect(button('Try again').getAttribute('aria-disabled')).toBe('true')

    await act(async () => members.resolve(space.members()))
    await settle()
    expect(rows()).toEqual(['Me (you)me@example.comAdmin'])
  })
})
