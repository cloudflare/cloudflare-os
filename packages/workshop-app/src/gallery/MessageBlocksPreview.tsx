import type { ReactNode } from 'react'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { messageInfo, thinkingOf } from '@/blocks/messageInfo'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { UserMessage } from '@/blocks/UserMessage'
import { answerParts } from '@/chat/answerParts'
import { PLANS_ANSWER } from '@/chat/mock/liveViews'
import { BUDGET_XLSX, Q3_PLAN_DOCX, ROADMAP_PPTX } from '@/chat/mock/officeFiles'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const picture = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/><circle cx="4" cy="4" r="2.5" fill="#fff"/></svg>',
)

const SENT = new Date(2026, 10, 2, 9, 41)

const COUNTER = '<inline-html>\n<title>Counter</title>\n<button id="add">Add one</button> <output id="count">0</output>\n<script type="module">\nlet count = 0\ndocument.getElementById("add").onclick = () => { document.getElementById("count").value = ++count }\n</script>\n</inline-html>'
const THROWS = 'It tried to count:\n\n<inline-html>\n<title>Tally</title>\n<p>Counting…</p>\n<script type="module">tally.add(1)</script>\n</inline-html>'
const EMPTY = 'Here it is:\n\n<inline-html>\n<title>Nothing</title>\n</inline-html>'
const UNCLOSED = 'A chart:\n\n<inline-html>\n<title>Weeks</title>\n<svg viewBox="0 0 10 10">'

const TRACE: ToolStepEntry[] = [
  { type: 'call', key: 'info-read', icon: 'file', label: 'Read src/chart.tsx', reasoning: 'The window is probably a constant.', sections: [] },
  { type: 'call', key: 'info-edit', icon: 'edit', label: 'Edited src/chart.tsx', sections: [{ label: 'Replaced', text: 'const WEEKS = 4' }, { label: 'With', text: 'const WEEKS = 12' }] },
  { type: 'thinking', key: 'info-thought', text: 'The worker already returns twelve weeks, so nothing else has to change.' },
]

