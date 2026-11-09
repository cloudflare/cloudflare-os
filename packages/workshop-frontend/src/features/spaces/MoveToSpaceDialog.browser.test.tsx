/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { MoveToSpaceDialog } from './MoveToSpaceDialog'
import {
  ME,
  fakeApi,
  fakeSpace,
  member,
  mount,
  openSpaceAmong,
  personalSpace,
  subspace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import '../../styles.css'

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// The dialog for a workspace in the personal space of a user in `teamSpaces` team spaces, the
// first of which holds `subspaces` sub-spaces, once it has come to rest where it opens.
const render = async (
  teamSpaces: number,
  moveToSpace: Overseer['moveToSpace'] = async () => {},
  subspaces = 0,
) => {
  const overseer = {
    moveToSpace: vi.fn<Overseer['moveToSpace']>(moveToSpace),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  const first = fakeSpace(teamSpace('s0', 'Space 0'), [member(ME, 'admin')], [], {
    subspaces: Array.from({ length: subspaces }, (_, index) =>
      subspace(`sub${index}`, `Sub ${String(index).padStart(2, '0')}`)),
  })
  await mount(
    <MoveToSpaceDialog
      workspace={{ id: 'w1', title: 'Roadmap', spaceId: undefined }}
      spaces={[
        personalSpace(ME),
        ...Array.from({ length: teamSpaces }, (_, index) => teamSpace(`s${index}`, `Space ${index}`)),
      ]}
      onClose={() => {}}
      onMoved={() => {}}
      onMoveFailed={async () => {}}
    />,
    fakeApi({
      openWorkspace: () => overseer,
      openSpace: openSpaceAmong([first]),
    }),
  )
  const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!
  await Promise.all(dialog.getAnimations({ subtree: true }).map(animation => animation.finished))
  return { overseer, dialog, first }
}

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

describe('MoveToSpaceDialog in a browser', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it.each([
    { name: 'desktop', width: 1024, height: 600 },
    { name: 'phone', width: 390, height: 640 },
  ])('keeps its buttons in view and scrolls its spaces in a $name window', async ({ width, height }) => {
    await page.viewport(width, height)
    const { overseer, dialog } = await render(40)
    const move = page.getByRole('button', { name: 'Move' })
    const cancel = page.getByRole('button', { name: 'Cancel' })
    const last = page.getByRole('radio', { name: 'Space 39' })

    expect(rectOf(dialog).top).toBeGreaterThanOrEqual(0)
    expect(rectOf(dialog).bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(isInside(rectOf(move.element()), rectOf(dialog))).toBe(true)
    expect(isInside(rectOf(cancel.element()), rectOf(dialog))).toBe(true)

    const body = scrollingBodyOf(document.querySelector('[role="radiogroup"]')!)
    expect(body).not.toBeNull()
    expect(body!.scrollHeight).toBeGreaterThan(body!.clientHeight)
    expect(rectOf(last.element()).top).toBeGreaterThanOrEqual(rectOf(body!).bottom)

    // The press scrolls the option into view.
    await input(() => userEvent.click(last))
    expect(isInside(rectOf(last.element()), rectOf(body!))).toBe(true)
    expect(isInside(rectOf(move.element()), rectOf(dialog))).toBe(true)

    await input(() => userEvent.click(move))
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('s39')
  })

  it.each([
    { name: 'desktop', width: 1024, height: 600 },
    { name: 'phone', width: 390, height: 640 },
  ])('shows a refused move beside its buttons, whatever the spaces are scrolled to, in a $name window', async ({ width, height }) => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await page.viewport(width, height)
    const { dialog } = await render(40, async () => {
      throw new Error('No such space, or you are not a member of it.')
    })

    // The first space, so that the list stays scrolled to its top, far from its end.
    await input(() => userEvent.click(page.getByRole('radio', { name: 'Space 0' })))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Move' })))

    const refusal = page.getByRole('alert')
    await expect.element(refusal).toHaveTextContent('No such space, or you are not a member of it.')
    const body = scrollingBodyOf(document.querySelector('[role="radiogroup"]')!)!
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)
    // Under the scrolling body, so no scrolling of it hides the refusal.
    expect(body.contains(refusal.element())).toBe(false)
    expect(rectOf(refusal.element()).top).toBeGreaterThanOrEqual(rectOf(body).bottom - 1)
    expect(isInside(rectOf(refusal.element()), rectOf(dialog))).toBe(true)
    expect(isInside(rectOf(page.getByRole('button', { name: 'Move' }).element()), rectOf(dialog))).toBe(true)
  })

  it('keeps Move in view when a space is expanded to many sub-spaces in a short window', async () => {
    await page.viewport(1024, 600)
    const { overseer, dialog } = await render(1, undefined, 40)
    const move = page.getByRole('button', { name: 'Move' })
    const body = scrollingBodyOf(document.querySelector('[role="radiogroup"]')!)!
    expect(body.scrollHeight).toBe(body.clientHeight)

    await input(() => userEvent.click(page.getByRole('button', { name: 'Sub-spaces of Space 0', exact: true })))
    const last = page.getByRole('radio', { name: 'Sub 39' })
    await expect.element(last).toBeInTheDocument()

    // The sub-spaces scroll inside the dialog, which stays in the window with its buttons.
    expect(body.scrollHeight).toBeGreaterThan(body.clientHeight)
    expect(rectOf(last.element()).top).toBeGreaterThanOrEqual(rectOf(body).bottom)
    expect(rectOf(dialog).top).toBeGreaterThanOrEqual(0)
    expect(rectOf(dialog).bottom).toBeLessThanOrEqual(window.innerHeight)
    expect(isInside(rectOf(move.element()), rectOf(dialog))).toBe(true)

    await input(() => userEvent.click(last))
    expect(isInside(rectOf(last.element()), rectOf(body))).toBe(true)
    expect(isInside(rectOf(move.element()), rectOf(dialog))).toBe(true)

    await input(() => userEvent.click(move))
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('sub39')
  })

  it('gives the expand button the focus when another try shows the sub-spaces', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await page.viewport(1024, 768)
    const { first } = await render(1, undefined, 2)
    first.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    const expand = page.getByRole('button', { name: 'Sub-spaces of Space 0', exact: true })
    await input(() => userEvent.click(expand))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Space 0' })
    await expect.element(retry).toBeVisible()

    await input(() => userEvent.click(retry))

    await expect.element(page.getByRole('radio', { name: 'Sub 00' })).toBeVisible()
    await expect.element(expand).toHaveFocus()
    // The dialog takes the focus a control drops once more on the frame after: the button keeps it.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await expect.element(expand).toHaveFocus()
    // And the keyboard goes on from there.
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(expand).toHaveAttribute('aria-expanded', 'false')
  })

  it('leaves the focus on a Try again that failed again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await page.viewport(1024, 768)
    const { first } = await render(1, undefined, 2)
    let fail!: (err: Error) => void
    first.listSubspaces
      .mockRejectedValueOnce(new Error('boom'))
      .mockImplementationOnce(() => new Promise((_, reject) => { fail = reject }))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Sub-spaces of Space 0', exact: true })))
    const retry = page.getByRole('button', { name: 'Try again to load the sub-spaces of Space 0' })
    await expect.element(retry).toBeVisible()

    await input(() => userEvent.click(retry))
    await expect.element(retry).toHaveAttribute('aria-disabled', 'true')
    await act(async () => fail(new Error('boom')))

    await expect.element(retry).not.toHaveAttribute('aria-disabled')
    await expect.element(retry).toHaveFocus()
    // Nothing left the row, so nothing takes the focus on the frame after either.
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    await expect.element(retry).toHaveFocus()
    expect(first.listSubspaces).toHaveBeenCalledTimes(2)
  })

  it('keeps the focus on Move while the workspace is moved and when the server refuses the move', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await page.viewport(1024, 768)
    let refuse!: (err: Error) => void
    const { overseer } = await render(3, () => new Promise<void>((_, reject) => { refuse = reject }))

    await input(() => userEvent.click(page.getByRole('radio', { name: 'Space 1' })))
    await input(() => userEvent.click(page.getByRole('button', { name: 'Move' })))
    // The spinner is part of the busy button's name, which a string would have to give whole.
    await expect.element(page.getByRole('button', { name: /Moving…/ })).toHaveFocus()

    // A press while the move is in flight, by the keyboard the focus still serves.
    await input(() => userEvent.keyboard('{Enter}'))
    expect(overseer.moveToSpace).toHaveBeenCalledExactlyOnceWith('s1')

    await act(async () => refuse(new Error('No such space, or you are not a member of it.')))
    await expect.element(page.getByRole('alert'))
      .toHaveTextContent('No such space, or you are not a member of it.')
    await expect.element(page.getByRole('button', { name: 'Move' })).toHaveFocus()
  })
})
