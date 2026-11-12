import type { ReactNode } from 'react'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { messageInfo } from '@/blocks/messageInfo'
import type { ToolStepEntry } from '@/blocks/ToolStep'
import { UserMessage } from '@/blocks/UserMessage'
import { useOpen, useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const picture = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/><circle cx="4" cy="4" r="2.5" fill="#fff"/></svg>',
)

const SENT = new Date(2026, 10, 2, 9, 41)

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
      <Section title="UserMessage (plain, a reply, a short reply to a long message, mentions, slash command, attachments, attachments alone, another sender, not read yet)">
        <Column>
          <UserMessage parts={[{ type: 'text', text: 'Create a dashboard showcasing my Jira stats' }]} onReply={() => say('reply')} />
          <UserMessage parts={[{ type: 'text', text: 'Make it twenty-four, and keep the weekly split.' }]} quote="The chart now covers 12 weeks" />
          <UserMessage
            parts={[{ type: 'text', text: 'Yes' }]}
            quote="The chart now covers 12 weeks (148 tickets). One edit to src/worker.ts failed because the limit is named maxResults there; I left it alone since 50 per page is enough. Want me to raise it anyway?"
          />
          <UserMessage
            parts={[
              { type: 'text', text: 'Turn ' },
              { type: 'capsule', title: 'PLAT-212 Chart shows 4 weeks', url: 'https://jira.example.com/browse/PLAT-212' },
              { type: 'text', text: ' into a ' },
              { type: 'format', noun: 'Document', icon: 'fileText' },
              { type: 'text', text: ' and a ' },
              { type: 'format', noun: 'Spreadsheet', icon: 'gridNine' },
            ]}
          />
          <UserMessage parts={[{ type: 'command', name: 'release-notes' }, { type: 'text', text: ' for the dashboard, since Monday' }]} />
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
            parts={[]}
            attachments={[{ id: 'only', name: 'chart.svg', mimeType: 'image/svg+xml', content: picture }]}
            onOpenAttachment={(id) => say(`open attachment ${id}`)}
            onReply={() => say('reply')}
          />
          <UserMessage parts={[{ type: 'text', text: 'I can take the export bug' }]} from="Grace Hopper" />
          <UserMessage parts={[{ type: 'text', text: 'Keep it under 100 words.' }]} unread />
        </Column>
      </Section>
      <Section title="Message details (a bubble of their own under the message, as wide as what is in them, folding to their first line before they leave: a reply that took no steps, one with steps to open, one's own message, another person's, one not read yet; Details or the chevron puts them away)">
        <Column>
          <AssistantMessage
            text="I’ll build a personal Jira dashboard."
            details={{ ...of('no-trace'), ...messageInfo({ sender: 'Mock Model Fast', sentAt: SENT, trace: { steps: [], openSteps: open, onToggleStep: toggle } }) }}
          />
          <AssistantMessage
            text={'The chart now covers **twelve weeks**:\n\n- the window is a constant in `chart.tsx`\n- the worker already returned twelve'}
            details={{ ...of('details'), ...messageInfo({ sender: 'Mock Model', sentAt: SENT, trace: { steps: TRACE, openSteps: open, onToggleStep: toggle } }) }}
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
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
