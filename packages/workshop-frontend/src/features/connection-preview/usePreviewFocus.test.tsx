// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, expect, it } from 'vitest'
import { makeTestRoot } from '../../action-test-harness'
import { usePreviewFocus } from './usePreviewFocus'

const DOC = { gatekeeperId: 7 }
const FILE = { gatekeeperId: 8, item: 'docs:folder/file' }

const view = makeTestRoot()
afterEach(() => view.cleanup())

it('sends a preview back to the spot its frame last reported, and an item with none to the item', async () => {
  let focusOf!: ReturnType<typeof usePreviewFocus>
  const Probe = ({ workspaceId }: { workspaceId: string }) => {
    focusOf = usePreviewFocus(workspaceId)
    return null
  }
  await view.render(<Probe workspaceId="a" />)
  expect([focusOf(DOC).latestAnchor(), focusOf(FILE).latestAnchor()]).toEqual([undefined, FILE.item])

  const doc = focusOf(DOC)
  doc.onFocusChange({ anchor: '?tab=t.1', label: 'Plan' })
  focusOf(FILE).onFocusChange({ anchor: `${FILE.item} 9`, label: 'Spreadsheet › Costs' })
  // The frame that reported it is sent there too, should its code be loaded again.
  expect(doc.latestAnchor()).toBe('?tab=t.1')
  // Another file of the same connection has a spot of its own.
  expect(focusOf({ ...FILE, item: 'docs:folder/other' }).anchor).toBe('docs:folder/other')
  await view.render(<Probe workspaceId="a" />)
  expect([focusOf(DOC).anchor, focusOf(FILE).anchor]).toEqual(['?tab=t.1', `${FILE.item} 9`])

  // A spot that is no longer there is given up for where the preview starts.
  focusOf(FILE).onFocusChange(null)
  expect(focusOf(FILE).anchor).toBe(FILE.item)

  // Another workspace numbers its connections from the same start.
  await view.render(<Probe workspaceId="b" />)
  expect(focusOf(DOC).anchor).toBeUndefined()
})
