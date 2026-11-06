// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ChatBindingInfo, GadgetSummary, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { ChatBindings } from './features/chat-bindings/useChatBindings'

const SHEET = 'https://docs.google.com/spreadsheets/d/:id/*'

// As listGatekeeperVendors() returns it: without the vendors of always-available resources.
const VENDORS: GatekeeperVendorInfo[] = [
  {
    id: 'google',
    description: { displayName: 'Google', url: 'https://google.com', logo: { url: 'https://example.com/google.svg' } },
    supportedResources: [
      { urlPattern: SHEET, title: 'Google Sheet', description: '', icon: { url: 'https://example.com/sheet.svg' } },
    ],
  },
  {
    id: 'github',
    description: { displayName: 'GitHub', url: 'https://github.com', logo: { url: 'https://example.com/github.svg' } },
    supportedResources: [],
  },
]

// One stub for every render, as the session's is: the catalog is cached per stub.
const auth = vi.hoisted(() => ({ authenticatedApi: { listGatekeeperVendors: async () => VENDORS } }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))

import WorkpiecePicker from './WorkpiecePicker'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const binding = (over: Partial<ChatBindingInfo> & Pick<ChatBindingInfo, 'target' | 'resourceTitle'>): ChatBindingInfo =>
  ({ name: `b${over.target}`, created: false, changed: false, alwaysAvailable: false, ...over })

const BINDINGS: ChatBindingInfo[] = [
  binding({ target: 12, resourceTitle: 'Skills', vendorId: 'context', alwaysAvailable: true }),
  binding({
    target: 10, resourceTitle: 'Q3 Budget', vendorId: 'google', typeUrlPattern: SHEET, created: true,
    resourceUrl: 'https://docs.google.com/spreadsheets/d/1/edit',
  }),
  binding({ target: 11, resourceTitle: 'Launch plan', vendorId: 'google', typeUrlPattern: SHEET, created: true }),
  binding({
    target: 13, resourceTitle: 'acme/widgets', vendorId: 'github', typeUrlPattern: 'https://github.com/:owner/:repo',
    resourceUrl: 'https://github.com/acme/widgets', changed: true,
  }),
  // Another name for the same connection.
  binding({ name: 'widgets', target: 13, resourceTitle: 'acme/widgets', vendorId: 'github', changed: true }),
  binding({ target: 14, resourceTitle: 'Sketchy', resourceUrl: 'javascript:alert(1)' }),
]

const connectionsGroup = (container: HTMLElement) =>
  container.querySelector('[role="group"][aria-label="Connections"]')!

/** Each collapsed row's accessible name and icon, in order. */
const rows = (scope: Element) => [...scope.querySelectorAll('a[aria-label], [role="img"][aria-label]')]
  .map(row => [row.getAttribute('aria-label'), row.querySelector('img')?.getAttribute('src')])

describe('WorkpiecePicker', () => {
  let root: Root | undefined

  afterEach(() => act(() => root?.unmount()))

  async function render({ expanded, gadgets = [], chatBindings = null }: {
    expanded: boolean
    gadgets?: GadgetSummary[]
    chatBindings?: ChatBindings | null
  }) {
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkpiecePicker
        gadgets={gadgets}
        worktrees={[]}
        selectedId={null}
        chatBindings={chatBindings}
        expanded={expanded}
        hookedGadgetIds={new Set([1])}
        onExpandedChange={vi.fn<(expanded: boolean) => void>()}
        onSelect={vi.fn<(id: number) => void>()}
        onRename={vi.fn<(id: number, title: string) => void>()}
        pendingActivityCount={0}
        onOpenActivity={vi.fn<() => void>()}
      />,
    ))
    // The vendor catalog arrives after the first render.
    await act(async () => {})
    return container
  }

  // `role="img"` is what makes the label reachable; a bare span would be named nothing.
  const HOOK_BADGE = '[role="img"][aria-label="Hooks enabled"]'
  const GADGETS: GadgetSummary[] = [
    { id: 1, type: 'gadget', title: 'Hooked' },
    { id: 2, type: 'gadget', title: 'Ordinary' },
  ]

  it('names the badge only on gadgets with an enabled hook', async () => {
    const container = await render({ expanded: true, gadgets: GADGETS })
    const labelled = container.querySelectorAll(HOOK_BADGE)

    expect(labelled).toHaveLength(1)
    expect(labelled[0].closest('button')?.textContent).toContain('Hooked')
  })

  it('keeps the badge named when collapsed, where no title is rendered', async () => {
    const container = await render({ expanded: false, gadgets: GADGETS })

    expect(container.textContent).not.toContain('Hooked')
    expect(container.querySelectorAll(HOOK_BADGE)).toHaveLength(1)
  })

  describe("with the chat's bindings", () => {
    it('lists created resources as outputs and the rest as connections, once each and built-in last', async () => {
      const container = await render({ expanded: false, chatBindings: { status: 'ready', bindings: BINDINGS } })
      const connections = connectionsGroup(container)
      const outputs = rows(container).filter(([name]) =>
        !connections.querySelector(`[aria-label="${name}"]`))

      // Each is labelled by its type, with its type's icon, or else by its vendor.
      expect(outputs).toEqual([
        ['Q3 Budget · Google Sheet', 'https://example.com/sheet.svg'],
        ['Launch plan · Awaiting approval', 'https://example.com/sheet.svg'],
      ])
      expect(rows(connections)).toEqual([
        ['acme/widgets · GitHub · Changed', 'https://example.com/github.svg'],
        ['Sketchy', undefined],
        ['Skills · Built in', undefined],
      ])
    })

    it('links titles to their resources in a new tab, through safe URLs only', async () => {
      const container = await render({ expanded: true, chatBindings: { status: 'ready', bindings: BINDINGS } })

      // Not "Launch plan", which awaits approval, nor "Sketchy", whose URL is a script.
      expect([...container.querySelectorAll('a')].map(link =>
        [link.textContent, link.getAttribute('href'), link.target, link.rel])).toEqual([
        ['Q3 Budget', 'https://docs.google.com/spreadsheets/d/1/edit', '_blank', 'noopener noreferrer'],
        ['acme/widgets', 'https://github.com/acme/widgets', '_blank', 'noopener noreferrer'],
      ])
    })

    it('marks only the connections this chat changed', async () => {
      const container = await render({ expanded: true, chatBindings: { status: 'ready', bindings: BINDINGS } })
      const row = (title: string) => [...container.querySelectorAll('a, span')]
        .find(element => element.textContent === title)!.parentElement!

      expect(row('acme/widgets').textContent).toBe('acme/widgetsChanged')
      expect(row('Q3 Budget').textContent).toBe('Q3 Budget')
    })

    it('tells loading and failure apart from having no connections', async () => {
      const text = async (chatBindings: ChatBindings) =>
        connectionsGroup(await render({ expanded: true, chatBindings })).textContent

      expect(await text({ status: 'loading' })).toBe('ConnectionsLoading…')
      expect(await text({ status: 'failed' })).toBe('ConnectionsCouldn’t load connections')
      expect(await text({ status: 'ready', bindings: [] })).toBe('Connections')
    })
  })
})
