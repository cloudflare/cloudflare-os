/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { RpcPromise } from 'capnweb'
import type {
  ServerConfig,
  SpaceMemberInfo,
  SpaceMemberRole,
  UserDirectoryRecord,
} from '@gadgets/workshop-shared/api'
import { ServerConfigContext } from '../../ServerConfigContext'
import { SpaceMembersDialog } from './SpaceMembersDialog'
import { ME, deferred, fakeApi, fakeSpace, member, mount, person, teamSpace, unmountAll } from './spacesTestUtils'
import '../../styles.css'

vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const ADA = person('ada@example.com', 'Ada')
const GRACE = person('grace@example.com', 'Grace')

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// What every call on a space that could not be opened rejects with.
const lost = async () => { throw new Error('Network connection lost.') }

type SearchUsers = (query: string, excludeIds: string[]) => RpcPromise<UserDirectoryRecord[]>

// The dialog for `ME` in `role`, beside Ada, who is an admin, and `others`. With `people`, the
// deployment searches the user directory, which answers every search with them.
const render = async ({ role = 'admin', people, others = [] }: {
  role?: SpaceMemberRole
  people?: UserDirectoryRecord[]
  others?: SpaceMemberInfo[]
} = {}) => {
  const space = fakeSpace(
    teamSpace('platform', 'Platform', role),
    [member(ME, role), member(ADA, 'admin'), ...others],
  )
  const searchUsers = vi.fn<SearchUsers>(() => new RpcPromise(Promise.resolve(people ?? [])))
  await mount(
    <ServerConfigContext.Provider value={{ userSearchEnabled: people !== undefined } as ServerConfig}>
      <SpaceMembersDialog spaceId="platform" onClose={() => {}} onLeft={() => {}} />
    </ServerConfigContext.Provider>,
    fakeApi({ openSpace: () => space.stub, searchUsers }),
  )
  await expect.element(memberList()).toBeVisible()
  return { space }
}

const memberList = () => page.getByRole('list', { name: 'Members' })
const typedField = () => page.getByRole('searchbox', { name: 'Username or email' })
const searchField = () => page.getByRole('combobox', { name: 'Search people' })
const roleOf = (name: string) => page.getByRole('combobox', { name: `Role of ${name}` })
const remove = (name: string) => page.getByRole('button', { name: `Remove ${name}` })
const rowOf = (name: string) => roleOf(name).element().closest('li')!

// An option of the role select that is open. Its options are rendered outside the dialog, where
// a query by role does not look while the dialog is open, so it is found in the page.
const roleOption = (label: string) => page.elementLocator(
  [...document.querySelectorAll('[role="option"]')].find(option => option.textContent === label)!)

// How much of the role select of `name` shows through, by everything between it and its row.
const roleOpacity = (name: string) => {
  let opacity = 1
  for (let node: Element | null = roleOf(name).element(); node && node.tagName !== 'LI'; node = node.parentElement) {
    opacity *= Number(getComputedStyle(node).opacity)
  }
  return opacity
}

// How much of the remove button of `name` shows through.
const removeOpacity = (name: string) => Number(getComputedStyle(remove(name).element()).opacity)

const rectOf = (element: Element) => element.getBoundingClientRect()

// Whether `inner` lies within `outer`, give or take the rounding of a pixel.
const isInside = (inner: DOMRect, outer: DOMRect) =>
  inner.top >= outer.top - 1 && inner.bottom <= outer.bottom + 1
  && inner.left >= outer.left - 1 && inner.right <= outer.right + 1

// The element that scrolls `element`: its nearest ancestor that scrolls what overflows it.
const scrollingBodyOf = (element: Element) => {
  let ancestor = element.parentElement
  while (ancestor && getComputedStyle(ancestor).overflowY !== 'auto') ancestor = ancestor.parentElement
  return ancestor
}

