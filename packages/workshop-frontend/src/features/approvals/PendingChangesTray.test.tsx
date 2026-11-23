// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingChangesTray } from './PendingChangesTray'
import type { PendingChangeActions } from './PendingChangeGroupRow'
import type {
  PendingChange, PendingChangeGroup, RequestOrigin,
} from './pendingChangeGroups'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const APPEND = { tag: 'append', label: 'Append a slide' }

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

function request(id: number, over: {
  gatekeeperId?: number
  title?: string
  autoApprovable?: boolean
  actionKind?: { tag: string, label: string }
  creation?: true
  origin?: RequestOrigin
} = {}): PendingChange {
  return {
    id,
    gatekeeperId: over.gatekeeperId ?? 1,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date(Date.now() - 60_000),
    state: 'pending',
    type: 'action',
    origin: over.origin ?? 'open-chat',
    ...(over.creation ? { creation: true } : {}),
    description: {
      title: over.title ?? `Write ${id}`,
      description: 'Appends a slide.',
      implementsRevert: false,
      autoApprovable: over.autoApprovable ?? false,
      ...('actionKind' in over ? { actionKind: over.actionKind } : { actionKind: APPEND }),
    },
  } as PendingChange
}

function group(entries: PendingChange[], over: Partial<PendingChangeGroup> = {}): PendingChangeGroup {
  return {
    gatekeeperId: entries[0].gatekeeperId,
    title: 'Road trip 2026',
    entries,
    hasCreation: entries.some(entry => entry.creation === true),
    ...over,
  }
}

async function render(options: {
  groups: PendingChangeGroup[]
  restricted?: boolean
  actions?: Partial<PendingChangeActions>
}) {
  const calls: string[] = []
  const actions: PendingChangeActions = {
    processing: new Set<number>(),
    onApprove: entry => calls.push(`approve:${entry.id}`),
    onReject: entry => calls.push(`reject:${entry.id}`),
    canApprove: () => true,
    onRetry: entry => calls.push(`retry:${entry.id}`),
    ...options.actions,
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <PendingChangesTray
      groups={options.groups}
      restricted={options.restricted === true}
      vendorIdByGatekeeper={new Map()}
      vendorBranding={new Map()}
      actions={actions}
    />,
  ))
  return { calls, container }
}

const buttons = () => [...document.querySelectorAll('button')]
const button = (text: string) => buttons().find(b => (b.textContent ?? '').trim() === text)
const click = async (target: HTMLButtonElement | undefined) => {
  if (!target) throw new Error('No such button')
  await act(async () => target.click())
}
const openGroup = () => click(buttons().find(b => b.hasAttribute('aria-expanded')))

describe('PendingChangesTray', () => {
  it('counts the requests waiting', async () => {
    await render({ groups: [group([request(1), request(2)])] })

    expect(document.body.textContent).toContain('2 requests waiting')
    expect(document.body.textContent).not.toContain('nothing applied yet')
  })

  it('says so while the workspace is restricted', async () => {
    await render({ groups: [group([request(1), request(2)])], restricted: true })

    expect(document.body.textContent).toContain('every request is reviewed on its own')
  })

  it('offers no rule controls, since chat modes replaced the rules', async () => {
    await render({ groups: [group([request(1, { autoApprovable: true })])] })
    await openGroup()

    expect(button('Always approve')).toBeUndefined()
    expect(document.body.textContent).not.toContain('Standing rule')
  })

  it('marks the requests this conversation did not ask for', async () => {
    // A hook, a scheduled task or another chat queued it; nothing on screen explains it.
    await render({ groups: [group([request(1), request(2, { origin: 'elsewhere' })])] })

    expect(document.body.textContent).toContain('1 from elsewhere')
    await openGroup()
    expect([...document.querySelectorAll('p')]
      .filter(p => p.textContent?.trim() === 'Asked elsewhere in this workspace'))
      .toHaveLength(1)
  })

  it('says so plainly when the whole queue came from elsewhere', async () => {
    await render({ groups: [group([
      request(1, { origin: 'elsewhere' }),
      request(2, { origin: 'elsewhere' }),
    ])] })

    expect(document.body.textContent).toContain('asked elsewhere in this workspace')
    // Once on the group's row, rather than the same sentence under every request inside it.
    expect(buttons().find(b => b.hasAttribute('aria-expanded'))?.textContent)
      .toContain('Asked elsewhere')
    await openGroup()
    expect([...document.querySelectorAll('p')]
      .filter(p => p.textContent?.trim() === 'Asked elsewhere in this workspace'))
      .toHaveLength(0)
  })

  it('warns when one connection is close to filling its queue', async () => {
    const many = Array.from({ length: 40 }, (_, i) => request(i + 1))
    await render({ groups: [group(many)] })

    expect(document.body.textContent).toContain('holding 40 unresolved requests')
  })
})

// Only request 2 is approved on its own.
const branch = (calls: string[]) => ({
  canApprove: (entry: PendingChange) => entry.id === 2,
  onRetry: (entry: PendingChange) => calls.push(`retry:${entry.id}`),
})

describe('PendingChangesTray approval', () => {
  it('offers Approve only on a request approved on its own', async () => {
    const calls: string[] = []
    await render({ groups: [group([request(1), request(2)])], actions: branch(calls) })
    await openGroup()
    expect(buttons().filter(b => b.textContent?.trim() === 'Deny')).toHaveLength(2)
    expect(buttons().filter(b => b.textContent?.trim() === 'Approve')).toHaveLength(1)
  })

  it('shows a request that failed to apply, with Retry, and marks what waits on it as blocked', async () => {
    const calls: string[] = []
    const failed = { ...request(1), applyError: { message: 'Quota exceeded.', retryable: true } }
    await render({
      groups: [group([failed, request(2, { title: 'Write two' })])],
      actions: branch(calls),
    })
    await openGroup()
    expect(document.querySelector('[role="alert"]')?.textContent)
        .toContain('Could not apply: Quota exceeded.')
    expect(document.body.textContent).toContain('Blocked')
    await click(button('Retry'))
    expect(calls).toEqual(['retry:1'])
  })

  it('marks no request as blocked on a failure in another chat or outside any', async () => {
    const error = { message: 'Quota exceeded.', retryable: true }
    await render({
      groups: [group([
        { ...request(1), chatId: 7, applyError: error },
        request(2, { origin: 'elsewhere' }),
        { ...request(3), chatId: 7 },
      ])],
      actions: branch([]),
    })
    await openGroup()
    expect(document.body.textContent?.match(/Blocked/g)).toHaveLength(1)
  })

  it('offers no Retry for a failure that cannot be retried', async () => {
    const failed = { ...request(1), applyError: { message: 'Gone.', retryable: false } }
    await render({ groups: [group([failed])], actions: branch([]) })
    await openGroup()
    expect(document.body.textContent).toContain('Could not apply: Gone.')
    expect(button('Retry')).toBeUndefined()
  })

  it('offers no Retry for a request the provider may have applied anyway',
    async () => {
      const failed = {
        ...request(1),
        applyError: { message: 'Timed out.', retryable: false, outcomeUnknown: true as const },
      }
      await render({ groups: [group([failed])], actions: branch([]) })
      await openGroup()
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not apply: Timed out. It may have been applied anyway. Check the resource before you deny it.')
      expect(button('Retry')).toBeUndefined()
    })
})
