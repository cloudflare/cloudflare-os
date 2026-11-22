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
  enabledTags?: string[]
  restricted?: boolean
  actions?: Partial<PendingChangeActions>
}) {
  const calls: string[] = []
  const actions: PendingChangeActions = {
    processing: new Set<number>(),
    onApprove: entry => calls.push(`approve:${entry.id}`),
    onReject: entry => calls.push(`reject:${entry.id}`),
    onAlwaysApprove: entry => calls.push(`always:${entry.id}`),
    onManageRules: () => calls.push('manage'),
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
      rules={{
        isEnabled: (_gatekeeperId, tag) => (options.enabledTags ?? []).includes(tag),
        restricted: options.restricted === true,
      }}
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
    expect(document.body.textContent).toContain('nothing applied yet')
  })

  it('says so while the workspace is restricted', async () => {
    await render({ groups: [group([request(1), request(2)])], restricted: true })

    expect(document.body.textContent).toContain('every request is reviewed on its own')
  })

  it('explains a creation inside its group rather than silently refusing', async () => {
    await render({ groups: [group([request(1, { creation: true }), request(2)])] })
    await openGroup()

    expect(document.body.textContent).toContain('Approve its creation first')
  })

  it('offers "Always approve" only where a rule would apply the request', async () => {
    await render({ groups: [group([
      request(1, { autoApprovable: true, title: 'Auto-approvable' }),
      request(2, { autoApprovable: false, title: 'Manual only' }),
    ])] })
    await openGroup()

    expect(buttons().filter(b => b.textContent === 'Always approve')).toHaveLength(1)
  })

  it('stops offering "Always approve" once a rule covers the kind', async () => {
    await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()

    // Still pending does not mean no rule: a chat is accepted automatically only when rules cover
    // all of it, which leaves covered requests queued behind one they do not.
    expect(button('Always approve')).toBeUndefined()
    expect(document.body.textContent).toContain('Standing rule enabled')
  })

  it('keeps a covered request decidable, since an automatic apply can give up on it', async () => {
    // An automatic apply that fails stops there for good and leaves the request pending, so a
    // row with no controls would leave it decidable nowhere in the chat.
    const { calls } = await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()

    await click(button('Approve'))
    expect(calls).toEqual(['approve:1'])
  })

  it('names what is holding up an auto-approved request', async () => {
    const gate = request(1, { autoApprovable: false, title: 'Needs a person' })
    const covered = request(2, { autoApprovable: true })
    await render({ groups: [group([gate, covered])], enabledTags: ['append'] })
    await openGroup()

    expect(document.body.textContent).toContain('waiting on "Needs a person" above it')
  })

  it('links to where a standing rule is turned off', async () => {
    const { calls } = await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()
    await click(button('Manage rule'))

    expect(calls).toEqual(['manage'])
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

  it('shows a request that failed to apply, with Retry, and what waits on it', async () => {
    const calls: string[] = []
    const failed = { ...request(1), applyError: { message: 'Quota exceeded.', retryable: true } }
    await render({
      groups: [group([failed, request(2, { title: 'Write two' })])],
      actions: branch(calls),
    })
    await openGroup()
    expect(document.querySelector('[role="alert"]')?.textContent)
        .toContain('Could not apply: Quota exceeded.')
    expect(document.body.textContent).toContain('Waiting on "Write 1" above it.')
    await click(button('Retry'))
    expect(calls).toEqual(['retry:1'])
  })

  it('offers no Retry for a failure that cannot be retried', async () => {
    const failed = { ...request(1), applyError: { message: 'Gone.', retryable: false } }
    await render({ groups: [group([failed])], actions: branch([]) })
    await openGroup()
    expect(document.body.textContent).toContain('Could not apply: Gone.')
    expect(button('Retry')).toBeUndefined()
  })

  it('says a request the provider may have applied anyway needs checking, and offers no Retry',
    async () => {
      const failed = {
        ...request(1),
        applyError: { message: 'Timed out.', retryable: false, outcomeUnknown: true as const },
      }
      await render({ groups: [group([failed])], actions: branch([]) })
      await openGroup()
      expect(document.querySelector('[role="alert"]')?.textContent).toBe(
        'Could not apply: Timed out. It may have been applied anyway. Check the resource before ' +
        'you deny it.')
      expect(button('Retry')).toBeUndefined()
    })
})
