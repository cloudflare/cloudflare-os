// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { DeploymentUpdateStatus } from '@gadgets/workshop-shared/api'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import { AdminUpdatesPanel } from './AdminUpdatesPanel'
import { testUpdateStatus } from './updateStatusFixture'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

describe('AdminUpdatesPanel', () => {
  let container: HTMLDivElement
  let root: Root

  const render = async (status: DeploymentUpdateStatus) => {
    await act(async () => { root.render(<AdminUpdatesPanel status={status} />) })
  }

  // The value shown beside each label of the panel's description list.
  const field = (label: string) => {
    const term = [...container.querySelectorAll('dt')].find(dt => dt.textContent === label)
    if (!term) throw new Error(`no ${label} field`)
    return term.nextElementSibling?.textContent
  }

  const updateLink = () =>
    [...container.querySelectorAll('a')].find(link => link.textContent?.trim() === 'Update')

  beforeEach(() => {
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('shows the running and newest release, when it was checked, and that an update is available', async () => {
    const checkedAt = new Date('2026-10-03T12:30:00Z')

    await render(testUpdateStatus({
      currentReleaseId: 'r100-aaaaaaa',
      latestReleaseId: 'r101-bbbbbbb',
      checkedAt,
    }))

    expect(field('Running release')).toBe('r100-aaaaaaa')
    expect(field('Newest release')).toBe('r101-bbbbbbb')
    expect(field('Last checked')).toBe(formatFullTimestamp(checkedAt))
    expect(field('Update available')).toBe('Yes')
  })

  it('says when the deployment already runs the newest release', async () => {
    await render(testUpdateStatus({
      latestReleaseId: 'r100-aaaaaaa',
      updateAvailable: false,
      availableSince: undefined,
      notify: false,
    }))

    expect(field('Update available')).toBe('No')
  })

  it('says that nothing is known before a check has succeeded', async () => {
    await render(testUpdateStatus({
      latestReleaseId: undefined,
      updateAvailable: false,
      availableSince: undefined,
      notify: false,
      checkedAt: undefined,
    }))

    expect(field('Running release')).toBe('r100-aaaaaaa')
    expect(field('Newest release')).toBe('No check has succeeded yet')
    expect(field('Last checked')).toBe('Never')
    expect(field('Update available')).toBe('Not known until a check succeeds')
  })

  it('links Update to the deploy flow in a new tab', async () => {
    const updateUrl = 'https://deploy.example.com/#flow=upgrade&account=acct&installation=0123abcd&name=os'

    await render(testUpdateStatus({ updateUrl }))

    const link = updateLink()
    expect(link?.getAttribute('href')).toBe(updateUrl)
    expect(link?.getAttribute('target')).toBe('_blank')
    expect(link?.getAttribute('rel')).toContain('noopener')
  })

  // The deploy flow, not this page, decides whether there is anything to install.
  it('offers Update when no update is known', async () => {
    await render(testUpdateStatus({ updateAvailable: false, notify: false }))

    expect(updateLink()).toBeDefined()
  })

  it.each([
    'javascript:alert(1)',
    'data:text/html,<p>hi</p>',
    '/#flow=upgrade',
    'not a url',
    '',
  ])('renders no Update link for %j', async (updateUrl) => {
    await render(testUpdateStatus({ updateUrl }))

    expect(updateLink()).toBeUndefined()
    expect(container.querySelector('a')).toBeNull()
  })

  it('warns, as an alert, that a modified deployment cannot be upgraded', async () => {
    await render(testUpdateStatus({ modified: true, notify: false }))

    const alert = container.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('This deployment was changed outside the deploy flow')
    expect(alert?.textContent).toContain('refuse to upgrade')
    // Still offered: the deploy flow explains the refusal itself.
    expect(updateLink()).toBeDefined()
  })

  it('shows no warning for an unmodified deployment', async () => {
    await render(testUpdateStatus({ modified: false }))

    expect(container.querySelector('[role="alert"]')).toBeNull()
  })
})
