// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResourcePreview } from '@gadgets/workshop-shared/gatekeeper'

const state = vi.hoisted(() => ({
  preview: null as ResourcePreview | null,
  opened: [] as string[],
  disposed: 0,
  asked: [] as unknown[][],
}))
// One API object, as the real context holds.
const api = vi.hoisted(() => ({
  openWorkspace: (id: string) => {
    state.opened.push(id)
    return {
      previewResource: async (...args: unknown[]) => { state.asked.push(args); return state.preview },
      [Symbol.dispose]: () => { state.disposed++ },
    }
  },
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))

import { makeTestRoot } from '../../action-test-harness'
import { documentFixture } from '../resource-preview/fixtures'
import { ExternalFilePreviewPane } from './ExternalFilePreviewPane'
import type { ExternalFileSource } from './externalFiles'

const testRoot = makeTestRoot()
afterEach(() => {
  testRoot.cleanup()
  Object.assign(state, { preview: null, opened: [], disposed: 0, asked: [] })
})

const file: ExternalFileSource = {
  workspaceId: 'w1', gatekeeperId: 7, subjectId: '1AuroraLaunchPlan', title: 'Aurora Launch Plan',
  url: 'https://docs.google.com/document/d/1AuroraLaunchPlan/edit', kind: 'document',
  mediaType: 'application/vnd.google-apps.document', date: new Date(0),
}

const render = async () => {
  await testRoot.render(<ExternalFilePreviewPane file={file} onClose={() => {}} expanded={false} onExpandedChange={() => {}} />)
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

const link = () => [...document.querySelectorAll('a')].find(a => a.textContent?.includes('Open in Docs'))

describe('ExternalFilePreviewPane', () => {
  it('draws the file through its workspace connection, with a link to its editor', async () => {
    state.preview = { ...documentFixture, actions: [] }
    await render()
    expect(state.opened).toEqual(['w1'])
    expect(state.asked).toEqual([[7, '1AuroraLaunchPlan']])
    expect(document.body.textContent).toContain('Aurora Launch Plan')
    expect(link()?.getAttribute('href')).toBe(file.url)
    expect(document.body.textContent).not.toContain('waiting for review')
  })

  it('says what of it is still waiting for review', async () => {
    state.preview = documentFixture
    await render()
    expect(document.body.textContent).toContain('Shows 3 changes waiting for review')
  })

  it('offers only the link for a file its connection cannot draw, and releases the workspace', async () => {
    await render()
    expect(document.body.textContent).toContain("Aurora Launch Plan can't be shown here.")
    expect(document.querySelectorAll('a').length).toBe(2)
    testRoot.cleanup()
    expect(state.disposed).toBe(1)
  })
})
