import { useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import { AssistantPresence } from '@/blocks/AssistantPresence'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Section } from './Section'

/** The mascot coming and going between two messages, with and without a label. */
export const AssistantPresencePreview = () => {
  const [working, setWorking] = useState(true)
  const [label, setLabel] = useState(true)

  return (
    <Section title="AssistantPresence (appears while the assistant works, and leaves when it is done)">
      <div className="flex w-full flex-col gap-3">
        <div className="flex gap-4">
          <Switch label="Working" checked={working} onCheckedChange={setWorking} />
          <Switch label="Label" checked={label} onCheckedChange={setLabel} />
        </div>
        <div className="flex w-full flex-col gap-2">
          <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
          <AssistantPresence working={working}>{label ? 'Thinking…' : undefined}</AssistantPresence>
          <MessageBubble role="user">Make it dark</MessageBubble>
        </div>
      </div>
    </Section>
  )
}
