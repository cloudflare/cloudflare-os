// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WorkspaceConnectionInfo, GadgetSummary, GatekeeperVendorInfo } from '@gadgets/workshop-shared/api'
import type { WorkspaceConnections } from './features/workspace-connections/useWorkspaceConnections'

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

const connection = (over: Partial<WorkspaceConnectionInfo> & Pick<WorkspaceConnectionInfo, 'target' | 'resourceTitle'>): WorkspaceConnectionInfo =>
  ({ alwaysAvailable: false, awaitingApproval: false, ...over })

const CONNECTIONS: WorkspaceConnectionInfo[] = [
  connection({ target: 12, resourceTitle: 'Skills', vendorId: 'context', alwaysAvailable: true }),
  connection({
    target: 10, resourceTitle: 'Q3 Budget', vendorId: 'google', typeUrlPattern: SHEET,
    resourceUrl: 'https://docs.google.com/spreadsheets/d/1/edit',
  }),
  connection({ target: 11, resourceTitle: 'Launch plan', vendorId: 'google', typeUrlPattern: SHEET, awaitingApproval: true }),
  connection({
    target: 13, resourceTitle: 'acme/widgets', vendorId: 'github', typeUrlPattern: 'https://github.com/:owner/:repo',
    resourceUrl: 'https://github.com/acme/widgets',
  }),
  connection({ target: 14, resourceTitle: 'Orphaned resource', resourceUrl: 'javascript:alert(1)' }),
]

const connectionsGroup = (container: HTMLElement) =>
  container.querySelector('[role="group"][aria-label="Connections"]')!

/** Each collapsed row's accessible name and icon, in order. */
const rows = (scope: Element) => [...scope.querySelectorAll('a[aria-label], [role="img"][aria-label]')]
  .map(row => [row.getAttribute('aria-label'), row.querySelector('img')?.getAttribute('src')])

describe('WorkpiecePicker', () => {
  let root: Root | undefined

  afterEach(() => act(() => root?.unmount()))

  async function render({ expanded, gadgets = [], connections = null }: {
    expanded: boolean
    gadgets?: GadgetSummary[]
    connections?: WorkspaceConnections | null
  }) {
    const container = document.createElement('div')
    root = createRoot(container)
    await act(async () => root!.render(
      <WorkpiecePicker
        gadgets={gadgets}
        worktrees={[]}
        selectedId={null}
        connections={connections}
        onRemoveConnection={vi.fn<(id: number) => Promise<void>>(async () => {})}
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

  describe('with workspace connections', () => {
    it('lists every registry record under Connections, including orphans and built-ins', async () => {
      const container = await render({ expanded: false, connections: { status: 'ready', connections: CONNECTIONS } })
      const group = connectionsGroup(container)
      expect(rows(group)).toEqual([
        ['Q3 Budget · Google Sheet', 'https://example.com/sheet.svg'],
        ['Launch plan · Awaiting approval', 'https://example.com/sheet.svg'],
        ['acme/widgets · GitHub', 'https://example.com/github.svg'],
        ['Orphaned resource', undefined],
        ['Skills · Built in', undefined],
      ])
      expect(rows(container)).toEqual(rows(group))
      expect(container.querySelector('button[title="Remove from workspace"]')).toBeNull()
    })

    it('opens safe URLs only and never offers built-in removal', async () => {
      const container = await render({ expanded: true, connections: { status: 'ready', connections: CONNECTIONS } })
      expect([...container.querySelectorAll('a')].map(link =>
        [link.getAttribute('aria-label'), link.getAttribute('href'), link.target, link.rel])).toEqual([
        ['Q3 Budget · Google Sheet', 'https://docs.google.com/spreadsheets/d/1/edit', '_blank', 'noopener noreferrer'],
        ['acme/widgets · GitHub', 'https://github.com/acme/widgets', '_blank', 'noopener noreferrer'],
      ])
      expect(container.querySelector('[aria-label="Remove Skills from workspace"]')).toBeNull()
    })

    it('distinguishes loading and failure from an empty registry', async () => {
      const shown = async (connections: WorkspaceConnections) => {
        const container = await render({ expanded: true, connections })
        return connectionsGroup(container).textContent
      }
      expect(await shown({ status: 'loading' })).toContain('Loading…')
      expect(await shown({ status: 'failed' })).toContain('Couldn’t load connections')
      expect(await shown({ status: 'ready', connections: [] })).toContain('None yet')
    })
  })
})
