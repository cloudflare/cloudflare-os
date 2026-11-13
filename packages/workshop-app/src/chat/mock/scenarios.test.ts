import { afterEach, describe, expect, it, vi } from 'vitest'
import { previewOf } from '@/aside/filePreview'
import { BACK_FOR, ConnectionNotice, SHOW_AFTER } from '@/rpc/ConnectionNotice'
import { ChatSession } from '../ChatSession'
import type { ChatItem } from '../chatItems'
import { createMockApi, MOCK_WORKSPACE_ID } from './mockApi'
import { playThrough } from './playThrough'
import { AGENT, type Scenario } from './scenario'
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
  /** Every row of the conversation, top to bottom. */
  const rows = (): ChatItem[] => [...ready().items, ...ready().pinned]
  /** What the making of the reply shows right now, by kind. */
  const making = () => ready().work.map(({ type }) => type)
  return { session, overseer, ready, rows, making }
}

/** Plays the whole script, collecting something from the screen after every step. */
const watch = async <T,>(played: Scenario, look: (chat: Awaited<ReturnType<typeof open>>) => T[]) => {
  const chat = await open(played)
  const seen = new Set<T>(look(chat))
  await playThrough(chat.overseer, () => look(chat).forEach((value) => seen.add(value)))
  return { ...chat, seen }
}

/** Moves a faked clock on, for what is ordered by when it happened. */
const later = () => vi.setSystemTime(Date.now() + 1000)

const of = <K extends ChatItem['kind']>(rows: ChatItem[], kind: K) =>
  rows.filter((row): row is Extract<ChatItem, { kind: K }> => row.kind === kind)

