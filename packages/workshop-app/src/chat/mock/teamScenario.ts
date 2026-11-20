import type { ActionLogEntry, AiChatAuthorInfo, AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { EXAMPLE_AGENT_SETUPS } from '@/automations/exampleAgents'
import {
  action, agent, bindHook, connectionRequest, error, history, observation, say, turn, user, VIEWER,
  type MessageSource, type MockAutomation, type MockChat, type Scenario,
} from './scenario'

// The viewer's coworkers, who have chats of their own in the workspace.
const GRACE: AiChatAuthorInfo = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' }
const ALAN: AiChatAuthorInfo = { type: 'user', id: 'alan@example.com', name: 'Alan Turing' }
const KATHERINE: AiChatAuthorInfo = { type: 'user', id: 'katherine@example.com', name: 'Katherine Johnson' }
const WORKING: AiChatAuthorInfo = { type: 'agent', id: 'mock-model', name: 'Mock Model' }

const MINUTE = 60_000
const HOUR = 60
const DAY = 24 * HOUR
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE)

/**
 * Another chat of the workspace, its messages each so many minutes ago, oldest first: the actions
 * among them made from it as they were, and decided a minute later where they were.
 */
const chat = (
  id: number,
  title: string,
  steps: Array<[minutesAgo: number, source: MessageSource]>,
  more: { unread?: number; meta?: Partial<AiChatMetadata> } = {},
): MockChat => {
  const messages = steps.map(([minutes, source], sequence): AiChatMessage => {
    const timestamp = ago(minutes)
    const message = { ...(typeof source === 'function' ? source(sequence) : source), chatId: id, sequence, timestamp } as AiChatMessage
    if (message.type !== 'action' || !message.actionLog) return message
    const log = message.actionLog
    const appliedAt = log.type === 'action' && log.appliedAt ? new Date(timestamp.getTime() + MINUTE) : undefined
    return { ...message, actionLog: { ...log, chatId: id, createdAt: timestamp, ...(appliedAt ? { appliedAt } : {}) } as ActionLogEntry }
  })
  return {
    chat: { id, title, started: messages[0]!.timestamp, lastActive: messages.at(-1)!.timestamp, ...more.meta },
    messages,
    unread: more.unread,
  }
}

const PR = { title: 'cloudflare/workshop', url: 'https://github.com/cloudflare/workshop' }
const SLACK = { title: 'Slack · #eng-deploys' }
const DRIVE = { title: 'Google Drive' }
const CALENDAR = { title: 'Google Calendar · Team' }

