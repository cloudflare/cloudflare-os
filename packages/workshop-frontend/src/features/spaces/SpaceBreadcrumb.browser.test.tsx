/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { SpaceBreadcrumb } from './SpaceBreadcrumb'
import { ME, fakeApi, mountRouted, personalSpace, teamSpace, unmountAll } from './spacesTestUtils'
import '../../styles.css'

const LONG_NAME = 'Platform engineering and developer experience'

// Five spaces, each inside the one before it, outermost first, with names longer than a crumb is.
const LONG_WAY_UP = Array.from({ length: 5 }, (_, index) =>
  teamSpace(`space-${index}`, `${LONG_NAME} ${index}`, 'use', index > 0 ? `space-${index - 1}` : undefined))

const TWO = [personalSpace(ME), teamSpace('archive', 'Archive', 'admin', personalSpace(ME).id)]

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// Shows the way up the test last gave it, as a page shows the one its walk has found by then.
let showAncestors: (ancestors: SpaceInfo[]) => Promise<void>
const Trail = ({ initial }: { initial: SpaceInfo[] }) => {
  const [ancestors, setAncestors] = useState(initial)
  showAncestors = next => act(async () => setAncestors(next))
  return (
    <>
      <SpaceBreadcrumb ancestors={ancestors} />
      <p data-testid="under">The heading under the way up</p>
    </>
  )
}

// The breadcrumb in a column `width` pixels wide, as the head of a space's page is on a phone.
const render = async (ancestors: SpaceInfo[], width = 390) => {
  const { router } = await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <div data-testid="column" style={{ width }}>
        <Trail initial={ancestors} />
      </div>
    ),
  })
  return { router }
}

const nav = () => document.querySelector('nav[aria-label="Breadcrumb"]')
const crumb = (name: string) => page.getByRole('link', { name, exact: true })
const under = () => document.querySelector('[data-testid="under"]')!.getBoundingClientRect()

describe('SpaceBreadcrumb in a browser', () => {
  afterEach(() => {
    unmountAll()
  })

  it('wraps a long way up inside the page’s width and cuts a long name', async () => {
    await render(LONG_WAY_UP)
    const column = document.querySelector('[data-testid="column"]')!
    const around = nav()!.getBoundingClientRect()
    const links = [...nav()!.querySelectorAll('a')]

    expect(links).toHaveLength(5)
    expect(column.scrollWidth).toBeLessThanOrEqual(column.clientWidth)
    expect(around.right).toBeLessThanOrEqual(column.getBoundingClientRect().right + 0.5)
    for (const link of links) {
      const box = link.getBoundingClientRect()
      expect(box.left).toBeGreaterThanOrEqual(around.left - 0.5)
      expect(box.right).toBeLessThanOrEqual(around.right + 0.5)
      // The name is cut where a crumb ends, and none takes more than its share of a line.
      expect(link.scrollWidth).toBeGreaterThan(link.clientWidth)
      expect(box.width).toBeLessThanOrEqual(192.5)
    }
    // Five crumbs do not fit one line of this column: they go on to the next.
    const lines = new Set(links.map(link => Math.round(link.getBoundingClientRect().top)))
    expect(lines.size).toBeGreaterThan(1)
  })

  it('reaches the crumbs by Tab, outermost first', async () => {
    await render(TWO)

    await input(() => userEvent.tab())
    await expect.element(crumb('Personal')).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(crumb('Archive')).toHaveFocus()
  })

  it('follows a crumb with Enter', async () => {
    const { router } = await render(TWO)

    await input(() => userEvent.tab())
    await input(() => userEvent.tab())
    await input(() => userEvent.keyboard('{Enter}'))

    await expect.poll(() => router.state.location.pathname).toBe('/spaces/archive')
  })

  it('keeps the height of one line with no ancestor, so that what is under it does not move when the links arrive', async () => {
    await render([])
    const before = under()

    // No landmark, and no text, while there is no way up to show.
    expect(nav()).toBeNull()
    expect(document.querySelector('[data-testid="column"]')!.firstElementChild!.textContent).toBe('')
    expect(before.top).toBeGreaterThanOrEqual(18)

    await showAncestors(TWO)

    await expect.element(crumb('Archive')).toBeVisible()
    expect(under().top).toBe(before.top)
  })
})