/** What people and the agent say, in every state, and what there is to know about a message. */
export const MessageBlocksPreview = () => {
  const { report, say } = useReport()
  const { open, toggle, of } = useOpen(['details'])

  return (
    <>
      <Section title="UserMessage (plain, a long one cut short with more, a link as a pill of its site, a reply, a short reply to a long message, mentions, slash command, attachments, a Word document, deck and workbook drawn on their tiles once fetched, attachments alone, another sender, not read yet)">
        <Column>
          <UserMessage parts={[{ type: 'text', text: 'Create a dashboard showcasing my Jira stats' }]} onReply={() => say('reply')} />
          <UserMessage
            parts={[
              { type: 'text', text: 'Here are the notes from this morning’s planning session, can you turn them into a plan for the quarter? ' },
              { type: 'capsule', title: 'Q3 planning notes', url: 'https://docs.example.com/q3' },
              { type: 'text', text: ' We agreed that the onboarding flow comes first: new workspaces should be set up in under five minutes, which means the template picker has to load instantly and the first chat should already know what the workspace is for. After that, the agents page needs a proper empty state and a way to set one up without asking in a chat. Billing comes third: the usage page is confusing, people cannot tell what a run costs, and the credits warning arrives too late. We also talked about the mobile layout, which breaks below 400px on the settings pages, and about the export button, which half the team could not find. Finally, the support rota for launch week still has gaps on Thursday and Friday, and someone needs to own the status page while the release goes out.' },
            ]}
          />
          <UserMessage parts={[{ type: 'text', text: 'Compare https://www.cloudflare.com/plans/ with what we pay now.' }]} />
          <UserMessage parts={[{ type: 'text', text: 'Make it twenty-four, and keep the weekly split.' }]} quote="The chart now covers 12 weeks" />
          <UserMessage
            parts={[{ type: 'text', text: 'Yes' }]}
            quote="The chart now covers 12 weeks (148 tickets). One edit to src/worker.ts failed because the limit is named maxResults there; I left it alone since 50 per page is enough. Want me to raise it anyway?"
          />
          <UserMessage
            parts={[
              { type: 'text', text: 'Turn ' },
              { type: 'capsule', title: 'PLAT-212 Chart shows 4 weeks', url: 'https://jira.example.com/browse/PLAT-212', snippet: 'The dashboard’s ticket chart stops at four weeks, though the filter above it says twelve.' },
              { type: 'text', text: ' into a ' },
              { type: 'format', noun: 'Document', icon: 'fileText' },
              { type: 'text', text: ' and a ' },
              { type: 'format', noun: 'Spreadsheet', icon: 'gridNine' },
            ]}
          />
          <UserMessage
            parts={[{ type: 'command', name: 'release-notes' }, { type: 'text', text: ' for the dashboard, since Monday' }]}
            describe={(part) => (part.type === 'command' ? { description: 'Draft release notes from what was merged.', facts: ['Skill', 'Engineering'] } : undefined)}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'Here are the files' }]}
            attachments={[
              { id: 'image', name: 'chart.svg', mimeType: 'image/svg+xml', content: picture },
              { id: 'pdf', name: 'Project brief.pdf', mimeType: 'application/pdf' },
              { id: 'csv', name: 'Quarterly results with a long name.csv', mimeType: 'text/csv' },
            ]}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'The plan, the deck and the budget' }]}
            attachments={[
              { id: 'docx', name: 'Q3 plan.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' },
              { id: 'pptx', name: 'Roadmap.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation' },
              { id: 'xlsx', name: 'Budget.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' },
            ]}
            loadAttachment={(id) => (id === 'docx' ? Q3_PLAN_DOCX() : id === 'pptx' ? ROADMAP_PPTX() : BUDGET_XLSX())}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
          />
          <UserMessage
            parts={[]}
            attachments={[{ id: 'only', name: 'chart.svg', mimeType: 'image/svg+xml', content: picture }]}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
            onReply={() => say('reply')}
          />
          <UserMessage parts={[{ type: 'text', text: 'I can take the export bug' }]} from="Grace Hopper" />
          <UserMessage parts={[{ type: 'text', text: 'Keep it under 100 words.' }]} unread />
        </Column>
      </Section>
      <Section title="Message details (a click on the message shows a bubble under it of what there is to know about it, folding to their first line before they leave: a reply that took no steps, one with steps to open, one's own message, another person's, one not read yet; a click or the chevron puts them away; the brain button on a reply that took steps shows them above it, apart from the details)">
        <Column>
          <AssistantMessage
            text="I’ll build a personal Jira dashboard."
            details={{ ...of('no-trace'), ...messageInfo({ sender: 'Mock Model Fast', sentAt: SENT, reply: true }) }}
          />
          <AssistantMessage
            text={'The chart now covers **twelve weeks**:\n\n- the window is a constant in `chart.tsx`\n- the worker already returned twelve'}
            details={{ ...of('details'), ...messageInfo({ sender: 'Mock Model', sentAt: SENT, reply: true }) }}
            thinking={{ ...of('thinking'), content: thinkingOf({ steps: TRACE, toggledSteps: open, onToggleStep: toggle }) }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'Make it dark' }]}
            details={{ ...of('mine'), ...messageInfo({ sentAt: SENT }) }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'I can take the export bug' }]}
            from="Grace Hopper"
            details={{ ...of('theirs'), ...messageInfo({ sender: 'Grace Hopper', sentAt: SENT }) }}
          />
          <UserMessage
            parts={[{ type: 'text', text: 'Keep it under 100 words.' }]}
            unread
            details={{ ...of('unread'), ...messageInfo({}) }}
          />
        </Column>
      </Section>
      <Section title="AssistantMessage with live views (prose around a view: choose a plan, then Send or Dismiss what it suggests; a view alone; one whose code throws; one with nothing in it; one the agent never closed, shown as code; Stop and Run under each)">
        <Column>
          <AssistantMessage
            text={PLANS_ANSWER}
            parts={answerParts(PLANS_ANSWER)}
            onReply={() => say('reply')}
            onSendSuggestion={async (message) => {
              say(`send: ${message}`)
              return true
            }}
          />
          <AssistantMessage text={COUNTER} parts={answerParts(COUNTER)} onReply={() => say('reply')} />
          <AssistantMessage text={THROWS} parts={answerParts(THROWS)} />
          <AssistantMessage text={EMPTY} parts={answerParts(EMPTY)} />
          <AssistantMessage text={UNCLOSED} parts={answerParts(UNCLOSED)} />
        </Column>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