const CHATS: MockChat[] = [
  // Grace's, paused on a pull request she is waiting for, with a post that does not hold it up.
  chat(1001, 'Fix the login redirect', [
    [3 * HOUR, user('After signing in I land on the home page instead of where I was. Can you fix it and open a PR?', { author: GRACE })],
    [3 * HOUR - 2, agent({ text: 'The sign-in page drops the `next` parameter. I’ll fix it and push to a branch.' })],
    [3 * HOUR - 5, action({ title: 'Push 2 commits to fix/login-redirect', resource: PR, autoApprovedBy: GRACE })],
    [16, action({ title: 'Open a pull request', description: 'Opens a pull request from `fix/login-redirect` into `main`.', resource: PR, awaitDecision: true })],
    [14, action({ title: 'Post to #eng-deploys', fields: [{ label: 'Message', kind: 'text', value: 'Login redirect fix is up for review.' }], resource: SLACK })],
  ], { unread: 2, meta: { awaitingDecision: true } }),
  // The viewer's own, with an action of its own waiting that does not hold the agent up.
  chat(1002, 'Q3 planning doc', [
    [2 * HOUR, user('Turn the planning notes into a Q3 plan and share it with finance.')],
    [2 * HOUR - 3, action({ title: 'Create document “Q3 plan”', resource: DRIVE, resolvedBy: VIEWER, state: 'approved', creation: true })],
    [50, action({ title: 'Share “Q3 plan” with finance@example.com', description: 'Gives **finance@example.com** permission to comment.', resource: DRIVE })],
    [49, agent({ text: 'The plan is written. Sharing it with finance waits on your approval.' })],
  ]),
  // Alan's, stopped on a connection nobody has made yet: nothing for an action to say.
  chat(1003, 'Sprint report', [
    [80, user('Write up the sprint report from the Jira board.', { author: ALAN })],
    [78, connectionRequest({ vendorName: 'Jira', resourceTitle: 'Jira · Platform board', reason: 'To read the sprint’s tickets.' })],
  ], { meta: { awaitingDecision: true } }),
  // Katherine's, paused on a share for two days now.
  chat(1014, 'Q4 hiring plan', [
    [2 * DAY + 3 * HOUR, user('Draft the Q4 hiring plan from the headcount sheet and share it with leadership.', { author: KATHERINE })],
    [2 * DAY + 3 * HOUR - 2, observation({ title: 'Headcount 2026', resource: DRIVE })],
    [2 * DAY + 3 * HOUR - 4, agent({ text: 'The plan has six roles, two of them backfills. Sharing it waits on an approval.' })],
    [2 * DAY + 3 * HOUR - 5, action({ title: 'Share “Q4 hiring plan” with leadership@example.com', resource: DRIVE, awaitDecision: true })],
  ], { meta: { awaitingDecision: true } }),
  // Grace's, stopped on a connection to a service nobody has connected yet.
  chat(1015, 'Expense report cleanup', [
    [35, user('Go through last month’s expense reports and flag anything over policy.', { author: GRACE })],
    [34, agent({ text: 'I need Expensify to read them. Can someone connect it?' })],
    [33, connectionRequest({ vendorName: 'Expensify', resourceTitle: 'Expensify · Company', reason: 'To read last month’s expense reports.' })],
  ], { meta: { awaitingDecision: true } }),
  // Finished, with changes to keep or discard.
  chat(1004, 'Tip jar polish', [
    [5 * HOUR, user('Make the changelog page and the forecast match the new brand colours.')],
    [2 * HOUR, agent({ text: 'Both are restyled. Have a look before you keep them.' })],
  ], { meta: { proposedChangeWorkpieces: [8, 10] } }),
  chat(1005, 'Pricing page copy', [
    [7 * HOUR, user('Tighten the copy on the issue triage page.', { author: ALAN })],
    [6 * HOUR, agent({ text: 'Shorter headings, and the long paragraph is now three bullets.' })],
  ], { meta: { proposedChangeWorkpieces: [9] } }),
  // Unread, by coworkers.
  chat(1006, 'Customer interview notes', [
    [3 * DAY, user('Summarise the interview transcripts and file the themes.', { author: KATHERINE })],
    [3 * DAY - 2, observation({ title: 'Interview transcripts', description: 'Read 6 files from the shared folder.', resource: DRIVE })],
    [3 * DAY - 5, action({ title: 'Create issue “Theme: onboarding is slow”', resource: { title: 'Linear · Research' }, resolvedBy: GRACE, state: 'approved' })],
    [30, user('Uploaded the last two transcripts. Can someone pull out the themes before Thursday?', { author: KATHERINE })],
    [28, agent({ text: 'Two new themes: pricing confusion, and the import step.' })],
    [25, user('Thanks! Filing them now.', { author: KATHERINE })],
  ], { unread: 3 }),
  chat(1007, 'Offsite agenda', [
    [DAY + 3 * HOUR, user('Book dinner for the offsite on Friday.', { author: ALAN })],
    [DAY + 3 * HOUR - 2, action({ title: 'Book a table for 12', resource: { title: 'OpenTable' }, resolvedBy: ALAN, state: 'denied' })],
    [5 * HOUR, user('Moved the hike to Saturday morning.', { author: ALAN })],
  ], { unread: 1 }),
  // At work now.
  chat(1008, 'Data cleanup', [
    [40, user('Find the duplicate customers in the CRM export and merge them.', { author: GRACE })],
    [1, agent({ text: 'Comparing 4,210 rows by email and company…' })],
  ], { meta: { activeAgent: WORKING } }),
  chat(1009, 'Migrate the billing tables', [
    [25, user('Move the billing tables to the new schema, in a worktree.')],
    [2, agent({ text: 'Rewriting the third of five migrations.' })],
  ], { meta: { activeAgent: WORKING } }),
  // Older, with all of it decided.
  chat(1010, 'Weekly metrics', [
    [2 * DAY, user('Post the weekly metrics to #leadership every Monday.', { author: GRACE })],
    [2 * DAY - 2, observation({ title: 'Metrics dashboard', resource: { title: 'Grafana · Business' } })],
    [2 * DAY - 4, bindHook({ title: 'Weekly metrics every Monday', description: 'Posts the week’s numbers to **#leadership**.', resource: { title: 'Every Monday at 9:00' } })],
    [2 * DAY - 6, action({ title: 'Post to #leadership', resource: { title: 'Slack · #leadership' }, autoApprovedBy: GRACE })],
  ]),
  chat(1011, 'Vendor contract summary', [
    [4 * DAY, user('What does the new vendor contract say about renewals?', { author: KATHERINE })],
    [4 * DAY - 1, observation({ title: 'Vendor MSA 2026.pdf', resource: DRIVE })],
    [4 * DAY - 3, agent({ text: 'It renews each year unless cancelled 60 days ahead.' })],
  ]),
  chat(1012, 'Hiring loop schedule', [
    [6 * DAY, user('Schedule the interview loop for the staff engineer candidate.')],
    [6 * DAY - 2, action({ title: 'Add 4 interviews to Team calendar', resource: CALENDAR, resolvedBy: VIEWER, state: 'approved', creation: true })],
    [6 * DAY - 3, action({ title: 'Email the candidate the schedule', resource: { title: 'Gmail · ada@example.com' }, resolvedBy: ALAN, state: 'denied' })],
    [6 * DAY - 5, agent({ text: 'The loop is on the calendar. I didn’t send the email.' })],
  ]),
  chat(1013, 'Roadmap slides', [
    [9 * DAY, user('Make slides from the roadmap doc for the all-hands.', { author: ALAN })],
    [9 * DAY - 2, observation({ title: 'Roadmap 2027', resource: DRIVE })],
    [9 * DAY - 4, action({ title: 'Create presentation “Roadmap 2027”', resource: DRIVE, resolvedBy: ALAN, state: 'approved', creation: true })],
  ]),
]

