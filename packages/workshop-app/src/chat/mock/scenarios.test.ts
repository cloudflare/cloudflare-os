import { describe, expect, it, vi } from 'vitest'
import { ChatSession } from '../ChatSession'
import type { ChatItem } from '../chatItems'
import { createMockApi, MOCK_WORKSPACE_ID } from './mockApi'
import { playThrough } from './playThrough'
import type { Scenario } from './scenario'
import { SCENARIOS } from './scenarios'

const scenario = (id: string) => SCENARIOS.find((candidate) => candidate.id === id)!

/** A session opened the way the app opens one, over the scenario's fake backend. */
const open = async (played: Scenario) => {
  const { session: api, overseer } = createMockApi(played)
  const session = new ChatSession(() => api.api.openWorkspace(MOCK_WORKSPACE_ID), 0, { viewerId: api.user.id })
  session.start()
  await vi.waitFor(() => expect(session.getSnapshot().status).toBe('ready'))
  const ready = () => {
    const snapshot = session.getSnapshot()
    if (snapshot.status !== 'ready') throw new Error(`expected a ready session, got ${snapshot.status}`)
    return snapshot
  }
  /** Every row on screen, top to bottom. */
  const rows = (): ChatItem[] => {
    const { items, openTools, streamingTools, pinned } = ready()
    return [...items, ...[openTools, streamingTools].filter((item) => item !== undefined), ...pinned]
  }
  return { session, overseer, ready, rows }
}

/** Plays the whole script, collecting something from the screen after every step. */
const watch = async <T,>(played: Scenario, look: (chat: Awaited<ReturnType<typeof open>>) => T[]) => {
  const chat = await open(played)
  const seen = new Set<T>(look(chat))
  await playThrough(chat.overseer, () => look(chat).forEach((value) => seen.add(value)))
  return { ...chat, seen }
}

const of = <K extends ChatItem['kind']>(rows: ChatItem[], kind: K) =>
  rows.filter((row): row is Extract<ChatItem, { kind: K }> => row.kind === kind)

