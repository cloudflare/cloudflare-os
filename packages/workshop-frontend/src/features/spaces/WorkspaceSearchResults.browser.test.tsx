/* eslint-disable react/react-in-jsx-scope */
import { act, useRef, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { takeLostFocus } from './lostFocus'
import { deferred, fakeApi, mount, teamSpace, unmountAll } from './spacesTestUtils'
import type { SpaceListing } from './useSpaceListings'
import { WorkspaceSearchResults } from './WorkspaceSearchResults'
import '../../styles.css'

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// The results of a search over one team space whose listing failed, beside a field that stands
// for the list's search field. The listing's status is what the test's read answers once it
// settles, as the page's is what the space answers.
const Results = ({ onReload }: { onReload: () => Promise<SpaceListing['status']> }) => {
  const field = useRef<HTMLInputElement>(null)
  const [listing, setListing] = useState<SpaceListing['status']>('failed')
  return (
    <>
      <input ref={field} aria-label="Search workspaces" />
      <WorkspaceSearchResults
        sections={[
          { kind: 'personal', space: undefined, rows: [] },
          { kind: 'space', space: teamSpace('platform', 'Platform'), listing, rows: [] },
        ]}
        search="plan"
        renderRow={gadget => <p key={gadget.id}>{gadget.title}</p>}
        onListingReload={async () => setListing(await onReload())}
        onFocusLost={() => takeLostFocus(field.current)}
      />
    </>
  )
}

const tryAgain = () => page.getByRole('button', { name: 'Try again to search every space' })

describe('WorkspaceSearchResults in a browser', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('keeps the focus on Try again while the spaces are searched again, and hands it on when every space has been searched', async () => {
    let read = deferred<SpaceListing['status']>()
    await mount(<Results onReload={() => read.promise} />, fakeApi())
    expect(page.getByRole('alert').element().textContent).toContain('Couldn’t search Platform.')

    await input(() => userEvent.click(tryAgain()))
    await expect.element(tryAgain()).toHaveAttribute('aria-disabled', 'true')
    await expect.element(tryAgain()).toHaveFocus()

    await act(async () => read.resolve('failed'))
    await expect.element(tryAgain()).not.toHaveAttribute('aria-disabled')
    await expect.element(tryAgain()).toHaveFocus()

    read = deferred()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(tryAgain()).toHaveAttribute('aria-disabled', 'true')
    await act(async () => read.resolve('ready'))
    await expect.element(page.getByRole('alert')).not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Search workspaces' })).toHaveFocus()
  })
})