describe('scenarios', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it.each(SCENARIOS.map((played) => [played.id, played] as const))('%s plays through with nothing left unrendered or still streaming', async (_id, played) => {
    const { ready, seen } = await watch(played, ({ rows }) => of(rows(), 'notice').map(({ notice }) => notice))

    expect(seen).not.toContain('unknown')
    // A workspace that restarted is read again once it is back, a few seconds on.
    await vi.waitFor(() => expect(ready()).toMatchObject({ activity: undefined, work: [], agentActive: false, actionError: undefined }), { timeout: 5000 })
    expect(of(ready().items, 'user').filter(({ unread }) => unread)).toEqual([])
  }, 10_000)

  it('plain: the reply is thought about, then written, and joins the conversation only when done', async () => {
    const { ready, seen } = await watch(scenario('plain'), (chat) => [`${chat.ready().activity}: ${chat.making().join()}; ${chat.ready().items.length} rows`])

    expect([...seen]).toEqual(expect.arrayContaining(['Thinking…: thinking; 1 rows', 'Writing…: thinking,writing; 1 rows']))
    // What it thought is kept behind the reply, for whoever asks about it.
    expect(ready().items).toMatchObject([
      { kind: 'user' },
      { kind: 'assistant', sender: 'Mock Model', trace: [{ type: 'thinking' }] },
      { kind: 'user' },
      { kind: 'assistant' },
    ])
  })

  it('tool-run: what each call is doing is said while it runs, and stays behind the reply rather than in the conversation', async () => {
    const { rows, seen } = await watch(scenario('tool-run'), ({ ready }) => [ready().activity])

    expect([...seen]).toEqual(expect.arrayContaining(['Reading src/worker.ts…', 'Writing src/trend.ts…', 'Running code…', 'Writing…', undefined]))
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'assistant'])
    const [, answer] = of(rows(), 'assistant')
    expect(answer.trace.length).toBeGreaterThan(4)
    expect(answer.trace.some((step) => step.type === 'call' && step.error)).toBe(true)
  })

  it('approval: a decision stays where it was made, a rule approves the next of its kind, and what does not block waits under the answer', async () => {
    // Decisions are placed by when they were made, so the clock has to move between the steps.
    vi.useFakeTimers({ toFake: ['Date'] })
    const chat = await open(scenario('approval'))
    const { session, overseer, ready, rows } = chat
    const pending = () => of(ready().pinned, 'action')
    const untilWaiting = () => {
      later()
      while (!overseer.player.getSnapshot().waitingFor && overseer.player.getSnapshot().position < overseer.player.getSnapshot().total) overseer.player.step()
      later()
    }

    untilWaiting()
    expect(pending()).toMatchObject([{ title: 'Create issue in PLAT', state: 'pending' }])
    await session.approveAction(pending()[0].actionId)
    expect(rows().at(-1)).toMatchObject({ kind: 'action', title: 'Create issue in PLAT', state: 'approved' })

    untilWaiting()
    const { rule } = pending()[0]
    await overseer.setAutoApprovedActionKind(rule!.gatekeeperId, rule!.actionKind)

    // The post does not suspend the turn: the agent wrote on, and the card is still below it all.
    const whilePending: string[] = []
    while (overseer.player.getSnapshot().position < overseer.player.getSnapshot().total) {
      overseer.player.step()
      if (pending().length && ready().activity === 'Writing…') whilePending.push(pending()[0].title)
    }
    expect(new Set(whilePending)).toEqual(new Set(['Post to #platform']))
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'action', 'assistant', 'action', 'action', 'assistant', 'assistant', 'action'])

    // Denied after the agent had written on, the card stays below what was written while it waited.
    later()
    await session.rejectAction(pending()[0].actionId)
    expect(ready().pinned).toEqual([])
    expect(rows().map(({ kind }) => kind).slice(-3)).toEqual(['assistant', 'assistant', 'action'])
    // The two labels were decided by the rule as they were made.
    expect(of(rows(), 'action').map(({ resolution }) => resolution)).toEqual([
      'Approved by Ada Lovelace',
      'Auto-approved (Ada Lovelace’s rule)',
      'Auto-approved (Ada Lovelace’s rule)',
      'Denied by Ada Lovelace',
    ])
  })

  it('observation-hook: what was read is a step of the work, and the hook stays under the answer while more is done', async () => {
    const { session, ready, rows, seen } = await watch(scenario('observation-hook'), (chat) => {
      const { pinned, activity } = chat.ready()
      return [chat.making().join(), ...(pinned.length && activity ? [`with the hook: ${activity}`] : [])]
    })
    expect(seen).toContain('call,observation,observation')
    // With the hook already under the answer, the agent both ran a tool and wrote on.
    expect([...seen]).toEqual(expect.arrayContaining(['with the hook: Running code…', 'with the hook: Writing…']))
    expect(rows().slice(-3).map(({ kind }) => kind)).toEqual(['assistant', 'assistant', 'hook'])

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
    expect(rows().map(({ kind }) => kind)).toEqual(['user', 'assistant', 'assistant', 'output', 'divider'])
    expect(ready().pinned).toMatchObject([
      { kind: 'output', title: 'Q3 platform review', format: { noun: 'Document' } },
      { label: 'You saved edits' },
    ])
  })

  it('errors: only the last error can be retried, and running out of credits offers to continue', async () => {
    const { rows, seen } = await watch(scenario('errors'), (chat) => [of(chat.rows(), 'error').map(({ recovery }) => recovery).join()])

    expect(seen).toContain(',retry')
    expect(of(rows(), 'error').map(({ recovery }) => recovery)).toEqual([undefined, undefined, 'continue'])
  })

  it('send-refused: a refused message says so and did not go; sent again, it goes and is answered', async () => {
    const { session, overseer, ready, rows } = await open(scenario('send-refused'))
    const before = rows().length

    expect(await session.send('What caused the slowdown?', AGENT.id)).toBe(false)
    expect(ready().sendError).toBe('The workspace is busy saving the last changes. Try again in a moment.')
    expect(rows()).toHaveLength(before)

    expect(await session.send('What caused the slowdown?', AGENT.id)).toBe(true)
    expect(ready().sendError).toBeUndefined()
    await playThrough(overseer)
    expect(rows().map(({ kind }) => kind).slice(before)).toEqual(['user', 'assistant'])
  })

  it('workspace-restart: the conversation stays as it is while the workspace is down, then is read again and carries on', async () => {
    vi.useFakeTimers()
    const played = scenario('workspace-restart')
    const { overseer, ready } = await open(played)
    const restart = played.script.findIndex((step) => 'restart' in step)
    while (overseer.player.getSnapshot().position < restart) overseer.player.step()
    const before = ready()
    expect(before.activity).toBe('Writing…')

    overseer.player.step()
    await vi.advanceTimersByTimeAsync(2900)
    expect(ready()).toBe(before)

    await vi.advanceTimersByTimeAsync(200)
    // Read again: what was being written is gone, to be written again from the start.
    expect(ready().items).toEqual(before.items)
    expect(ready()).toMatchObject({ activity: 'Thinking…', agentActive: true })

    await playThrough(overseer)
    expect(ready()).toMatchObject({ activity: undefined, agentActive: false })
    expect(ready().items.at(-1)).toMatchObject({ kind: 'assistant', text: expect.stringContaining('hiring section') })
  })

  it('connection-lost: nothing is sent while the connection is down, which is said; once back the conversation catches up', async () => {
    vi.useFakeTimers()
    const played = scenario('connection-lost')
    const { session: api, overseer } = createMockApi(played)
    // Wired as the app wires its connection: the notice is told, and the chat connects again once back.
    const notice = new ConnectionNotice()
    const session = new ChatSession(() => api.api.openWorkspace(MOCK_WORKSPACE_ID), 0, { viewerId: api.user.id, connection: notice })
    overseer.onConnection = (connected) => {
      if (!connected) return notice.lost()
      notice.restored()
      session.reconnect()
    }
    session.start()
    await vi.waitFor(() => expect(session.getSnapshot().status).toBe('ready'))
    const ready = () => {
      const snapshot = session.getSnapshot()
      if (snapshot.status !== 'ready') throw new Error(`expected a ready session, got ${snapshot.status}`)
      return snapshot
    }
    const drop = played.script.findIndex((step) => 'disconnect' in step)
    while (overseer.player.getSnapshot().position <= drop) overseer.player.step()
    const shown = ready()
    expect(shown.agentActive).toBe(true)

    // Said only once it has lasted a moment.
    expect(notice.getSnapshot().status).toBe('hidden')
    await vi.advanceTimersByTimeAsync(SHOW_AFTER)
    expect(notice.getSnapshot()).toMatchObject({ status: 'reconnecting', alarms: 1 })

    // Put away, it comes back when a message cannot be sent, which is kept to send again.
    notice.dismiss()
    expect(await session.send('Thanks!', AGENT.id)).toBe(false)
    expect(notice.getSnapshot()).toMatchObject({ status: 'reconnecting', alarms: 2 })
    expect(ready().sendError).toBeUndefined()

    // The agent finishes meanwhile, unheard.
    while (overseer.player.getSnapshot().waitingFor === undefined) overseer.player.step()
    expect(ready()).toBe(shown)

    overseer.reconnectNow()
    expect(notice.getSnapshot().status).toBe('reconnected')
    await vi.waitFor(() => expect(ready().items.at(-1)).toMatchObject({ kind: 'assistant', text: expect.stringContaining('Grace') }))
    expect(ready()).toMatchObject({ agentActive: false, activity: undefined })
    await vi.advanceTimersByTimeAsync(BACK_FOR)
    expect(notice.getSnapshot().status).toBe('hidden')
    expect(await session.send('Thanks!', AGENT.id)).toBe(true)
  })

  it('untrusted-content: the SVG sent is shown as its text, and only the PNG as a picture', async () => {
    const { ready } = await open(scenario('untrusted-content'))
    const [sent] = of(ready().items, 'user')

    expect(sent.attachments.map(({ name, mimeType, content }) => previewOf({ name, mimeType: mimeType ?? '' }, content!))).toEqual([
      { kind: 'text', text: expect.stringContaining('<script>') },
      { kind: 'image', type: 'image/png' },
    ])
  })

  it('steer-slash: a steer waits unread and is the same row once read; the compaction is marked', async () => {
    const { rows, seen } = await watch(scenario('steer-slash'), (chat) => [
      ...of(chat.rows(), 'user').filter(({ text }) => text === 'Keep it under 100 words.').map(({ key, unread }) => `${key} ${unread ? 'unread' : 'read'}`),
      ...(chat.ready().activity === 'Compacting the conversation…' ? ['compacting'] : []),
    ])

    const [steer] = of(rows(), 'user').filter(({ text }) => text === 'Keep it under 100 words.')
    expect(seen).toEqual(new Set([`${steer.key} unread`, `${steer.key} read`, 'compacting']))
    expect(rows().map((row) => (row.kind === 'divider' ? row.marks : row.kind))).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'assistant', 'user', 'compaction',
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

  it('long-history: the message a reply quotes is found by paging back to it', async () => {
    const { session, ready } = await open(scenario('long-history'))
    const reply = ready().items.findLast((item) => item.kind === 'user' && item.quote !== undefined)
    if (reply?.kind !== 'user') throw new Error('expected the history to end in a reply')
    expect(ready().items.some((item) => item.kind === 'user' && item.text.startsWith('Request 3:'))).toBe(false)

    const key = await session.findQuoted(reply)

    expect(ready().items.find((item) => item.key === key)).toMatchObject({ kind: 'user', text: 'Request 3: update src/module-2.ts and check it still runs.' })
    // No further than it had to.
    expect(ready().hasEarlier).toBe(true)
  })

  it('long-history: a quote of nothing that was said is given up on at the start of the conversation', async () => {
    const { session, ready } = await open(scenario('long-history'))
    const [reply] = ready().items.filter((item) => item.kind === 'user')
    if (reply?.kind !== 'user') throw new Error('expected a message from the user')

    expect(await session.findQuoted({ ...reply, quote: 'Nobody said this' })).toBeUndefined()
    expect(ready().hasEarlier).toBe(false)
  })
})