describe('scenarios', () => {
  it.each(SCENARIOS.map((played) => [played.id, played] as const))('%s plays through with nothing left unrendered or still streaming', async (_id, played) => {
    const { ready, seen } = await watch(played, ({ rows }) => of(rows(), 'notice').map(({ notice }) => notice))

    expect(seen).not.toContain('unknown')
    expect(ready()).toMatchObject({
      streamingText: '',
      streamingReasoning: '',
      streamingTools: undefined,
      compacting: false,
      agentActive: false,
      queuedSteers: [],
      actionError: undefined,
    })
    expect(ready().openTools?.running).toBeUndefined()
  })

  it('plain: reasoning streams before the answer, and stays with it', async () => {
    const { ready, seen } = await watch(scenario('plain'), (chat) => [chat.ready().streamingReasoning !== '', chat.ready().streamingText !== ''])

    expect(seen).toContain(true)
    expect(ready().items).toMatchObject([{ kind: 'user' }, { kind: 'assistant', reasoning: expect.any(String) }, { kind: 'user' }, { kind: 'assistant' }])
  })

  it('tool-run: calls show while they run, then as one group with its failure flagged', async () => {
    const { rows, seen } = await watch(scenario('tool-run'), ({ ready }) => (ready().openTools?.running ? ready().openTools!.entries.filter((entry) => entry.type === 'call' && entry.running).map(({ label }) => label) : []))

    expect([...seen]).toEqual(expect.arrayContaining(['Reading src/worker.ts…', 'Writing src/trend.ts…', 'Running code…']))
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'tools', 'assistant'])
    expect(of(rows(), 'tools')[0]).toMatchObject({ failed: true, summary: 'Read 3 files, edited 2, wrote 1, and 2 more' })
  })

  it('approval: each decision shows on its card, and a standing rule approves the next of its kind', async () => {
    const chat = await open(scenario('approval'))
    const { session, overseer, ready, rows } = chat
    const pending = () => of(rows(), 'action').find(({ state }) => state === 'pending')!
    const untilWaiting = async () => {
      while (!overseer.player.getSnapshot().waitingFor && overseer.player.getSnapshot().position < overseer.player.getSnapshot().total) overseer.player.step()
    }

    await untilWaiting()
    expect(ready().pinned).toMatchObject([{ kind: 'action', title: 'Create issue in PLAT', state: 'pending' }])
    await session.approveAction(pending().actionId)
    expect(rows().at(-1)).toMatchObject({ kind: 'action', title: 'Create issue in PLAT', state: 'approved' })

    await untilWaiting()
    await session.rejectAction(pending().actionId)

    await untilWaiting()
    expect(pending().rule).toBeDefined()
    await overseer.setAutoApprovedActionKind(pending().rule!.gatekeeperId, pending().rule!.actionKind)

    await untilWaiting()
    // Nothing is waiting any more, so each request is back where it was made.
    expect(ready().pinned).toEqual([])
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'tools', 'action', 'assistant', 'action', 'assistant', 'tools', 'assistant'])
    expect(of(rows(), 'action').map(({ resolution }) => resolution)).toEqual(['Approved by Ada Lovelace', 'Denied by Ada Lovelace'])
    // The two a rule approved were never anyone's decision: they are steps of the work.
    expect(of(rows(), 'tools')[1]).toMatchObject({
      summary: 'Ran code, took 2 actions',
      entries: [{ type: 'call' }, { resolution: 'Auto-approved (Ada Lovelace’s rule)' }, { resolution: 'Auto-approved (Ada Lovelace’s rule)' }],
    })
  })

  it('observation-hook: what was read is listed with the tools, and the hook under the answer can be switched', async () => {
    const { session, ready, rows } = await watch(scenario('observation-hook'), () => [])

    expect(of(rows(), 'tools')[0].entries.map(({ type }) => type)).toEqual(['call', 'observation', 'observation'])
    expect(rows().at(-1)).toMatchObject({ kind: 'hook', enabled: true })
    const [hook] = of(ready().pinned, 'hook')
    await session.setHookEnabled(hook.hookId!, false)
    expect(ready().pinned).toMatchObject([{ kind: 'hook', enabled: false }])
  })

  it('connection-request: a request goes from pending to connected, or to denied', async () => {
    const { session, ready, seen } = await watch(scenario('connection-request'), ({ rows }) => of(rows(), 'connection').map(({ state }) => state))
    expect(seen).toEqual(new Set(['pending', 'connected']))

    const [waiting] = of(ready().pinned, 'connection')
    expect(waiting).toMatchObject({ vendorName: 'Grafana', state: 'pending' })
    await session.denyConnection(waiting.requestId)
    expect(ready().pinned).toEqual([])
    expect(of(ready().items, 'connection').map(({ vendorName, state }) => [vendorName, state])).toEqual([['ClickHouse', 'connected'], ['Grafana', 'denied']])
  })

  it('output: the card stays under the answer, a draft until the changes are accepted', async () => {
    const { ready, rows, seen } = await watch(scenario('output'), (chat) => of(chat.rows(), 'output').map(({ draft }) => draft))

    expect(seen).toEqual(new Set([true, false]))
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'tools', 'assistant', 'output', 'divider', 'divider'])
    expect(ready().pinned).toMatchObject([
      { kind: 'output', title: 'Q3 platform review', format: { noun: 'Document' } },
      { label: 'You saved edits' },
      { label: 'You accepted changes' },
    ])
  })

  it('errors: only the last error can be retried, and running out of credits offers to continue', async () => {
    const { rows, seen } = await watch(scenario('errors'), (chat) => [of(chat.rows(), 'error').map(({ recovery }) => recovery).join()])

    expect(seen).toContain(',retry')
    expect(of(rows(), 'error').map(({ recovery }) => recovery)).toEqual([undefined, undefined, 'continue'])
  })

  it('steer-slash: a steer waits unread, then joins the answer; the context is compacted', async () => {
    const { rows, seen } = await watch(scenario('steer-slash'), ({ ready }) => [...ready().queuedSteers.map(({ text }) => text), ...(ready().compacting ? ['compacting'] : [])])

    expect(seen).toEqual(new Set(['Keep it under 100 words.', 'compacting']))
    expect(rows().map((row) => (row.kind === 'notice' ? row.notice : row.kind))).toEqual([
      'user', 'assistant', 'user', 'model', 'assistant', 'user', 'divider', 'assistant', 'user',
    ])
    expect(of(rows(), 'user')[0].parts[0]).toEqual({ type: 'command', name: 'release-notes' })
  })

  it('long-history: opens on the latest page and pages back to the start', async () => {
    const { session, ready } = await open(scenario('long-history'))
    expect(ready().hasEarlier).toBe(true)
    const tail = ready().items.length

    let pages = 0
    while (ready().hasEarlier) {
      await session.loadEarlier()
      pages++
    }

    expect(pages).toBeGreaterThan(5)
    expect(ready().items.length).toBeGreaterThan(tail)
    expect(ready().items[0]).toMatchObject({ kind: 'user', id: 0 })
    expect(scenario('long-history').history.length).toBeGreaterThan(300)
  })
})