describe('SpaceMembersDialog in a browser', () => {
  // A window wide enough for the dialog to hang from its top edge, where what is under the
  // field's results moves up when they go.
  beforeEach(() => page.viewport(1024, 768))

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it.each([
    { name: 'desktop', width: 1024, height: 600 },
    { name: 'phone', width: 390, height: 640 },
  ])('stays inside a $name window however many members there are: the members scroll, and Leave space stays in view', async ({ width, height }) => {
    await page.viewport(width, height)
    await render({
      others: Array.from({ length: 60 }, (_, index) => member(person(`p${index}@example.com`, `Person ${index}`), 'use')),
    })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
    const leave = page.getByRole('button', { name: 'Leave space' })
    const close = page.getByRole('button', { name: 'Close' })

    expect(rectOf(dialog).top).toBeGreaterThanOrEqual(0)
    expect(rectOf(dialog).bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(isInside(rectOf(close.element()), rectOf(dialog))).toBe(true)
    expect(isInside(rectOf(leave.element()), rectOf(dialog))).toBe(true)

    const body = scrollingBodyOf(memberList().element())
    expect(body).not.toBeNull()
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight)
    expect(body!.contains(leave.element())).toBe(false)
    expect(rectOf(rowOf('Person 59')).top).toBeGreaterThanOrEqual(rectOf(body!).bottom)

    // The focus scrolls the last member into view, under the title and over the footer.
    await act(async () => remove('Person 59').element().focus())
    expect(isInside(rectOf(remove('Person 59').element()), rectOf(body!))).toBe(true)
    expect(isInside(rectOf(leave.element()), rectOf(dialog))).toBe(true)
  })

  it('adds a person by keyboard alone and keeps the focus in the field', async () => {
    const { space } = await render()

    await input(() => userEvent.fill(typedField(), GRACE.id))
    await input(() => userEvent.keyboard('{Enter}'))
    expect(space.setMemberRole).not.toHaveBeenCalled()
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.element(remove(GRACE.id)).toBeVisible()
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(GRACE.id, 'use')
    await expect.element(typedField()).toHaveValue('')
    await expect.element(typedField()).toHaveFocus()
  })

  it('gives the field the focus of the Add button, which an add leaves with nothing to add', async () => {
    const { space } = await render()

    await input(() => userEvent.fill(typedField(), GRACE.id))
    await input(() => userEvent.keyboard('{Enter}'))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Add', exact: true })))

    await expect.poll(() => space.setMemberRole.mock.calls).toEqual([[GRACE.id, 'use']])
    await expect.element(typedField()).toHaveValue('')
    await expect.element(typedField()).toHaveFocus()
  })

  it('picks a directory result and adds them with Enter', async () => {
    const { space } = await render({ people: [{ id: GRACE.id, name: 'Grace Hopper' }] })

    await input(() => userEvent.fill(searchField(), 'gra'))
    await expect.element(page.getByRole('option', { name: /Grace Hopper/ })).toBeVisible()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(searchField()).toHaveValue('Grace Hopper')
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.poll(() => space.setMemberRole.mock.calls).toEqual([[GRACE.id, 'use']])
    await expect.element(searchField()).toHaveValue('')
    await expect.element(searchField()).toHaveFocus()
  })

  it('keeps the focus on a member’s role while it is changed and after, and dims the role until the change has settled', async () => {
    const { space } = await render()
    const answer = deferred<SpaceMemberInfo>()
    space.setMemberRole.mockImplementationOnce(() => answer.promise)
    expect(roleOpacity('Ada')).toBe(1)

    await input(() => userEvent.click(roleOf('Ada')))
    await input(() => userEvent.click(roleOption('Use')))
    expect(space.setMemberRole).toHaveBeenCalledExactlyOnceWith(ADA.id, 'use')

    await expect.element(roleOf('Ada')).toHaveFocus()
    expect(rowOf('Ada').getAttribute('aria-busy')).toBe('true')
    await expect.poll(() => roleOpacity('Ada')).toBeLessThan(1)

    await act(async () => answer.resolve(member(ADA, 'use')))
    await expect.poll(() => rowOf('Ada').hasAttribute('aria-busy')).toBe(false)
    await expect.element(roleOf('Ada')).toHaveFocus()
    await expect.poll(() => roleOpacity('Ada')).toBe(1)
  })

  it('moves the focus to the member list when the role chosen was for someone another admin has removed', async () => {
    const { space } = await render()
    await space.removeMember(ADA.id)

    await input(() => userEvent.click(roleOf('Ada')))
    await input(() => userEvent.click(roleOption('Use')))

    await expect.element(page.getByRole('alert'))
      .toHaveTextContent('Ada is no longer a member of this space. Their role was not changed.')
    await expect.element(roleOf('Ada')).not.toBeInTheDocument()
    expect(space.setMemberRole).not.toHaveBeenCalled()
    await expect.element(memberList()).toHaveFocus()
  })

  it('moves the focus to the member list when a member is removed, and keeps it on the button when the removal is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { space } = await render()
    let refuse!: (err: Error) => void
    space.removeMember.mockReturnValueOnce(new Promise<void>((_, reject) => { refuse = reject }))

    await input(() => userEvent.click(remove('Ada')))
    await expect.element(remove('Ada')).toHaveAttribute('aria-disabled', 'true')
    await expect.element(remove('Ada')).toHaveFocus()

    await act(async () => refuse(new Error('Only an admin of this space can remove other members.')))
    await expect.element(page.getByRole('alert'))
      .toHaveTextContent('Only an admin of this space can remove other members.')
    await expect.element(remove('Ada')).not.toHaveAttribute('aria-disabled')
    await expect.element(remove('Ada')).toHaveFocus()

    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(remove('Ada')).not.toBeInTheDocument()
    await expect.element(memberList()).toHaveFocus()
  })

  it('dims a member’s remove button until the removal has settled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { space } = await render()
    let refuse!: (err: Error) => void
    space.removeMember.mockReturnValueOnce(new Promise<void>((_, reject) => { refuse = reject }))
    expect(removeOpacity('Ada')).toBe(1)

    await input(() => userEvent.click(remove('Ada')))
    await expect.element(remove('Ada')).toHaveAttribute('aria-disabled', 'true')
    await expect.poll(() => removeOpacity('Ada')).toBeLessThan(1)

    await act(async () => refuse(new Error('Only an admin of this space can remove other members.')))
    await expect.element(remove('Ada')).not.toHaveAttribute('aria-disabled')
    await expect.poll(() => removeOpacity('Ada')).toBe(1)
  })

  it('puts Leave space at the start of the footer, in line with the start of the member list', async () => {
    await render({ role: 'use' })
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
    await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
    const leave = page.getByRole('button', { name: 'Leave space' })

    // The far end of the footer is where a dialog has its primary actions.
    expect(Math.abs(rectOf(leave.element()).left - rectOf(memberList().element()).left)).toBeLessThanOrEqual(2)
  })

  it('keeps the focus on Leave when the leave is refused', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { space } = await render({ role: 'use' })
    let refuse!: (err: Error) => void
    space.removeMember.mockReturnValueOnce(new Promise<void>((_, reject) => { refuse = reject }))

    await input(() => userEvent.click(page.getByRole('button', { name: 'Leave space' })))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Leave', exact: true })))
    await expect.element(page.getByRole('button', { name: /Leaving…/ })).toHaveFocus()

    // A press while the leave is in flight, by the keyboard the focus still serves.
    await input(() => userEvent.keyboard('{Enter}'))
    expect(space.removeMember).toHaveBeenCalledOnce()

    await act(async () => refuse(new Error('A space must keep at least one admin.')))
    await expect.element(page.getByRole('alert')).toHaveTextContent('A space must keep at least one admin.')
    await expect.element(page.getByRole('button', { name: 'Leave', exact: true })).toHaveFocus()
  })

  it('gives the member list the focus when a leave that leaves the user a member takes Leave away, and shows what happened', async () => {
    // Infra, inside Platform: the user was added to Infra itself and holds a role in Platform.
    const space = fakeSpace(
      teamSpace('infra', 'Infra', 'use', 'platform'),
      [member(ME, 'use'), member(ADA, 'admin')],
      [],
      { inherited: 'build' },
    )
    const onLeft = vi.fn<() => void>()
    await mount(
      <SpaceMembersDialog spaceId="infra" onClose={() => {}} onLeft={onLeft} />,
      fakeApi({ openSpace: () => space.stub }),
    )
    await expect.element(memberList()).toBeVisible()
    const leaveSpace = page.getByRole('button', { name: 'Leave space' })
    const leave = page.getByRole('button', { name: 'Leave', exact: true })

    // By keyboard alone: the question takes the focus to Cancel, and Leave is next.
    await act(async () => (leaveSpace.element() as HTMLElement).focus())
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(page.getByRole('button', { name: 'Cancel' })).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(leave).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.element(leave).not.toBeInTheDocument()
    await expect.element(leaveSpace).not.toBeInTheDocument()
    // Leave went with the user's place in the list, and the list has the focus it had.
    await expect.element(memberList()).toHaveFocus()
    expect(space.members().map(({ profile }) => profile.id)).toEqual([ADA.id])
    expect(onLeft).not.toHaveBeenCalled()

    // What happened is on screen, in the dialog's body above the list, and not only announced.
    const shown = page.getByText('You are no longer one of this space’s own members.', { exact: false }).first()
    await expect.element(shown).toBeVisible()
    expect(shown.element().matches('.sr-only, [role="status"]')).toBe(false)
    expect(rectOf(shown.element()).width).toBeGreaterThan(200)
    expect(isInside(rectOf(shown.element()), rectOf(scrollingBodyOf(memberList().element())!))).toBe(true)
    expect(rectOf(shown.element()).bottom).toBeLessThanOrEqual(rectOf(memberList().element()).top)
  })

  it.each([
    ['somebody else', [{ id: 'carol.b@example.com', name: 'Carol B' }]],
    ['nobody', []],
  ])('takes the typed text from the button under the field with a real press, when the directory has %s on show', async (_found, people) => {
    const { space } = await render({ people })

    await input(() => userEvent.fill(searchField(), 'carol@example.com'))
    const useText = page.getByRole('button', { name: 'Use “carol@example.com” as a username or email' })
    await expect.element(useText).toBeVisible()
    // The field's results are open above the button, and would go if the press took the focus.
    await expect.element(page.getByRole('listbox', { name: 'Matching people' })).toBeVisible()
    await input(() => userEvent.click(useText))

    await expect.element(page.getByRole('button', { name: 'Add', exact: true })).toBeEnabled()
    await expect.element(searchField()).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.poll(() => space.setMemberRole.mock.calls).toEqual([['carol@example.com', 'use']])
  })

  it('keeps the focus on Try again while the space is read again, and gives it to the member list when the read works', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = fakeSpace(teamSpace('platform', 'Platform'), [member(ME, 'admin')])
    const openSpace = vi.fn<(id: string) => unknown>()
      .mockReturnValueOnce({ getInfo: lost, listMembers: lost, [Symbol.dispose]() {} })
      .mockReturnValue(space.stub)
    await mount(
      <SpaceMembersDialog spaceId="platform" onClose={() => {}} onLeft={() => {}} />,
      fakeApi({ openSpace }),
    )
    const tryAgain = page.getByRole('button', { name: /Try again/ })
    await expect.element(tryAgain).toBeVisible()
    const members = deferred<SpaceMemberInfo[]>()
    space.listMembers.mockImplementationOnce(() => members.promise)

    await input(() => userEvent.click(tryAgain))
    await expect.element(tryAgain).toHaveAttribute('aria-disabled', 'true')
    await expect.element(tryAgain).toHaveFocus()

    await act(async () => members.resolve(space.members()))
    await expect.element(memberList()).toHaveFocus()
  })
})
