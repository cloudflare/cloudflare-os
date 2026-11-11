import { describe, expect, it } from 'vitest'
import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import { toChatFeed, type ChatFeed, type ChatItem } from './chatItems'
import recordedDevChat from './fixtures/dev-chat.json'
import { readFixture } from './fixtures/readFixture'
import { MockOverseer } from './mock/MockOverseer'
import { playThrough } from './mock/playThrough'
import {
  action,
  AGENT,
  agent,
  agentCallback,
  bindHook,
  call,
  changes,
  compactCommand,
  connectionRequest,
  error,
  FAST_AGENT,
  history,
  merge,
  observation,
  revert,
  slashCommand,
  useGadget,
  user,
  VIEWER,
  type MessageDraft,
} from './mock/scenario'
import { SCENARIOS } from './mock/scenarios'

const viewer = { viewerId: VIEWER.id }
const feed = (...sources: Parameters<typeof history>[0]) => toChatFeed(history(sources), viewer)
/** Everything the feed shows, top to bottom. */
const rows = ({ items, openTools, pinned }: ChatFeed): ChatItem[] => [...items, ...(openTools ? [openTools] : []), ...pinned]
const kinds = (result: ChatFeed) => rows(result).map(({ kind }) => kind)
const only = <K extends ChatItem['kind']>(result: ChatFeed, kind: K) =>
  rows(result).filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

const read = (filename: string) => call('readFile', { filename })
const edit = (filename: string) => call('editFile', { filename, textToReplace: 'a', replacement: 'b' })
const run = (rest: { output?: string; error?: string } = { output: 'ok' }) => call('executeCode', { code: 'run()' }, rest)
const createGadget = (gadgetId: number, title = 'Report') => call('createGadget', { title, bindingName: 'REPORT' }, { output: { gadgetId } })
const created = (gadgetId: number) => changes({ author: AGENT, createdGadgets: [{ gadgetId, title: 'Report', bindingName: 'REPORT' }] })

const request = (state: 'pending' | 'accepted' | 'denied') =>
  connectionRequest({ vendorName: 'ClickHouse', reason: 'Read error rates.', resourceTitle: 'ClickHouse cluster', state })
const LABEL = { tag: 'jira.label', label: 'Label an issue' }
const noFallback = (result: ChatFeed) => only(result, 'notice').filter(({ notice }) => notice === 'unknown')

