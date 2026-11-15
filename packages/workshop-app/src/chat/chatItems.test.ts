import { describe, expect, it } from 'vitest'
import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import { continuesRun, toChatFeed, type ChatFeed, type ChatItem } from './chatItems'
import recordedDevChat from './fixtures/dev-chat.json'
import { readFixture } from './fixtures/readFixture'
import { toolLabel } from './toolCalls'
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
const rows = ({ items, pinned }: ChatFeed): ChatItem[] => [...items, ...pinned]
const kinds = (result: ChatFeed) => rows(result).map(({ kind }) => kind)
const only = <K extends ChatItem['kind']>(result: ChatFeed, kind: K) =>
  rows(result).filter((item): item is Extract<ChatItem, { kind: K }> => item.kind === kind)

const read = (filename: string) => call('readFile', { filename })
const edit = (filename: string) => call('editFile', { filename, textToReplace: 'a', replacement: 'b' })
const run = (rest: { output?: string; error?: string } = { output: 'ok' }) => call('executeCode', { code: 'run()' }, rest)
const createGadget = (gadgetId: number, title = 'Report') => call('createGadget', { title, bindingName: 'REPORT' }, { output: { gadgetId } })
const created = (gadgetId: number) => changes({ author: AGENT, createdGadgets: [{ gadgetId, title: 'Report', bindingName: 'REPORT' }] })
const write = (gadgetId: number, filename = 'client.js') => call('writeFile', { workpiece: 'TIP_JAR', filename, content: 'x' }, { workpieceId: gadgetId })
const labels = (result: ChatFeed) => result.work.map(({ label }) => label)

const request = (state: 'pending' | 'accepted' | 'denied') =>
  connectionRequest({ vendorName: 'ClickHouse', reason: 'Read error rates.', resourceTitle: 'ClickHouse cluster', state })
