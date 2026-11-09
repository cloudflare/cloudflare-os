/* eslint-disable react/react-in-jsx-scope */
import { act, createRef, useState } from 'react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { fakeApi, mountRouted, teamSpace, unmountAll } from '../../features/spaces/spacesTestUtils'
import { SpaceHeader } from './SpaceHeader'
import '../../styles.css'

const LONG_NAME = 'Platform engineering and developer experience'

// Three spaces, each inside the one before it, outermost first, with long names.
const WAY_UP = Array.from({ length: 3 }, (_, index) =>
  teamSpace(`above-${index}`, `${LONG_NAME} ${index}`, 'admin', index > 0 ? `above-${index - 1}` : undefined))

// A way up short enough for one line beside the entry points.
const SHORT_WAY_UP = [
  teamSpace('org', 'Org', 'admin'),
  teamSpace('platform', 'Platform', 'admin', 'org'),
  teamSpace('above-2', 'Delivery', 'admin', 'platform'),
]

// A team space inside those, which the user is an admin of.
const INFRA = teamSpace('infra', 'Infrastructure and operations', 'admin', 'above-2')
// The same space as it reports itself to someone who holds no role above it.
const ROOT: SpaceInfo = teamSpace('infra', 'Infrastructure and operations')

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// Shows the way up the test last gave it, as the page shows the one its walk has found by then.
let showAncestors: (ancestors: SpaceInfo[]) => Promise<void>

// The header where the space's page puts it, with all three entry points. It mounts no dialog:
// `New space` only asks.
const render = async ({ info = INFRA, ancestors = WAY_UP }: { info?: SpaceInfo; ancestors?: SpaceInfo[] } = {}) => {
  const onOpen = vi.fn<() => void>()
  const onMembersOpen = vi.fn<() => void>()
  const buttonRef = createRef<HTMLButtonElement>()
  const headingRef = createRef<HTMLHeadingElement>()
  const Header = () => {
    const [shown, setShown] = useState(ancestors)
    showAncestors = next => act(async () => setShown(next))
    return (
      <div className="mx-auto flex h-full w-full max-w-4xl flex-col px-3 sm:px-10">
        {/* What comes before the page, as the sidebar does: where a Tab through it starts. */}
        <button className="sr-only">Before the page</button>
        <SpaceHeader
          info={info}
          ancestors={shown}
          headingRef={headingRef}
          onMembersOpen={onMembersOpen}
          newSpace={{ onOpen, buttonRef }}
        />
      </div>
    )
  }
  await mountRouted(fakeApi(), { at: '/workspaces', chrome: <Header /> })
  return { onOpen, onMembersOpen }
}

const header = () => document.querySelector('header')!
const nav = () => document.querySelector('nav[aria-label="Breadcrumb"]')
const name = () => document.querySelector('h1')!
const members = () => page.getByRole('button', { name: 'Members of Infrastructure and operations' })
const newSpace = () => page.getByRole('button', { name: 'New space in Infrastructure and operations' })
const newWorkspace = () => page.getByRole('link', { name: 'New workspace in Infrastructure and operations' })
const entryPoints = () => [members(), newSpace(), newWorkspace()].map(entry => entry.element())

const boxOf = (element: Element) => element.getBoundingClientRect()

// Whether `inner` lies within `outer`, to the half pixel a browser rounds a box by.
const isInside = (inner: Element, outer: Element) => {
  const box = boxOf(inner)
  const around = boxOf(outer)
  return box.left >= around.left - 0.5 && box.right <= around.right + 0.5
    && box.top >= around.top - 0.5 && box.bottom <= around.bottom + 0.5
}

const overlap = (one: Element, other: Element) => {
  const a = boxOf(one)
  const b = boxOf(other)
  return a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5
}