// An agent's run, as the gadget that starts it names it, after what it was started for.
const run = (id: number, spawner: { spawnerId: number; spawnerName: string }, title: string, steps: Array<[minutesAgo: number, source: MessageSource]>, meta: Partial<AiChatMetadata> = {}) =>
  chat(id, title, steps, { meta: { ...spawner, notificationsRequireParticipation: true, ...meta } })

const INBOX = { spawnerId: 41, spawnerName: 'Inbox helper' }
const NOTES = { spawnerId: 42, spawnerName: 'Release notes' }
const TICKETS = { spawnerId: 43, spawnerName: 'Ticket summarizer' }

const RUNS: MockChat[] = [
  run(2101, INBOX, 'Invoice 4471 overdue', [
    [6, agent({ text: 'Acme says invoice 4471 is 30 days overdue. I drafted a reply with the payment date.' })],
    [5, action({ title: 'Send a reply to billing@acme.com', resource: { title: 'Gmail · ada@example.com' }, awaitDecision: true })],
  ], { awaitingDecision: true }),
  run(2102, INBOX, 'Contract renewal with Acme', [
    [92, agent({ text: 'The renewal is due next month. I’ll forward it to legal and carry on with the summary.' })],
    [90, action({ title: 'Forward to legal@example.com', resource: { title: 'Gmail · ada@example.com' } })],
    [89, agent({ text: 'Summary: same terms, 4% higher, renews on December 1.' })],
  ]),
  run(2103, INBOX, 'Lunch on Friday?', [[48, agent({ text: 'Replied that Friday works, and suggested the place on 3rd.' })]]),
  run(2104, INBOX, 'Conference speaker invite', [[3 * HOUR, agent({ text: 'Declined politely: the dates clash with the launch.' })]]),
  run(2105, INBOX, 'Refund for order 2210', [[DAY + 2 * HOUR, agent({ text: 'Refunded the order and told the customer it takes 5 days.' })]]),
  run(2106, INBOX, 'Welcome aboard', [[9 * DAY, agent({ text: 'Sent a welcome note with the onboarding checklist.' })]]),
  run(2201, NOTES, 'Release 4.12', [
    [20 * HOUR + 2, agent({ text: 'Reading the merged pull requests since 4.11…' })],
    [20 * HOUR, error('The model provider returned an error.')],
  ]),
  run(2202, NOTES, 'Release 4.11', [[7 * DAY, agent({ text: 'The notes for 4.11 are on the changelog.' })]]),
  run(2203, NOTES, 'Release 4.10', [[2 * DAY, agent({ text: 'The notes for 4.10 are written. Keep them to publish.' })]], { proposedChangeWorkpieces: [8] }),
  run(2301, TICKETS, 'PLAT-2291: Login loops on Safari', [[1, agent({ text: 'Reading the ticket’s 14 comments…' })]], { activeAgent: WORKING }),
  run(2302, TICKETS, 'PLAT-2290: Export times out', [[12, agent({ text: 'Exports over 50 MB time out; the fix is to stream them.' })]]),
  run(2303, TICKETS, 'PLAT-2288: Dark mode contrast', [[5 * HOUR, agent({ text: 'Two buttons fall below 4.5:1 in dark mode.' })]]),
]

