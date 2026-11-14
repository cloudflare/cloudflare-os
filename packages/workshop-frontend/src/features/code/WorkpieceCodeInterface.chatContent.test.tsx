// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GadgetSummary } from '@gadgets/workshop-shared/api'
import type { ChatCodeChanges } from '../../ChatInterface'
import type { ChatContentReader } from './otClient'

// Covers the code view lending out the selected chat's content (see ChatContentReader), which
// is how the chat finds unresolved merge conflicts before it accepts. The editors and the file
// list are stubbed out: nothing here is about what they show.

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./CodeEditor', () => ({ default: () => null }))
vi.mock('./CodeDiffEditor', () => ({ default: () => null }))
vi.mock('./FileBrowser', async (importOriginal) => ({
  ...await importOriginal() as typeof import('./FileBrowser'),
  default: () => null,
}))

import WorkpieceCodeInterface from './WorkpieceCodeInterface'

const CHAT_ID = 1
const GADGET: GadgetSummary = { id: 4, type: 'gadget', title: 'Planner', commitId: 'head' }

const overseer = {
  listTree: async () => [],
  readFilesAtCommit: async () => [],
} as unknown as ComponentProps<typeof WorkpieceCodeInterface>['overseer']

// The chat as `applyBlueprint` leaves it: the gadget pinned at its head, and one change.
const chatChanges: ChatCodeChanges = {
  chatId: CHAT_ID,
  codeBase: {
    pins: [{ gadgetId: GADGET.id, baseCommit: 'head', mergedCommit: 'head' }],
    generation: 0,
    revision: 1,
  },
  epochChange: { [GADGET.id]: [['client.js', { set: 'const days = 7\n' }]] },
  rowsThrough: 1,
}

let container: HTMLDivElement
let root: Root
const onChatContentChange = vi.fn<(content: ChatContentReader | undefined) => void>()

const render = (props: Partial<ComponentProps<typeof WorkpieceCodeInterface>>) => act(async () => {
  root.render(
    <WorkpieceCodeInterface
      overseer={overseer}
      summary={GADGET}
      isAgentActive={false}
      onChatContentChange={onChatContentChange}
      {...props}
    />,
  )
})

beforeEach(() => {
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  onChatContentChange.mockClear()
})

describe('WorkpieceCodeInterface chat content', () => {
  it('lends out the selected chat’s content once it has loaded', async () => {
    await render({ selectedChatId: CHAT_ID })
    const reader = onChatContentChange.mock.lastCall?.[0]
    expect(reader?.chatId).toBe(CHAT_ID)
    // The chat's changes have yet to arrive, so there is no content to read.
    expect(reader?.read()).toBeUndefined()

    await render({ selectedChatId: CHAT_ID, chatChanges })
    await vi.waitFor(() => {
      expect(reader?.read()?.(GADGET.id, 'client.js')).toBe('const days = 7\n')
    })
    expect(reader?.hasLocalEdits()).toBe(false)
  })

  it('takes the content back when the chat is no longer selected', async () => {
    await render({ selectedChatId: CHAT_ID, chatChanges })
    expect(onChatContentChange.mock.lastCall?.[0]).toBeDefined()

    await render({ selectedChatId: null })
    expect(onChatContentChange).toHaveBeenLastCalledWith(undefined)
  })
})
