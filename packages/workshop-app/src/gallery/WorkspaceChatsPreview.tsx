import { useState } from 'react'
import { ActivityRow } from '@/blocks/ActivityRow'
import { ChatListItem } from '@/blocks/ChatListItem'
import { Button, ListGroup } from '@gadgets/ui'
import { chatTitle } from '@/workspaces/chatList'
import { ChatListView } from '@/workspaces/ChatListView'
import { chatStatesOf } from '@/workspaces/chatStates'
import { attentionOf, reviewsOf, workingOf } from '@/workspaces/activity/overview'
import { HistoryView } from '@/workspaces/activity/HistoryView'
import {
  EXAMPLE_ASKERS, EXAMPLE_ASKS, EXAMPLE_CHATS, EXAMPLE_FAILED, EXAMPLE_HISTORY, EXAMPLE_LATEST, EXAMPLE_PENDING, EXAMPLE_PREVIEWS, EXAMPLE_STARTERS, EXAMPLE_UNREAD, EXAMPLE_VIEWER,
} from './exampleActivity'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'

/**
 * A busy shared workspace's chats as its Chats tab lists them (`ChatListView`): two starred, what is
 * in progress, then the rest, an agent's runs only while they need you; then its rows on their own.
 */
export const WorkspaceChatsPreview = () => {
  const { report, say } = useReport()
  const [starred, setStarred] = useState<ReadonlySet<number>>(new Set([17, 12]))
  const attention = attentionOf({ chats: EXAMPLE_CHATS, pending: EXAMPLE_PENDING, actionChats: new Map(), askers: EXAMPLE_ASKERS })
  const states = chatStatesOf({
    attention,
    failed: EXAMPLE_FAILED,
    reviews: reviewsOf(EXAMPLE_CHATS),
    working: workingOf(EXAMPLE_CHATS),
  })

  return (
    <>
      <Section title="ChatListView (a workspace’s Chats tab: favorites first in any grouping; then grouped by status, most urgent first (approval, action, failed, review, unread, the rest; what is at work stays in place), by date or by owner, under headings, or not at all, each group in the order chosen; an agent’s runs only while they need you, the rest counted under the list, unless searched for or chosen under the filters’ Agent runs (Action needed, All, None); each by whom)">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <ChatListView
            status={{ status: 'ready' }}
            chats={EXAMPLE_CHATS}
            states={states}
            unreadOf={(id) => EXAMPLE_UNREAD.get(id) ?? 0}
            starters={EXAMPLE_STARTERS}
            latest={EXAMPLE_LATEST}
            asks={EXAMPLE_ASKS}
            previews={EXAMPLE_PREVIEWS}
            favorites={{
              has: (id) => starred.has(id),
              toggle: (id) => setStarred((before) => {
                const next = new Set(before)
                if (!next.delete(id)) next.add(id)
                return next
              }),
            }}
            viewerId={EXAMPLE_VIEWER.id}
            onOpenChat={({ title }) => say(`opened “${title}”`)}
            chatHref={() => '#'}
            onMarkRead={async () => say('marked all read')}
            onNewChat={() => say('started a new chat')}
          />
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="ChatListItem (each with its latest message, after who said it, and how it stands as a pill: waiting on approvals, with something unread too; on an answer; an agent’s run that failed; ready for review; at work; unread; an agent’s; starred; on one line)">
        <div className="flex w-full max-w-3xl flex-col">
          <ListGroup label="Rows">
            <ChatListItem title="Fix the login redirect" by={{ kind: 'person', name: 'Ada Lovelace' }} badge="waiting" unread={2} detail={{ words: 'I’ll open a pull request from fix/login-redirect into main.' }} status={{ words: 'Needs approval', tone: 'warning' }} time="14 min ago" onSelect={() => {}} />
            <ChatListItem title="Sprint report" by={{ kind: 'person', name: 'Alan Turing' }} badge="waiting" detail={{ words: 'I need access to Jira to read the sprint’s tickets.' }} status={{ words: 'Needs action', tone: 'warning' }} time="1 hour ago" onSelect={() => {}} />
            <ChatListItem title="Release 4.12" by={{ kind: 'agent', name: 'Release notes' }} badge="failed" detail={{ words: 'Reading the merged pull requests since 4.11…', speaker: 'Release notes' }} status={{ words: 'Run failed', tone: 'danger' }} time="4 hours ago" onSelect={() => {}} />
            <ChatListItem title="Tip jar polish" by={{ kind: 'person', name: 'Grace Hopper' }} detail={{ words: 'Both are restyled. Have a look before you keep them.' }} status={{ words: 'Ready for review', tone: 'info' }} time="2 hours ago" onSelect={() => {}} />
            <ChatListItem title="Data cleanup" by={{ kind: 'person', name: 'You', fullName: 'Grace Hopper' }} badge="working" detail={{ words: 'Working…', working: true }} time="1 min ago" onSelect={() => {}} />
            <ChatListItem title="Customer interview notes" by={{ kind: 'person', name: 'Ada Lovelace' }} unread={3} detail={{ words: 'Uploaded the last two transcripts — can someone pull out the themes before Thursday?', speaker: 'Ada Lovelace' }} time="25 min ago" onSelect={() => {}} />
            <ChatListItem title="Lunch on Friday?" by={{ kind: 'agent', name: 'Inbox helper' }} detail={{ words: 'Replied that Friday works, and suggested the place on 3rd.', speaker: 'Inbox helper' }} time="40 min ago" onSelect={() => {}} />
            <ChatListItem title="Board meeting prep" by={{ kind: 'person', name: 'Grace Hopper' }} detail={{ words: 'The deck has the Q3 numbers now.' }} favorite={{ on: true, onToggle: () => {} }} time="3 hours ago" onSelect={() => {}} />
            <ChatListItem title="Only one line" time="Oct 25" onSelect={() => {}} />
          </ListGroup>
        </div>
      </Section>
    </>
  )
}