const LABEL = { tag: 'jira.label', label: 'Label an issue' }
const restore = (to: 'before' | 'after', removed?: string) => ({
  type: 'restore' as const,
  from: 0,
  to,
  commits: [],
  removedGadgets: removed ? [{ gadgetId: 4, title: removed }] : undefined,
  author: VIEWER,
})
const dividerLabels = (result: ChatFeed) => only(result, 'divider').map(({ label }) => label)
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

    it('sets the message a reply opens with apart from what was written, mentions still in place', () => {
      const quote = '> The chart now covers 12 weeks\n\n'
      const capsule = {
        position: quote.length + 4,
        length: 3,
        gatekeeperId: 3,
        description: { url: 'https://jira.example.com/PLAT-1', title: 'PLAT-1', snippet: '', suggestedBindingName: 'ISSUE', tsType: 'Issue' },
      }
      const [item] = only(feed(user(`${quote}See [0] too`, { capsules: [capsule] })), 'user')

      expect(item.quote).toBe('The chart now covers 12 weeks')
      expect(item.parts).toEqual([
        { type: 'text', text: 'See ' },
        { type: 'capsule', title: 'PLAT-1', url: 'https://jira.example.com/PLAT-1' },
        { type: 'text', text: ' too' },
      ])
    })

    it('sets the quote of a reply the agent has not read yet apart too', () => {
      const result = toChatFeed(history([user('go')]), { ...viewer, agentActive: true, steers: [{ text: '> go\n\nand faster', unread: true }] })
      expect(only(result, 'user').at(-1)).toMatchObject({ quote: 'go', parts: [{ type: 'text', text: 'and faster' }], unread: true })
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
      expect(only(feed(compactCommand()), 'user')).toMatchObject([{ parts: [{ type: 'command', name: 'compact', builtin: true }] }])
    })

    it('says who wrote a reply and when, and keeps what it thought first behind it rather than in the conversation', () => {
      const messages = history([agent({ text: 'Done', reasoning: 'Thinking it through' })])
      const result = toChatFeed(messages, viewer)
      expect(result.items).toEqual([{
        kind: 'assistant',
        id: 0,
        key: 'assistant:0',
        text: 'Done',
        sender: 'Mock Model',
        sentAt: messages[0].timestamp,
        trace: [{ type: 'thinking', key: 'thinking:0', text: 'Thinking it through' }],
        skills: [],
      }])
      expect(result.work).toEqual([])
    })

    it('says when a person’s message was sent', () => {
      const messages = history([user('hi'), slashCommand({ name: 'review', args: 'the intro', commandPosition: 0 })])
      expect(only(toChatFeed(messages, viewer), 'user').map(({ sentAt }) => sentAt)).toEqual([messages[0].timestamp, messages[1].timestamp])
    })

    it('draws consecutive messages from one sender as a run, unless the later one has its own heading', () => {
      const other = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
      const brief = { attachments: [{ id: 'a', mimeType: 'application/pdf', name: 'brief.pdf', size: 10 }] }
      const { items } = feed(
        user('one'),
        user('two'),
        user('three', { author: other }),
        user('', brief),
        user('with a file', brief),
        agent({ text: 'first' }),
        agent({ toolCalls: [read('a.ts')] }),
        agent({ text: 'second' }),
        user('four'),
      )
      expect(items.map((item, index) => continuesRun(items[index - 1], item))).toEqual([false, true, false, false, true, false, true, false])
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

  describe('the work behind an answer', () => {
    it('is not part of the conversation: the steps since the last message are kept beside it', () => {
      const steps = [user('go'), agent({ toolCalls: [read('a.ts'), read('b.ts')] }), agent({ toolCalls: [run()] })]
      const working = feed(...steps)
      expect(kinds(working)).toEqual(['user'])
      expect(working.work.map(({ label }) => label)).toEqual(['Read a.ts', 'Read b.ts', 'Ran code'])

      // What it says next leaves those steps behind; what it does as it says it starts the next lot.
      const spoke = feed(...steps, agent({ text: 'Found it', toolCalls: [edit('a.ts')] }))
      expect(kinds(spoke)).toEqual(['user', 'assistant'])
      expect(spoke.work.map(({ label }) => label)).toEqual(['Edited a.ts'])
      expect(feed(...steps, agent({ text: 'Done' })).work).toEqual([])
    })

    it('goes with the message it led to: the steps since the message before, then what was thought last', () => {
      const result = feed(
        user('go'),
        agent({ reasoning: 'Check the worker', toolCalls: [read('a.ts')] }),
        observation({ title: 'PLAT-1' }),
        agent({ text: 'Found it', reasoning: 'The window is a constant', toolCalls: [edit('a.ts')] }),
        agent({ text: 'Done' }),
      )
      expect(only(result, 'assistant').map(({ text, trace }) => [text, trace.map((step) => (step.type === 'thinking' ? step.text : step.label))])).toEqual([
        ['Found it', ['Read a.ts', 'Read PLAT-1', 'The window is a constant']],
        ['Done', ['Edited a.ts']],
      ])
      // The thinking behind the silent step stays with what it did.
      expect(only(result, 'assistant')[0].trace[0]).toMatchObject({ reasoning: 'Check the worker' })
    })

    it('keeps a reply the same row while what led to it is unchanged', () => {
      const messages = history([user('go'), agent({ toolCalls: [read('a.ts')] }), agent({ text: 'Found it', reasoning: 'Hm' })])
      const before = toChatFeed(messages, viewer)
      const after = toChatFeed([...messages, ...history([agent({ text: 'More' })], 3)], viewer, before)
      expect(after.items[1]).toBe(before.items[1])
    })

    it('starts over with the next prompt, but not with a message that steers the turn', () => {
      const turn = [user('go'), agent({ toolCalls: [read('a.ts')] })]
      expect(feed(...turn, user('and now?')).work).toEqual([])
      expect(feed(...turn, user('shorter', { steered: true })).work.map(({ label }) => label)).toEqual(['Read a.ts'])
    })

    it('lists what the agent read through a tool as steps, between the calls that read it', () => {
      const result = feed(agent({ toolCalls: [run()] }), observation({ title: 'PLAT-1' }), observation({ title: 'PLAT-2' }), agent({ toolCalls: [run()] }))
      expect(kinds(result)).toEqual([])
      expect(result.work.map(({ type, label }) => [type, label])).toEqual([
        ['call', 'Ran code'], ['observation', 'Read PLAT-1'], ['observation', 'Read PLAT-2'], ['call', 'Ran code'],
      ])
    })

    it('names a skill the agent read as one it used, and the reply as having used it, once', () => {
      const brief = observation({ title: 'Context read: meeting-brief', skill: 'meeting-brief' })
      const result = feed(user('prep me'), brief, observation({ title: 'PLAT-1' }), { ...brief }, agent({ text: 'Here it is' }))
      const [reply] = only(result, 'assistant')
      expect(reply.trace.map((step) => step.type === 'observation' && [step.label, step.skill])).toEqual([
        ['Used Meeting brief', 'Meeting brief'], ['Read PLAT-1', undefined], ['Used Meeting brief', 'Meeting brief'],
      ])
      expect(reply.skills).toEqual(['Meeting brief'])
      expect(only(feed(user('go'), agent({ text: 'Done' })), 'assistant')[0].skills).toEqual([])
    })

    it('keeps the thinking behind a silent step with the first thing it did', () => {
      const { work } = feed(agent({ reasoning: 'Check the worker', toolCalls: [read('worker.ts'), read('b.ts')] }))
      expect(work.map((entry) => entry.type === 'call' && entry.reasoning)).toEqual(['Check the worker', undefined])
    })

    it('shows a call’s code and output, and its failure, in its detail', () => {
      const { work } = feed(agent({ toolCalls: [call('executeCode', { code: 'run()' }, { output: '42' }), run({ error: 'Timed out' })] }))
      expect(work).toMatchObject([
        { sections: [{ label: 'Code', text: 'run()' }, { label: 'Output', text: '42' }] },
        { error: 'Timed out' },
      ])
    })

    describe('in plain words', () => {
      it('says what code did in the agent’s own words, as a step', () => {
        const summarised = call('executeCode', { code: 'run()', summary: 'checking this week’s orders.' }, { output: 'ok' })
        expect(labels(feed(agent({ toolCalls: [summarised, run()] })))).toEqual(['Checking this week’s orders', 'Ran code'])
      })

      it('names the gadget a file step touched, building one the chat made until it is kept', () => {
        const making = [agent({ toolCalls: [createGadget(1, 'Tip Jar')] }), created(1), agent({ toolCalls: [write(1), call('readFile', { filename: 'client.js' }, { workpieceId: 1 })] })]
        expect(labels(feed(...making))).toEqual(['Built Tip Jar', 'Looked over Tip Jar'])
        // What was built stays built; once it is kept, it is being changed.
        expect(labels(feed(...making, merge(), agent({ toolCalls: [write(1)] })))).toEqual(['Built Tip Jar', 'Looked over Tip Jar', 'Updated Tip Jar'])
      })

      it('names a gadget the chat did not make by the workspace’s title for it, which follows a rename', () => {
        const messages = history([agent({ toolCalls: [write(5)] })])
        const before = toChatFeed(messages, { gadgets: new Map([[5, { title: 'Tip Jar' }]]) })
        expect(labels(before)).toEqual(['Updated Tip Jar'])
        const renamed = toChatFeed(messages, { gadgets: new Map([[5, { title: 'Tips' }]]) }, before)
        expect(labels(renamed)).toEqual(['Updated Tips'])
        // A title that did not change leaves the step as it was.
        expect(toChatFeed(messages, { gadgets: new Map([[5, { title: 'Tips' }]]) }, renamed).work[0]).toBe(renamed.work[0])
      })

      it('falls back to what a gadget is, and keeps the file in the step’s detail', () => {
        const { work } = toChatFeed(history([agent({ toolCalls: [write(5)] })]), { gadgets: new Map([[5, { title: '', noun: 'Document' }]]) })
        expect(work).toMatchObject([{ label: 'Updated the document', sections: [{ label: 'File', text: 'client.js' }, { label: 'Content', text: 'x' }] }])
      })

      it('says what the agent made a gadget, and what kind it created', () => {
        const made = call('setGadgetFormat', { gadget: 'TIP_JAR', format: { noun: 'Dashboard', icon: 'chartBar' } }, { workpieceId: 5 })
        const plain = call('setGadgetFormat', { gadget: 'TIP_JAR', format: null }, { workpieceId: 5 })
        const { work } = toChatFeed(history([agent({ toolCalls: [made, plain] })]), { gadgets: new Map([[5, { title: 'Tip Jar', noun: 'Dashboard' }]]) })
        expect(work.map(({ label }) => label)).toEqual(['Made Tip Jar a dashboard', 'Made Tip Jar a plain app'])
        const typed = call('createGadget', { title: 'Sales', bindingName: 'SALES', format: { noun: 'Tracker', icon: 'listChecks' } }, { output: { gadgetId: 6, changeId: 1 } })
        expect(toolLabel(typed)).toBe('Created tracker Sales')
      })

      it('names the file when the gadget is not known, as in chats from before it was recorded', () => {
        const unrecorded = call('writeFile', { filename: 'client.js', content: 'x' })
        const { work } = feed(agent({ toolCalls: [unrecorded, write(8)] }))
        expect(work).toMatchObject([{ label: 'Wrote client.js', sections: [{ label: 'Content' }] }, { label: 'Wrote client.js' }])
      })
    })

    it('keeps each step’s key as more are taken, so what was opened stays open', () => {
      const first = history([agent({ toolCalls: [read('a.ts')] })])
      const grown = [...first, ...history([agent({ toolCalls: [read('b.ts')] })], 1)]
      const before = toChatFeed(first)
      const after = toChatFeed(grown, {}, before)
      expect(after.work[0]).toBe(before.work[0])
      expect(toChatFeed(grown, {}, after).work).toBe(after.work)
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
      expect(kinds(result)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'output', 'hook', 'user', 'assistant'])
    })

    it('keeps the open turn’s artefacts apart, to go under whatever is still streaming', () => {
      const result = feed(user('make a report'), agent({ text: 'Creating it', toolCalls: [createGadget(1)] }), agent({ toolCalls: [edit('report.md')] }))
      expect(result.items.map(({ kind }) => kind)).toEqual(['user', 'assistant'])
      expect(result.work).toMatchObject([{ label: 'Edited report.md' }])
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

    it('shows a created gadget as a card and not as a step; a failed creation stays a step', () => {
      const failed = call('createGadget', { title: 'Broken', bindingName: 'X' }, { error: 'Name taken' })
      const result = feed(agent({ toolCalls: [createGadget(1), failed] }))
      expect(result.pinned).toMatchObject([{ kind: 'output', workpieceId: 1 }])
      expect(result.work.map(({ label }) => label)).toEqual(['Created gadget Broken'])
    })

    it('marks a created gadget as a draft until its changes are accepted', () => {
      const creation = [agent({ toolCalls: [createGadget(1)] }), created(1)]
      expect(only(feed(...creation), 'output')).toMatchObject([{ draft: true }])
      expect(only(feed(...creation, merge()), 'output')).toMatchObject([{ draft: false }])
    })

    it('opens nothing for a creation that was discarded, and leaves it as the step it was', () => {
      const result = feed(agent({ toolCalls: [createGadget(1)] }), created(1), revert(1))
      expect(only(result, 'output')).toEqual([])
      expect(result.work).toMatchObject([{ label: 'Created gadget Report' }])
    })

    it('never calls a worktree a draft: it is private to the chat and needs no accepting', () => {
      const worktree = call('createWorktree', { title: 'Fix branch', bindingName: 'FIX', commitId: 'a'.repeat(40) }, { output: { worktreeId: 9, baseCommit: 'a'.repeat(40) } })
      expect(only(feed(agent({ toolCalls: [worktree] })), 'output')).toMatchObject([{ type: 'worktree', workpieceId: 9, draft: false }])
    })

    it('leaves an approval where it was decided: below what was written while it waited, above what came after', () => {
      const messages = history([
        user('file it'),
        agent({ text: 'Filing' }),
        action({ title: 'Post', state: 'approved' }),
        agent({ text: 'Written while it waited' }),
        agent({ text: 'Written after' }),
        agent({ toolCalls: [createGadget(1)] }),
      ])
      const decidedAt = (time: number) => {
        const waited = messages[2] as Extract<AiChatMessage, { type: 'action' }>
        const answered: AiChatMessage = { ...waited, actionLog: { ...waited.actionLog!, appliedAt: new Date(time) } }
        return toChatFeed(messages.with(2, answered), viewer)
      }

      const between = decidedAt((messages[3].timestamp.getTime() + messages[4].timestamp.getTime()) / 2)
      expect(kinds(between)).toEqual(['user', 'assistant', 'assistant', 'action', 'assistant', 'output'])

      // Decided after everything said so far, it is the last thing said, above what the turn produced.
      const last = decidedAt(messages[5].timestamp.getTime() + 1)
      expect(kinds(last)).toEqual(['user', 'assistant', 'assistant', 'assistant', 'action', 'output'])
      expect(last.pinned).toMatchObject([{ kind: 'output' }])
    })

    it('keeps an approval under the answer while it waits, and takes one decided before anything else was said as decided where it was asked', () => {
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

    it('shows an action a standing rule approved where it happened, already decided', () => {
      const result = feed(agent({ text: 'Labelling' }), action({ title: 'Label', kind: LABEL, autoApprovedBy: VIEWER }), agent({ text: 'Labelled' }))
      expect(kinds(result)).toEqual(['assistant', 'action', 'assistant'])
      expect(only(result, 'action')).toMatchObject([{ title: 'Label', state: 'approved', resolution: 'Auto-approved (Ada Lovelace’s rule)', rule: undefined }])
    })

    it('offers a standing approval only for a pending action whose gatekeeper allows one', () => {
      const result = feed(action({ title: 'Label', kind: LABEL }), action({ title: 'Create issue' }), action({ title: 'Relabel', kind: LABEL, state: 'approved' }))
      const rules = Object.fromEntries(only(result, 'action').map(({ title, rule }) => [title, rule]))
      expect(rules).toEqual({ Label: { gatekeeperId: 7, actionKind: LABEL }, 'Create issue': undefined, Relabel: undefined })
    })

    it('says which pending actions create something, by the gatekeeper standing in for it', () => {
      const result = feed(action({ title: 'Create Google Doc: Notes', creation: true }), action({ title: 'Create Google Doc: Old', creation: true, state: 'approved' }), action({ title: 'Post' }))
      const creations = Object.fromEntries(only(result, 'action').map(({ title, creation }) => [title, creation]))
      expect(creations).toEqual({ 'Create Google Doc: Notes': { gatekeeperId: 7 }, 'Create Google Doc: Old': undefined, Post: undefined })
    })

    it('draws an approved creation of a Google file as the file, to be opened', () => {
      const doc = 'https://docs.google.com/document/d/abc123/edit'
      const result = feed(
        action({ title: 'Create Google Doc: Notes', creation: true, state: 'approved', resource: { title: 'Notes', url: doc } }),
        action({ title: 'Create Google Doc: Later', creation: true, resource: { title: 'Later', url: doc } }),
        action({ title: 'Post', state: 'approved', resource: { title: 'Notes', url: doc } }),
      )
      const made = Object.fromEntries(only(result, 'action').map(({ title, made }) => [title, made]))
      expect(made).toEqual({
        'Create Google Doc: Notes': { gatekeeperId: 7, subjectId: 'abc123', title: 'Notes', fileKind: 'document', url: doc },
        'Create Google Doc: Later': undefined,
        Post: undefined,
      })
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
    it('marks saved edits, accepts and discards, as the viewer’s own or by name, but not the viewer’s own accepts', () => {
      const other = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
      const result = feed(changes(), merge(), changes({ author: other }), revert(2, other), changes(), merge(other))
      expect(only(result, 'divider').map(({ marks, label }) => [marks, label])).toEqual([
        ['changes', 'You saved edits'],
        ['changes', 'Grace Hopper saved edits'],
        ['revert', 'Grace Hopper discarded changes'],
        ['changes', 'You saved edits'],
        ['merge', 'Grace Hopper applied changes'],
      ])
    })

    it('puts what someone did after an answer below what the answer produced', () => {
      const turn = [user('make a report'), agent({ text: 'Here it is', toolCalls: [createGadget(1)] }), created(1), changes(), merge()]
      const open = feed(...turn)
      expect(kinds(open)).toEqual(['user', 'assistant', 'output', 'divider'])
      expect(open.pinned).toMatchObject([{ kind: 'output', draft: false }, { label: 'You saved edits' }])

      expect(kinds(feed(...turn, user('thanks')))).toEqual(['user', 'assistant', 'output', 'divider', 'user'])
    })

    it('leaves it where it happened when the agent carried on afterwards', () => {
      const result = feed(
        user('make a report'),
        agent({ text: 'Creating it', toolCalls: [createGadget(1)] }),
        changes(),
        agent({ text: 'I see your edits; finishing up' }),
        merge({ type: 'user', id: 'grace@example.com', name: 'Grace Hopper' }),
      )
      expect(rows(result).map((row) => (row.kind === 'divider' ? row.label : row.kind))).toEqual([
        'user', 'assistant', 'You saved edits', 'assistant', 'output', 'Grace Hopper applied changes',
      ])
    })

    it('marks going back to an earlier point, and undoing one that made a gadget', () => {
      expect(dividerLabels(feed(user('undo it'), restore('before')))).toEqual(['You undid changes'])
      expect(dividerLabels(feed(user('undo it'), restore('before', 'Tip Jar')))).toEqual(['You undid creating “Tip Jar”'])
      expect(dividerLabels(feed(user('go back'), restore('after')))).toEqual(['You went back to an earlier version'])
      expect(noFallback(feed(restore('after')))).toEqual([])
    })

    it('shows a report from an agent the chat set up as said by that agent, where it arrived', () => {
      const report = { type: 'agentReport' as const, runChatId: 7, agentName: 'Digest', message: 'Three new issues.', author: AGENT }
      const result = feed(user('set it up'), agent({ text: 'Done' }), report, user('thanks'))
      expect(kinds(result)).toEqual(['user', 'assistant', 'report', 'user'])
      expect(only(result, 'report')).toMatchObject([{ agentName: 'Digest', text: 'Three new issues.', runChatId: 7 }])
      expect(continuesRun(only(result, 'assistant')[0], only(result, 'report')[0])).toBe(false)
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

    it('shows nothing for the error a stopped turn ends with', () => {
      const result = feed(user('go'), agent({ text: 'Working on it' }), error('User requested to stop agent.'), user('again'), error('Overloaded'))
      expect(only(result, 'error')).toMatchObject([{ text: 'Overloaded', recovery: 'retry' }])
    })

    it('offers Continue, not Retry, when the credits ran out', () => {
      expect(only(feed(error('Out of credits', { code: 'usage_limit' })), 'error')).toMatchObject([{ usageLimit: true, recovery: 'continue' }])
    })

    it('leaves another model taking over to the messages’ details', () => {
      const result = feed(agent({ text: 'one' }), agent({ author: FAST_AGENT, text: 'two' }))
      expect(result.items).toMatchObject([
        { kind: 'assistant', sender: 'Mock Model' },
        { kind: 'assistant', sender: 'Mock Model Fast', text: 'two' },
      ])
    })

    it('marks where the context was cut by a compaction that ran on its own, once the messages before it are loaded', () => {
      const messages = history([user('old'), agent({ text: 'old answer' }), user('recent'), agent({ text: 'recent answer' })])
      expect(kinds(toChatFeed(messages, { compactedTo: 2 }))).toEqual(['user', 'assistant', 'divider', 'user', 'assistant'])
      expect(kinds(toChatFeed(messages.slice(2), { compactedTo: 2 }))).toEqual(['user', 'assistant'])
    })

    it('answers /compact under the command, not back where the context was cut', () => {
      const messages = history([user('old'), agent({ text: 'old answer' }), user('recent'), agent({ text: 'recent answer' }), compactCommand()])
      const asked = toChatFeed(messages, { compactedTo: 2 })
      expect(kinds(asked)).toEqual(['user', 'assistant', 'user', 'assistant', 'user', 'divider'])
      expect(asked.items.at(-1)).toMatchObject({ marks: 'compaction', label: 'Context compacted' })
      // Until the compaction has happened there is nothing to say.
      expect(kinds(toChatFeed(messages))).toEqual(['user', 'assistant', 'user', 'assistant', 'user'])
    })

    it('keeps a gadget use with the agent’s other steps, once per run', () => {
      const result = feed(user('check the board'), useGadget(), useGadget(), agent({ toolCalls: [read('a.ts')] }), useGadget(), agent({ text: 'Done' }))
      expect(kinds(result)).toEqual(['user', 'assistant'])
      expect(only(result, 'assistant')[0].trace.map((step) => (step.type === 'call' ? step.label : step.type))).toEqual(['Used the gadget', 'Read a.ts', 'Used the gadget'])
    })

    it('says on the reply what call woke the agent, by the automation’s title, keeping the call for its details', () => {
      const args = '[0]: {scheduleId: "s1", title: "Tell a \\"clean\\" joke", description: "Every 2 minutes"}'
      const result = feed(user('jokes'), agent({ text: 'Set up' }), agentCallback('onSchedule', args, 'onSchedule_ARGS'), agent({ text: 'A joke' }), agent({ text: 'Another' }))
      expect(kinds(result)).toEqual(['user', 'assistant', 'assistant', 'assistant'])
      const [, woken, after] = only(result, 'assistant')
      expect(woken.prompt).toEqual({ label: 'Tell a "clean" joke', call: 'onSchedule() with env.onSchedule_ARGS', args })
      expect(after.prompt).toBeUndefined()
    })

    it('names the automation once over a run of replies it woke', () => {
      const args = '{title: "Tell a joke"}'
      const result = feed(agentCallback('onSchedule', args, 'A'), agent({ text: 'One' }), agentCallback('onSchedule', args, 'A'), agent({ text: 'Two' }), user('hi'), agent({ text: 'Hello' }), agentCallback('onSchedule', args, 'A'), agent({ text: 'Three' }))
      expect(only(result, 'assistant').map(({ prompt }) => prompt && (prompt.again ? 'again' : prompt.label))).toEqual(['Tell a joke', 'again', undefined, 'Tell a joke'])
    })

    it('names a call whose arguments give no title by what it is', () => {
      const result = feed(agentCallback('onTicket', '{ key: "PLAT-1" }', 'TICKETS'), agent({ text: 'On it' }))
      expect(only(result, 'assistant')[0].prompt).toMatchObject({ label: 'An automation', call: 'onTicket() with env.TICKETS' })
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
