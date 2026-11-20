import { useState } from 'react'
import { ChatListItem } from '@/blocks/ChatListItem'
import { ChatStart } from '@/blocks/ChatStart'
import { ComposerStatusLine } from '@/blocks/ComposerStatusLine'
import { DeveloperIds } from '@/blocks/DeveloperIds'
import { messageInfo } from '@/blocks/messageInfo'
import { WorkspaceCost } from '@/blocks/WorkspaceCost'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Markdown, Select } from '@gadgets/ui'
import { useOpen } from './previewState'
import { Section } from './Section'

const MODELS = [
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'kimi', label: 'Kimi K2.7 Code (Workers AI) with a name long enough to be cut' },
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna' },
]
const SIZES = [{ id: '', label: '200K (model default)' }, { id: '128000', label: '128K' }, { id: '64000', label: '64K' }, { id: '32000', label: '32K' }]

/** The line under the composer in developer mode, with the model and the context size changed in place. */
const StatusLineDemo = ({ own, bare, problem }: { own?: boolean; bare?: boolean; problem?: string }) => {
  const [model, setModel] = useState(MODELS[0].id)
  const [size, setSize] = useState('')
  return (
    <div className="w-[34rem] max-w-full rounded-3xl bg-kumo-tint p-2">
      <ComposerStatusLine
        model={bare ? undefined : { value: model, options: MODELS, onChange: setModel }}
        context={{
          measured: bare ? undefined : { tokens: 83_312, budget: 168_000, model: 'Claude Sonnet 5.5' },
          compactsAt: 0.85,
          cacheRead: bare ? undefined : 410_000,
          cacheWrite: bare ? undefined : 52_000,
          sizes: own ? { value: size, options: SIZES, onChange: setSize } : undefined,
        }}
        cost={bare ? undefined : 0.04123}
        problem={problem}
      />
    </div>
  )
}

const REPLY = messageInfo({ sender: 'Claude Sonnet 5.5', sentAt: new Date(2026, 10, 12, 15, 30), workedFor: 125_000 })

/** A new chat with the model chosen before the send button, as developer mode has it. */
const StartDemo = () => {
  const [model, setModel] = useState(MODELS[1].id)
  return (
    <div className="flex h-96 w-[34rem] max-w-full flex-col rounded-3xl bg-kumo-tint">
      <ChatStart
        greeting="Hello Ada, what should we do today?"
        onSend={async () => true}
        endSlot={<span className="flex max-w-40 min-w-0 max-sm:max-w-28"><Select aria-label="Model" value={model} options={MODELS} onValueChange={setModel} compact={{ align: 'end', medium: true }} /></span>}
      />
    </div>
  )
}

/** What developer mode shows: the line under the composer, a workspace's cost, chats' costs, and a message's details. */
export const DeveloperPreview = () => {
  const open = useOpen()
  return (
    <>
      <Section title="ComposerStatusLine (the model, changed in place, and what the context holds and the chat cost; with a size of its own it can be changed, as for a model of yours; nothing measured yet; and a change that was refused)">
        <StatusLineDemo />
        <StatusLineDemo own />
        <StatusLineDemo bare />
        <StatusLineDemo problem="Couldn’t change the model: the workspace couldn’t be reached." />
      </Section>
      <Section title="ChatStart with the model before the send button (the message makes room for it)">
        <StartDemo />
      </Section>
      <Section title="WorkspaceCost (in a workspace’s header; exact when pointed at), and ChatListItem with what the chat cost">
        <WorkspaceCost cost={12.3456} />
        <WorkspaceCost cost={0.004} />
        <WorkspaceCost cost={0} />
        <div className="flex w-96 max-w-full flex-col rounded-3xl bg-kumo-tint p-1.5">
          <ChatListItem title="Jira dashboard" time="4 hours ago" cost={0.0412} onSelect={() => {}} />
          <ChatListItem title="Morning brief" time="Oct 26" waiting cost={1.5} onSelect={() => {}} />
        </div>
      </Section>
      <Section title="DeveloperIds (on a chat’s, a workspace’s and a gadget’s settings: each ID copies when pressed)">
        <div className="flex w-[34rem] max-w-full flex-col gap-4">
          <DeveloperIds ids={[{ title: 'Chat ID', value: '2' }, { title: 'Workspace ID', value: 'kT3x9VqLm2Zr8WbN4aYp7Q' }, { title: 'Commit', value: '4f9c2a1e8b7d6035c1a9e2f4b8d7c6a5e3f1b2c4' }]} />
        </div>
      </Section>
      <Section title="Message details with developer mode (how long it took), and its more menu with Copy message ID and Copy raw JSON">
        <div className="w-96 max-w-full">
          <MessageBubble role="assistant" copyText="Found it: the window is a constant." developerCopies={{ id: '14', json: () => '{ "sequence": 14 }' }} details={{ ...open.of('reply'), ...REPLY }}>
            <Markdown>Found it: the window is a constant.</Markdown>
          </MessageBubble>
        </div>
      </Section>
    </>
  )
}