/** A workspace's History tab, over a week of a shared workspace's activity, a page and then all of it; then its rows on their own. */
export const HistoryPreview = () => {
  const { report, say } = useReport()
  const { of } = useOpen()
  const [pages, setPages] = useState(1)
  const byId = new Map(EXAMPLE_CHATS.map((each) => [each.id, each]))
  return (
    <>
      <Section title="HistoryView (a workspace’s History tab: everything asked for, read and set up, a line each, under a search and filters, a page at a time)">
        <div className="flex w-full max-w-3xl flex-col gap-4">
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setPages(1)}>Reset</Button>
          </div>
          <HistoryView
            viewerId={EXAMPLE_VIEWER.id}
            history={{ entries: EXAMPLE_HISTORY.slice(0, pages === 1 ? 10 : undefined), read: true, reading: false, more: pages === 1 }}
            chatOf={(entry) => {
              const found = entry.chatId === undefined ? undefined : byId.get(entry.chatId)
              return found && { id: found.id, title: chatTitle(found) }
            }}
            onOpenChat={({ title }) => say(`opened “${title}”`)}
            chatHref={() => '#'}
            onLoadOlder={() => setPages(2)}
          />
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="ActivityRow, in each way an entry stands (waiting, approved by a person, auto-approved, denied, read, an automation), one opened">
        <div className="flex w-full max-w-3xl flex-col">
          <ListGroup label="History">
            <ActivityRow outcome="waiting" title="Open a pull request" status="Waiting" time="Just now" resource={{ title: 'cloudflare/workshop' }} chat="Fix the login redirect" description="" fields={[]} {...of('a')} />
            <ActivityRow outcome="approved" title="Create issue “Theme: onboarding is slow”" status="Approved by Ada Lovelace" time="25 min ago" resource={{ title: 'Linear · Research', url: 'https://example.com' }} chat="Customer interview notes" description="Creates an issue in **Research**." fields={[{ label: 'Labels', kind: 'list', items: ['research', 'onboarding'] }]} when="Asked Nov 20, 10:07 AM · approved Nov 20, 10:12 AM" links={<Button>Open chat</Button>} open onToggle={() => {}} />
            <ActivityRow outcome="auto" title="Push 2 commits to fix/login-redirect" status="Auto-approved by your rule" time="1 hour ago" resource={{ title: 'cloudflare/workshop' }} description="" fields={[]} {...of('c')} />
            <ActivityRow outcome="denied" title="Book a table for 12" status="Denied by Alan Turing" time="3 hours ago" resource={{ title: 'OpenTable' }} chat="Offsite agenda" description="" fields={[]} {...of('d')} />
            <ActivityRow outcome="read" title="Read Interview transcripts" status="Read" time="Yesterday" description="Read 6 files." fields={[]} {...of('e')} />
            <ActivityRow outcome="automation" title="Ticket digest every Monday" status="Automation on" time="Monday" resource={{ title: 'Every Monday at 9:00' }} description="" fields={[]} {...of('f')} />
          </ListGroup>
        </div>
      </Section>
    </>
  )
}