// What the workspace's apps asked, read and set up outside any chat, made so many minutes ago.
const asked = (minutes: number, entry: ActionLogEntry): ActionLogEntry => {
  const createdAt = ago(minutes)
  return { ...entry, chatId: undefined, createdAt, ...(entry.type === 'action' && entry.appliedAt ? { appliedAt: new Date(createdAt.getTime() + MINUTE) } : {}) } as ActionLogEntry
}
const logOf = (source: ReturnType<typeof action>) => source.actionLog!

// The connections the workspace's automations are bound to, and one only a chat was.
const CALENDAR_ID = 12
const SLACK_ID = 13
const GITHUB_ID = 15

const outside = (): ActionLogEntry[] => {
  return [
    // The calendar's automation asked this; nothing runs by itself through GitHub, so the other is anyone's.
    asked(3 * HOUR, { ...logOf(action({ title: 'Add “Design review” to Team calendar', resource: CALENDAR, creation: true })), gatekeeperId: CALENDAR_ID }),
    asked(40, { ...logOf(action({ title: 'Open an issue “Flaky export test”', resource: PR })), gatekeeperId: GITHUB_ID }),
    asked(DAY + 5 * HOUR, logOf(action({ title: 'Append “Ship the beta” to Launch checklist', resource: DRIVE, resolvedBy: GRACE, state: 'approved' }))),
    asked(5 * DAY, logOf(observation({ title: 'Team calendar', resource: CALENDAR }))),
  ]
}

/** Their actions numbered in the order they were made, as the server numbers them, so that the history pages back in time. */
function renumbered(chats: MockChat[], elsewhere: ActionLogEntry[]): NonNullable<Scenario['workspace']> {
  const logs = [...chats.flatMap(({ messages }) => messages.flatMap((message) => (message.type === 'action' && message.actionLog ? [message.actionLog] : []))), ...elsewhere]
  const ids = new Map(logs.toSorted((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((log, index) => [log, 20_000 + index]))
  return {
    chats: chats.map((each) => ({
      ...each,
      messages: each.messages.map((message) => {
        if (message.type !== 'action' || !message.actionLog) return message
        const id = ids.get(message.actionLog)!
        return { ...message, actionId: id, actionLog: { ...message.actionLog, id } }
      }),
    })),
    outside: elsewhere.map((log) => ({ ...log, id: ids.get(log)! })),
  }
}

/** What runs by itself in the workspace: a calendar that books a review for each meeting, and a weekly deploy note. */
const AUTOMATIONS: MockAutomation[] = [
  {
    gadget: { id: 61, title: 'Team calendar' },
    connections: [{ name: 'CALENDAR', target: CALENDAR_ID, resourceTitle: CALENDAR.title }],
    hooks: [{
      id: 501,
      gatekeeperId: CALENDAR_ID,
      resourceTitle: CALENDAR.title,
      description: { title: 'When a meeting is booked', description: 'Adds a design review the day before, for whoever is presenting.' },
      enabled: true,
    }],
  },
  {
    gadget: { id: 62, title: 'Deploy notes' },
    connections: [{ name: 'SLACK', target: SLACK_ID, resourceTitle: SLACK.title }],
    hooks: [{
      id: 502,
      gatekeeperId: 3,
      resourceTitle: 'Scheduled tasks',
      resourceUrl: 'scheduler://tasks',
      description: { title: 'Deploy notes every Friday', description: 'Posts the week’s deploys to **#eng-deploys**.' },
      enabled: true,
    }],
  },
]

/** A workspace's agents' runs alone, each with what it said, for a workspace whose gadgets start agents. */
export const agentRuns = () => renumbered(RUNS, [])

/**
 * A busy shared workspace, for its Chats tab: chats of the viewer's and three coworkers', waiting
 * on approvals and an answer, ready for review, unread, at work and long done; agents' runs
 * waiting, failed and at work; an ask made outside any chat; and two weeks of history.
 */
export const team: Scenario = {
  id: 'team',
  title: 'Launch team',
  description:
    'A busy workspace shared with three coworkers. Open it from the crumb: its Chats tab lists what needs action first (chats ' +
    'and agents’ runs waiting on a decision, a failed run), then what is ready for review, what is working, and the rest ' +
    'by when. Its Automations tab has what was asked outside a chat, by the automation that asked it, and its History tab ' +
    'two weeks of what was done.',
  history: history([user('What’s left before the launch?')]),
  script: turn(say(agent({ text: 'Two approvals and a review. They’re first on the workspace’s Chats tab.' }))),
  // Its agents' runs are among its chats, each with what it said.
  agents: { setups: EXAMPLE_AGENT_SETUPS, runs: [] },
  workspace: { ...renumbered([...CHATS, ...RUNS], outside()), automations: AUTOMATIONS },
}