describe('SpaceHeader in a browser', () => {
  // The header's layout follows the window, not what it is inside, so each test sets the window
  // and the suite puts back the one it started with.
  let started: { width: number; height: number }
  beforeAll(() => {
    started = { width: window.innerWidth, height: window.innerHeight }
  })

  afterEach(async () => {
    unmountAll()
    await page.viewport(started.width, started.height)
  })

  it.each([
    { width: 390, height: 844 },
    { width: 320, height: 640 },
  ])('keeps the name, the way up and the three entry points inside a narrow window ($width wide)', async ({ width, height }) => {
    await page.viewport(width, height)
    await render()

    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(document.documentElement.clientWidth)
    expect(nav()!.querySelectorAll('a')).toHaveLength(3)
    for (const part of [nav()!, name(), ...entryPoints()]) {
      expect(isInside(part, header())).toBe(true)
    }
    const [first, second, third] = entryPoints()
    expect(overlap(first, second)).toBe(false)
    expect(overlap(second, third)).toBe(false)
    expect(overlap(first, third)).toBe(false)
    for (const entry of entryPoints()) expect(overlap(entry, name())).toBe(false)
  })

  it('puts the entry points beside the name where the window is wide', async () => {
    await page.viewport(1280, 800)
    await render()
    const column = name().parentElement!

    for (const entry of entryPoints()) {
      expect(boxOf(entry).left).toBeGreaterThanOrEqual(boxOf(name()).right - 0.5)
    }
    // On one line, which ends where the name's column does.
    const bottoms = entryPoints().map(entry => Math.round(boxOf(entry).bottom))
    expect(new Set(bottoms).size).toBe(1)
    expect(Math.abs(bottoms[0] - boxOf(column).bottom)).toBeLessThanOrEqual(1)
  })

  it('does not move the name when the way up arrives', async () => {
    await page.viewport(1280, 800)
    await render({ ancestors: [] })
    const before = boxOf(name()).top
    expect(nav()).toBeNull()

    // A way up that fits the line kept for it. One too long for a line goes on to the next.
    await showAncestors(SHORT_WAY_UP)

    expect(nav()!.querySelectorAll('a')).toHaveLength(3)
    expect(boxOf(name()).top).toBe(before)
  })

  it('gives no line to a way up for a space that reports no parent', async () => {
    await page.viewport(1280, 800)
    await render({ info: ROOT, ancestors: [] })

    // The name starts where the header's own padding ends.
    const padding = Number.parseFloat(getComputedStyle(header()).paddingTop)
    expect(boxOf(name()).top - boxOf(header()).top).toBe(padding)
    expect(nav()).toBeNull()
  })

  it('keeps a line for the way up of a space that reports a parent, before it is read', async () => {
    await page.viewport(1280, 800)
    await render({ ancestors: [] })

    const padding = Number.parseFloat(getComputedStyle(header()).paddingTop)
    expect(boxOf(name()).top - boxOf(header()).top).toBe(padding + 18)
  })

  it('reaches the crumbs, then Members, New space and New workspace, by Tab in that order', async () => {
    await page.viewport(1280, 800)
    await render()
    // From what comes before the page: the heading, which a user who arrives with the focus
    // nowhere is given, is under the way up.
    await act(async () => page.getByRole('button', { name: 'Before the page' }).element().focus())

    for (const crumb of WAY_UP) {
      await input(() => userEvent.tab())
      await expect.element(page.getByRole('link', { name: crumb.name, exact: true })).toHaveFocus()
    }
    await input(() => userEvent.tab())
    await expect.element(members()).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(newSpace()).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(newWorkspace()).toHaveFocus()
  })

  it('asks for a new space with Enter on its button', async () => {
    await page.viewport(1280, 800)
    const { onOpen, onMembersOpen } = await render()

    await act(async () => (newSpace().element() as HTMLElement).focus())
    await input(() => userEvent.keyboard('{Enter}'))

    expect(onOpen).toHaveBeenCalledOnce()
    expect(onMembersOpen).not.toHaveBeenCalled()
    // The header only asks: the page shows the dialog.
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