describe('toChatFeed', () => {
  describe('messages', () => {
    it('maps user and agent text in order, identified by sequence', () => {
      const result = feed(user('hi'), agent({ text: 'hello' }))
      expect(result.items).toMatchObject([
        { kind: 'user', id: 0, text: 'hi' },
        { kind: 'assistant', id: 1, text: 'hello' },
      ])
    })

    it('draws the resources and formats a user mentioned as chips, where they typed them', () => {
      const capsule = {
        position: 6,
        length: 3,
        gatekeeperId: 3,
        description: { url: 'https://jira.example.com/PLAT-1', title: 'PLAT-1', snippet: '', suggestedBindingName: 'ISSUE', tsType: 'Issue' },
      }
      const format = { position: 15, length: 3, noun: 'Doc', icon: 'fileText' as const }
      const [item] = only(feed(user('Start [0] as a Doc now', { capsules: [capsule], formats: [format] })), 'user')

      expect(item.parts).toEqual([
        { type: 'text', text: 'Start ' },
        { type: 'capsule', title: 'PLAT-1', url: 'https://jira.example.com/PLAT-1' },
        { type: 'text', text: ' as a ' },
        { type: 'format', noun: 'Doc', icon: 'fileText' },
        { type: 'text', text: ' now' },
      ])
    })

    it('does not link a mention whose address is not a web page', () => {
      const capsule = {
        position: 0,
        length: 3,
        gatekeeperId: 3,
        description: { url: 'javascript:alert(1)', title: 'Trap', snippet: '', suggestedBindingName: 'X', tsType: 'X' },
      }
      const [item] = only(feed(user('[0]', { capsules: [capsule] })), 'user')
      expect(item.parts).toEqual([{ type: 'capsule', title: 'Trap', url: undefined }])
    })

    it('keeps a message that is only attachments', () => {
      const [item] = only(feed(user('', { attachments: [{ id: 'a', mimeType: 'application/pdf', name: 'brief.pdf', size: 10 }] })), 'user')
      expect(item).toMatchObject({ parts: [], attachments: [{ id: 'a', name: 'brief.pdf' }] })
    })

    it('says who sent a prompt that is not the viewer’s: a collaborator, or a gadget', () => {
      const gadget = { type: 'gadget', id: VIEWER.id, name: 'Inbox triage' } as const
      const other = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
      const result = feed(user('mine'), user('theirs', { author: other }), user('spawned', { author: gadget }))
      expect(only(result, 'user').map(({ from }) => from)).toEqual([undefined, 'Grace Hopper', 'Inbox triage'])
    })

    it('shows a slash command and the prompt it generated as one message: the command, not its expansion', () => {
      const result = feed(slashCommand({ name: 'review', args: 'the intro please', commandPosition: 0, expandsTo: 'Long generated prompt' }))
      expect(result.items).toMatchObject([{
        kind: 'user',
        id: 0,
        text: '/review the intro please',
        parts: [{ type: 'command', name: 'review' }, { type: 'text', text: ' the intro please' }],
      }])
    })

    it('puts a slash command back where it was typed', () => {
      const [item] = only(feed(slashCommand({ name: 'review', args: 'please the intro', commandPosition: 6 })), 'user')
      expect(item.text).toBe('please /review the intro')
    })

    it('shows the built-in /compact, which has no skill name', () => {
      expect(only(feed(compactCommand()), 'user')).toMatchObject([{ parts: [{ type: 'command', name: 'compact' }] }])
    })

    it('keeps an agent’s reasoning with what it said', () => {
      const result = feed(agent({ text: 'Done', reasoning: 'Thinking it through' }))
      expect(result.items).toMatchObject([{ kind: 'assistant', text: 'Done', reasoning: 'Thinking it through' }])
    })

    it('hides what is only for the model, and agent steps that left nothing to show', () => {
      const nudge: MessageDraft = { type: 'agentNudge', text: 'continue', author: AGENT }
      const catalog: MessageDraft = { type: 'catalogChange', resources: [], author: AGENT }
      expect(rows(feed(nudge, catalog, agent(), agent({ reasoning: 'only thinking' })))).toEqual([])
    })

    it('gives a kind it does not know a quiet row instead of failing', () => {
      const future = { type: 'holoCall', author: AGENT } as unknown as AiChatMessage
      const result = toChatFeed([{ ...future, chatId: 0, sequence: 0, timestamp: new Date(0) }])
      expect(result.items).toMatchObject([{ kind: 'notice', notice: 'unknown' }])
    })
  })

  describe('tool calls', () => {
    it('collapses consecutive calls into one group, across messages that said nothing', () => {
      const result = feed(
        user('go'),
        agent({ toolCalls: [read('a.ts'), read('b.ts')] }),
        agent({ toolCalls: [read('c.ts'), edit('a.ts')] }),
        agent({ toolCalls: [run()] }),
        agent({ text: 'Done' }),
      )
      expect(kinds(result)).toEqual(['user', 'tools', 'assistant'])
      expect(only(result, 'tools')[0]).toMatchObject({
        id: 1,
        summary: 'Read 3 files, edited 1, ran code',
        targets: ['a.ts', 'b.ts', 'c.ts'],
        failed: false,
      })
      expect(only(result, 'tools')[0].entries.map(({ label }) => label)).toEqual([
        'Read a.ts', 'Read b.ts', 'Read c.ts', 'Edited a.ts', 'Ran code',
      ])
    })

    it('starts a new group after the agent speaks, and puts a message’s calls under its text', () => {
      const result = feed(agent({ text: 'Looking', toolCalls: [read('a.ts')] }), agent({ text: 'Fixing', toolCalls: [edit('a.ts')] }))
      expect(kinds(result)).toEqual(['assistant', 'tools', 'assistant', 'tools'])
    })

    it('names a single call instead of counting it, and flags a group with a failure', () => {
      const [group] = only(feed(agent({ toolCalls: [run({ error: 'Timed out' })] })), 'tools')
      expect(group).toMatchObject({ summary: 'Ran code', failed: true, entries: [{ error: 'Timed out' }] })
    })

    it('lists what the agent read through a tool with the tools, not as rows of their own', () => {
      const result = feed(agent({ toolCalls: [run()] }), observation({ title: 'PLAT-1' }), observation({ title: 'PLAT-2' }), agent({ toolCalls: [run()] }))
      const [group] = only(result, 'tools')
      expect(kinds(result)).toEqual(['tools'])
      expect(group.summary).toBe('Ran code 2 times, read 2 resources')
      expect(group.entries.map(({ type, label }) => [type, label])).toEqual([
        ['call', 'Ran code'], ['observation', 'Read PLAT-1'], ['observation', 'Read PLAT-2'], ['call', 'Ran code'],
      ])
    })

    it('keeps the thinking behind a silent step with the step', () => {
      const [group] = only(feed(agent({ reasoning: 'Check the worker', toolCalls: [read('worker.ts'), read('b.ts')] })), 'tools')
      expect(group.entries.map((entry) => entry.type === 'call' && entry.reasoning)).toEqual(['Check the worker', undefined])
    })

    it('shows a call’s code and output in its detail', () => {
      const [group] = only(feed(agent({ toolCalls: [call('executeCode', { code: 'run()' }, { output: '42' })] })), 'tools')
      expect(group.entries[0]).toMatchObject({ sections: [{ label: 'Code', text: 'run()' }, { label: 'Output', text: '42' }] })
    })

    it('keeps the group’s key when it grows, so what was opened stays open', () => {
      const first = history([agent({ toolCalls: [read('a.ts')] })])
      const grown = [...first, ...history([agent({ toolCalls: [read('b.ts')] })], 1)]
      expect(toChatFeed(grown).openTools?.key).toBe(toChatFeed(first).openTools?.key)
    })
  })

  describe('artefacts', () => {
    it('moves what a turn produced below everything else in it', () => {
      const result = feed(
        user('make a report'),
        agent({ text: 'Creating it', toolCalls: [createGadget(1)] }),
        bindHook({ title: 'Daily refresh' }),
        agent({ text: 'Now filling it in', toolCalls: [edit('report.md')] }),
        agent({ text: 'All done' }),
        user('thanks'),
        agent({ text: 'Any time' }),
      )
      expect(kinds(result)).toEqual(['user', 'assistant', 'assistant', 'tools', 'assistant', 'output', 'hook', 'user', 'assistant'])
    })

    it('keeps the open turn’s artefacts apart, to go under whatever is still streaming', () => {
      const result = feed(user('make a report'), agent({ text: 'Creating it', toolCalls: [createGadget(1)] }), agent({ toolCalls: [edit('report.md')] }))
      expect(result.items.map(({ kind }) => kind)).toEqual(['user', 'assistant'])
      expect(result.openTools).toMatchObject({ summary: 'Edited report.md' })
      expect(result.pinned).toMatchObject([{ kind: 'output', workpieceId: 1, title: 'Report' }])
    })

    it('does not end a turn at a message that steered it', () => {
      const result = feed(
        user('make a report'),
        agent({ text: 'Creating it', toolCalls: [createGadget(1)] }),
        user('make it short', { steered: true }),
        agent({ text: 'Short it is' }),
        user('thanks'),
      )
      expect(kinds(result)).toEqual(['user', 'assistant', 'user', 'assistant', 'output', 'user'])
    })

    it('shows a created gadget as a card and not as a tool call; a failed creation stays a call', () => {
      const failed = call('createGadget', { title: 'Broken', bindingName: 'X' }, { error: 'Name taken' })
      const result = feed(agent({ toolCalls: [createGadget(1), failed] }))
      expect(result.pinned).toMatchObject([{ kind: 'output', workpieceId: 1 }])
      expect(result.openTools?.entries.map(({ label }) => label)).toEqual(['Created gadget Broken'])
    })

    it('marks a created gadget as a draft until its changes are accepted', () => {
      const creation = [agent({ toolCalls: [createGadget(1)] }), created(1)]
      expect(only(feed(...creation), 'output')).toMatchObject([{ draft: true }])
      expect(only(feed(...creation, merge()), 'output')).toMatchObject([{ draft: false }])
    })

    it('opens nothing for a creation that was discarded, and leaves it as the step it was', () => {
      const result = feed(agent({ toolCalls: [createGadget(1)] }), created(1), revert(1))
      expect(only(result, 'output')).toEqual([])
      expect(only(result, 'tools')[0].entries).toMatchObject([{ label: 'Created gadget Report' }])
    })

    it('never calls a worktree a draft: it is private to the chat and needs no accepting', () => {
      const worktree = call('createWorktree', { title: 'Fix branch', bindingName: 'FIX', commitId: 'a'.repeat(40) }, { output: { worktreeId: 9, baseCommit: 'a'.repeat(40) } })
      expect(only(feed(agent({ toolCalls: [worktree] })), 'output')).toMatchObject([{ type: 'worktree', workpieceId: 9, draft: false }])
    })

    it('keeps an approval under the answer while it waits, and puts it back where it happened once decided', () => {
      const waiting = feed(user('file it'), agent({ text: 'Filing' }), action({ title: 'Create issue' }), agent({ text: 'Meanwhile' }))
      expect(kinds(waiting)).toEqual(['user', 'assistant', 'assistant', 'action'])
      expect(waiting.pinned).toMatchObject([{ kind: 'action', state: 'pending', resolution: undefined }])

      const decided = feed(
        user('file it'),
        agent({ text: 'Filing' }),
        action({ title: 'Create issue', state: 'approved' }),
        action({ title: 'Post', state: 'denied' }),
        agent({ text: 'Done' }),
      )
      expect(kinds(decided)).toEqual(['user', 'assistant', 'action', 'action', 'assistant'])
      expect(decided.pinned).toEqual([])
      expect(only(decided, 'action').map(({ state, resolution }) => [state, resolution])).toEqual([
        ['approved', 'Approved by Ada Lovelace'],
        ['denied', 'Denied by Ada Lovelace'],
      ])
    })

    it('lists an action a standing rule approved with the work that made it, since nobody was asked', () => {
      const result = feed(agent({ toolCalls: [run()] }), action({ title: 'Label', kind: LABEL, autoApprovedBy: VIEWER }), agent({ toolCalls: [run()] }))
      expect(kinds(result)).toEqual(['tools'])
      expect(result.openTools).toMatchObject({
        summary: 'Ran code 2 times, took 1 action',
        entries: [{ type: 'call' }, { type: 'action', label: 'Label', resolution: 'Auto-approved (Ada Lovelace’s rule)' }, { type: 'call' }],
      })
    })

    it('offers a standing approval only for a pending action whose gatekeeper allows one', () => {
      const result = feed(action({ title: 'Label', kind: LABEL }), action({ title: 'Create issue' }), action({ title: 'Relabel', kind: LABEL, state: 'approved' }))
      const rules = Object.fromEntries(only(result, 'action').map(({ title, rule }) => [title, rule]))
      expect(rules).toEqual({ Label: { gatekeeperId: 7, actionKind: LABEL }, 'Create issue': undefined, Relabel: undefined })
    })

    it('warns when a pending action’s description leaves out part of what it sends', () => {
      const result = feed(action({ title: 'Post', incomplete: true }), action({ title: 'Create issue' }))
      expect(only(result, 'action').map(({ incomplete }) => incomplete)).toEqual([true, false])
    })

    it('shows a hook with whether it is on, and a deleted one without a way to toggle it', () => {
      const result = feed(bindHook({ title: 'New issue', enabled: false }), bindHook({ title: 'Old', deleted: true }))
      expect(only(result, 'hook')).toMatchObject([{ title: 'New issue', enabled: false, hookId: expect.any(Number) }, { title: 'Old', hookId: undefined }])
    })

    it('keeps a connection request under the answer until it is answered, then where it was asked', () => {
      const result = feed(
        user('chart the errors'),
        request('accepted'),
        agent({ text: 'Connected. Deploys would need Grafana.' }),
        request('pending'),
        agent({ text: 'Meanwhile, the chart.' }),
        request('denied'),
      )
      expect(kinds(result)).toEqual(['user', 'connection', 'assistant', 'assistant', 'connection', 'connection'])
      expect(only(result, 'connection').map(({ state, scope }) => [state, scope])).toEqual([
        ['connected', 'ClickHouse cluster'], ['denied', 'ClickHouse cluster'], ['pending', 'ClickHouse cluster'],
      ])
      expect(result.pinned).toMatchObject([{ kind: 'connection', state: 'pending' }])
    })
  })

  describe('system rows', () => {
    it('reports saved edits, accepts and discards, as the viewer’s own or by name', () => {
      const other = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
      const result = feed(changes(), merge(), changes({ author: other }), revert(2, other))
      expect(only(result, 'notice').map(({ notice, text }) => [notice, text])).toEqual([
        ['changes', 'You saved edits'],
        ['merge', 'You accepted changes'],
        ['changes', 'Grace Hopper saved edits'],
        ['revert', 'Grace Hopper discarded changes'],
      ])
    })

    it('shows nothing for the agent’s own edits or the storage migration’s record', () => {
      expect(rows(feed(changes({ author: AGENT }), changes({ conversionBoundary: true })))).toEqual([])
    })

    it('offers Retry on the chat’s last error only, and only while no agent is running', () => {
      const messages = history([error('first'), user('again'), error('second')])
      expect(only(toChatFeed(messages), 'error').map(({ recovery }) => recovery)).toEqual([undefined, 'retry'])
      expect(only(toChatFeed(messages, { agentActive: true }), 'error').map(({ recovery }) => recovery)).toEqual([undefined, undefined])
      expect(only(toChatFeed([...messages, ...history([user('more')], 3)]), 'error').map(({ recovery }) => recovery)).toEqual([undefined, undefined])
    })

    it('offers Continue, not Retry, when the credits ran out', () => {
      expect(only(feed(error('Out of credits', { code: 'usage_limit' })), 'error')).toMatchObject([{ usageLimit: true, recovery: 'continue' }])
    })

    it('says when another model took over', () => {
      const result = feed(agent({ text: 'one' }), agent({ text: 'two' }), agent({ author: FAST_AGENT, text: 'three' }))
      expect(result.items).toMatchObject([
        { kind: 'assistant' },
        { kind: 'assistant' },
        { kind: 'notice', notice: 'model', text: 'Switched to Mock Model Fast' },
        { kind: 'assistant', text: 'three' },
      ])
    })

    it('marks where the context was cut once the messages before it are loaded', () => {
      const messages = history([user('old'), agent({ text: 'old answer' }), user('recent'), agent({ text: 'recent answer' })])
      expect(kinds(toChatFeed(messages, { compactedTo: 2 }))).toEqual(['user', 'assistant', 'divider', 'user', 'assistant'])
      expect(kinds(toChatFeed(messages.slice(2), { compactedTo: 2 }))).toEqual(['user', 'assistant'])
    })

    it('notes a gadget use once per run, and shows a call delivered to the agent', () => {
      const result = feed(useGadget(), useGadget(), agentCallback('onTicket', '{ key: "PLAT-1" }', 'TICKETS'))
      expect(only(result, 'notice')).toMatchObject([
        { notice: 'gadget', text: 'Used the gadget' },
        { notice: 'callback', text: 'onTicket() with env.TICKETS', detail: '{ key: "PLAT-1" }' },
      ])
    })
  })

  describe('identity', () => {
    it('returns the same rows for messages that did not change', () => {
      const messages = history([user('hi'), agent({ text: 'hello', toolCalls: [read('a.ts')] }), action({ title: 'Create issue' }), user('next')])
      const before = toChatFeed(messages, viewer)
      const after = toChatFeed([...messages, ...history([agent({ text: 'more' })], 4)], viewer, before)

      expect(after.items.slice(0, before.items.length)).toEqual(before.items)
      after.items.slice(0, before.items.length).forEach((item, index) => expect(item).toBe(before.items[index]))
      expect(toChatFeed(messages, viewer, before).items).toBe(before.items)
    })

    it('rebuilds only the row whose message was delivered again', () => {
      const hook = bindHook({ title: 'New issue' })
      const messages = history([user('hi'), hook, agent({ text: 'watching' })])
      const before = toChatFeed(messages, viewer)
      const switchedOff = { ...messages[1], actionLog: { ...hook.actionLog!, enabled: false } } as AiChatMessage
      const after = toChatFeed([messages[0], switchedOff, messages[2]], viewer, before)

      expect(after.items).toBe(before.items)
      expect(after.pinned).toMatchObject([{ kind: 'hook', enabled: false }])
      expect(after.pinned[0]).not.toBe(before.pinned[0])
    })
  })

  describe('recorded chats', () => {
    it.each(SCENARIOS.map((scenario) => [scenario.id, scenario] as const))('renders every message of the %s scenario', async (_id, scenario) => {
      expect(noFallback(toChatFeed(scenario.history, viewer))).toEqual([])

      const played = toChatFeed(await playThrough(new MockOverseer(scenario)), viewer)
      expect(noFallback(played)).toEqual([])
      const keys = rows(played).map(({ key }) => key)
      expect(new Set(keys).size).toBe(keys.length)
    })

    it('renders a chat recorded from a real backend', () => {
      const messages = readFixture(recordedDevChat)
      expect(messages[0].timestamp).toBeInstanceOf(Date)
      expect(toChatFeed(messages, { viewerId: 'dev' }).items).toMatchObject([
        { kind: 'user', text: 'First message from startConversation', from: undefined },
        { kind: 'user', text: 'Second message, sent live', from: undefined },
      ])
    })
  })
})
