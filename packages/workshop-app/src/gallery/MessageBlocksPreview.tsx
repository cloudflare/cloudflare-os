import type { ReactNode } from 'react'
import { AssistantMessage } from '@/blocks/AssistantMessage'
import { UserMessage } from '@/blocks/UserMessage'
import { useReport } from './previewState'
import { Section } from './Section'

const Column = ({ children }: { children: ReactNode }) => <div className="flex w-full flex-col gap-2">{children}</div>

const picture = new TextEncoder().encode(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#888"/><circle cx="4" cy="4" r="2.5" fill="#fff"/></svg>',
)

/** What people and the agent say, in every state. */
export const MessageBlocksPreview = () => {
  const { report, say } = useReport()

  return (
    <>
      <Section title="UserMessage (plain, mentions, slash command, attachments, another sender, not read yet)">
        <Column>
          <UserMessage parts={[{ type: 'text', text: 'Create a dashboard showcasing my Jira stats' }]} />
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
          <UserMessage parts={[{ type: 'text', text: 'I can take the export bug' }]} from="Grace Hopper" />
          <UserMessage parts={[{ type: 'text', text: 'Keep it under 100 words.' }]} unread />
        </Column>
      </Section>
      <Section title="AssistantMessage (plain, with Markdown)">
        <Column>
          <AssistantMessage text="I’ll build a personal Jira dashboard." />
          <AssistantMessage text={'The chart now covers **twelve weeks**:\n\n- the window is a constant in `chart.tsx`\n- the worker already returned twelve'} />
        </Column>
      </Section>
      <p role="status" className="text-sm text-kumo-subtle">{report}</p>
    </>
  )
}
