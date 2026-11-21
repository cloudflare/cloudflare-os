import type { ActionLogEntry, AiChatAuthorInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { ActionEntry } from '@/workspaces/activity/activityEntries'

/** A shared workspace's activity, for the gallery: Grace looks at it, and Ada and Alan work in it too. */
export const EXAMPLE_VIEWER: AiChatAuthorInfo = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' }
const ADA: AiChatAuthorInfo = { type: 'user', id: 'ada@example.com', name: 'Ada Lovelace' }
const ALAN: AiChatAuthorInfo = { type: 'user', id: 'alan@example.com', name: 'Alan Turing' }

const MINUTE = 60_000
const ago = (minutes: number) => new Date(Date.now() - minutes * MINUTE)

const chat = (id: number, title: string, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata => ({
  id,
  title,
  started: ago(minutes + 600),
  lastActive: ago(minutes),
  ...more,
})

export const EXAMPLE_CHATS: AiChatMetadata[] = [
  chat(1, 'Fix the login redirect', 14, { awaitingDecision: true }),
  chat(2, 'Q3 planning doc', 50),
  chat(3, 'Reply to Kenton about the offsite', 8, { spawnerId: 40, spawnerName: 'Inbox helper' }),
  chat(4, 'Sprint report', 95, { awaitingDecision: true }),
  chat(5, 'Tip jar polish', 130, { proposedChangeWorkpieces: [21, 22] }),
  chat(6, 'Digest of new tickets', 200, { spawnerId: 41, spawnerName: 'Ticket digest', proposedChangeWorkpieces: [23] }),
  chat(7, 'Customer interview notes', 25),
  chat(8, 'Offsite agenda', 300),
  chat(9, 'Data cleanup', 1, { activeAgent: { type: 'agent', id: 'claude', name: 'Claude' } }),
  chat(10, 'Weekly triage', 2, { spawnerId: 42, spawnerName: 'Triage', activeAgent: { type: 'agent', id: 'claude', name: 'Claude' } }),
  chat(11, 'Weekly changelog', 240, { spawnerId: 43, spawnerName: 'Release notes' }),
  chat(12, 'Pricing page copy', 60 * 26),
  chat(13, 'Onboarding email drafts', 60 * 50),
  chat(14, 'Reply to “Lunch on Friday?”', 40, { spawnerId: 40, spawnerName: 'Inbox helper' }),
  chat(15, 'Reply to “Welcome aboard”', 70, { spawnerId: 40, spawnerName: 'Inbox helper' }),
  chat(16, 'Reply to “Refund for order 2210”', 60 * 20, { spawnerId: 40, spawnerName: 'Inbox helper' }),
  chat(17, 'Board meeting prep', 60 * 3),
]

/** Who started each chat people had, and the start of each one's latest message. */
export const EXAMPLE_STARTERS = new Map<number, AiChatAuthorInfo>([
  [1, ADA], [2, EXAMPLE_VIEWER], [4, ALAN], [5, EXAMPLE_VIEWER], [7, ADA], [8, ALAN], [9, EXAMPLE_VIEWER], [12, ALAN], [13, ADA], [17, EXAMPLE_VIEWER],
])
const AGENT: AiChatAuthorInfo = { type: 'agent', id: 'claude', name: 'Claude' }
const said = (text: string, author = AGENT, minutes = 600) => ({ text, author, at: ago(minutes) })
export const EXAMPLE_LATEST = new Map([
  [1, said('I’ll open a pull request from fix/login-redirect into main.')],
  [2, said('The plan is written. Sharing it with finance waits on your approval.')],
  [3, said('Drafted a reply: March works, and the hike can move to Saturday.')],
  [4, said('I need access to Jira to read the sprint’s tickets.')],
  [5, said('Both are restyled. Have a look before you keep them.')],
  [6, said('Six new tickets this week, two of them about exports.')],
  [7, said('Uploaded the last two transcripts — can someone pull out the themes before Thursday?', ADA)],
  [8, said('Moved the hike to Saturday morning.', ALAN)],
  [9, said('Comparing 4,210 rows by email and company…')],
  [10, said('Sorting this week’s 31 new tickets…')],
  [11, said('Reading the merged pull requests since 4.11…')],
  [12, said('Shorter headings, and the long paragraph is now three bullets.')],
  [13, said('Here are three drafts, from warmest to shortest.')],
  [14, said('Replied that Friday works, and suggested the place on 3rd.')],
  [15, said('Sent a welcome note with the onboarding checklist.')],
  [16, said('Refunded the order and told the customer it takes 5 days.')],
  [17, said('Can you add the Q3 numbers to the deck?', EXAMPLE_VIEWER)],
])

/** What the chats that wait last asked: an action to approve, and a connection to make. */
export const EXAMPLE_ASKS = new Map([
  [1, said('Open a pull request from fix/login-redirect', AGENT, 14)],
  [4, said('Connect Jira · To read the sprint’s tickets.', AGENT, 95)],
])

const action = (
  id: number,
  chatId: number | undefined,
  minutes: number,
  title: string,
  resourceTitle: string,
  more: Partial<Omit<ActionEntry, 'description'>> & { description?: Partial<ActionEntry['description']> } = {},
): ActionEntry => {
  const { description, ...rest } = more
  return {
    id,
    type: 'action',
    from: 'agent',
    chatId,
    gatekeeperId: 5,
    resourceTitle,
    resourceUrl: 'https://example.com',
    createdAt: ago(minutes),
    state: 'pending',
    ...rest,
    description: { title, description: '', implementsRevert: false, autoApprovable: true, descriptionIsComplete: true, ...description },
  }
}

export const EXAMPLE_PENDING: ActionEntry[] = [
  action(101, 1, 14, 'Open a pull request', 'cloudflare/workshop', {
    description: {
      awaitDecision: true,
      description: 'Opens a pull request from `fix/login-redirect` into `main`.',
      fields: [{ label: 'Title', kind: 'inline', value: 'Send people back where they were after signing in' }, { label: 'Body', kind: 'text', value: 'The sign-in page now keeps the address it was opened at and returns to it.', syntax: 'markdown' }],
    },
  }),
  action(102, 1, 12, 'Post to #eng-deploys', 'Slack · Cloudflare', { description: { fields: [{ label: 'Message', kind: 'text', value: 'Login redirect fix is up for review.' }] } }),
  action(103, 2, 48, 'Share “Q3 plan” with finance@example.com', 'Google Drive', { description: { description: 'Gives **finance@example.com** permission to comment.' } }),
  action(104, 3, 8, 'Send an email to Kenton', 'Gmail · grace@example.com', { description: { fields: [{ label: 'Subject', kind: 'inline', value: 'Re: Offsite in March' }] } }),
  action(105, undefined, 180, 'Add “Design review” to Team calendar', 'Google Calendar', { creation: true }),
]

export const EXAMPLE_ASKERS = new Map<number, AiChatAuthorInfo>([[1, ADA], [2, EXAMPLE_VIEWER], [4, ALAN], [5, EXAMPLE_VIEWER], [7, ADA], [8, ALAN], [9, EXAMPLE_VIEWER], [12, ALAN], [13, ADA]])

export const EXAMPLE_FAILED = [{ chatId: 11, title: 'Weekly changelog', agent: 'Release notes', at: ago(240) }]

export const EXAMPLE_UNREAD = new Map([[7, 3], [8, 1]])
export const EXAMPLE_PREVIEWS = new Map([
  [7, { preview: 'Uploaded the last two transcripts — can someone pull out the themes before Thursday?', at: ago(25) }],
  [8, { preview: 'Moved the hike to Saturday morning.', at: ago(300) }],
])

export const EXAMPLE_TITLES = new Map([[21, 'Tip Jar'], [22, 'Launch deck'], [23, 'Ticket board']])

const decided = (entry: ActionEntry, state: 'approved' | 'rejected', by: AiChatAuthorInfo, minutes: number, autoApproved = false): ActionEntry =>
  ({ ...entry, state, resolvedBy: by, appliedAt: ago(minutes), ...(autoApproved ? { autoApproved: true } : {}) })

/** Everything that happened, newest first by id, a week of it. */
export const EXAMPLE_HISTORY: ActionLogEntry[] = [
  ...EXAMPLE_PENDING,
  decided(action(99, 7, 40, 'Create issue “Theme: onboarding is slow”', 'Linear · Research'), 'approved', ADA, 35),
  { id: 98, type: 'observation', from: 'agent', chatId: 7, resourceTitle: 'Interview transcripts', createdAt: ago(42), state: 'approved', description: { title: 'Interview transcripts', description: 'Read 6 files from the shared folder.' } },
  decided(action(97, 1, 70, 'Push 2 commits to fix/login-redirect', 'cloudflare/workshop'), 'approved', EXAMPLE_VIEWER, 69, true),
  decided(action(96, 8, 400, 'Book a table for 12', 'OpenTable'), 'rejected', ALAN, 380),
  { id: 95, type: 'bindHook', from: 'agent', resourceTitle: 'Every Monday at 9:00', createdAt: ago(60 * 26), state: 'approved', enabled: true, hookId: 3, description: { title: 'Ticket digest every Monday', description: 'Starts **Ticket digest** with the week’s new tickets.' } },
  decided(action(94, 2, 60 * 27, 'Create document “Q3 plan”', 'Google Drive'), 'approved', EXAMPLE_VIEWER, 60 * 27 - 3),
  { id: 93, type: 'observation', from: 'agent', chatId: 4, resourceTitle: 'Sprint 42', createdAt: ago(60 * 30), state: 'approved', description: { title: 'Sprint 42 board', description: '' } },
  decided(action(92, 6, 60 * 50, 'Comment on WEB-214', 'Jira · Web'), 'approved', ADA, 60 * 50, true),
  { id: 91, type: 'bindHook', from: 'agent', resourceTitle: 'When an email arrives', createdAt: ago(60 * 75), state: 'approved', enabled: false, hookId: 2, description: { title: 'Answer new email', description: '' } },
  decided(action(90, 3, 60 * 80, 'Send an email to the venue', 'Gmail · grace@example.com'), 'rejected', EXAMPLE_VIEWER, 60 * 79),
]
