import { useState } from 'react'
import { Switch, Tabs } from '@cloudflare/kumo'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { MessageBubble } from '@/blocks/MessageBubble'
import { WorkLog } from '@/blocks/WorkLog'
import { useOpen } from './previewState'
import { Section } from './Section'

const STATUSES = ['Thinking…', 'Running code…', 'Reading src/worker.ts…', 'Writing…', 'Compacting the conversation…']

/** The mascot coming and going between two messages, saying what it is doing, with and without the work behind it. */
export const AssistantPresencePreview = () => {
  const [working, setWorking] = useState(true)
  const [status, setStatus] = useState(STATUSES[0])
  const [details, setDetails] = useState(true)
  const { open, toggle, of } = useOpen()

  return (
    <Section title="AssistantPresence (appears while the assistant works and leaves when it is done; its status opens to the work so far)">
      <div className="flex w-full flex-col gap-3">
        <div className="flex flex-wrap items-center gap-4">
          <Switch label="Working" checked={working} onCheckedChange={setWorking} />
          <Switch label="Details" checked={details} onCheckedChange={setDetails} />
          <Tabs size="sm" value={status} onValueChange={setStatus} tabs={STATUSES.map((value) => ({ value, label: value }))} />
        </div>
        <div className="flex w-full flex-col gap-2">
          <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
          <AssistantPresence
            working={working}
            status={status}
            details={details
              ? {
                  ...of('work'),
                  content: (
                    <WorkLog
                      steps={[
                        { type: 'call', key: 'read', icon: 'file', label: 'Read src/worker.ts', sections: [] },
                        { type: 'call', key: 'run', icon: 'terminal', label: 'Running code…', running: true, sections: [{ label: 'Code', text: 'await env.JIRA.search("project = PLAT")' }] },
                      ]}
                      openSteps={open}
                      onToggleStep={toggle}
                    />
                  ),
                }
              : undefined}
          />
          <MessageBubble role="user">Make it dark</MessageBubble>
        </div>
      </div>
    </Section>
  )
}
