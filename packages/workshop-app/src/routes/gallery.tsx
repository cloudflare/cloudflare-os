import { useState, type ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Checkbox, Input, Switch, Tabs } from '@cloudflare/kumo'
import { CaretLeftIcon, CirclesFourIcon, FileTextIcon, MagnifyingGlassIcon, PlusIcon, PresentationIcon, TableIcon } from '@phosphor-icons/react'
import { Composer } from '@/blocks/Composer'
import type { ComposerAddActions, ComposerSkill } from '@/blocks/ComposerAddMenu'
import { ConversationListItem } from '@/blocks/ConversationListItem'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Sidebar, type SidebarConversation } from '@/blocks/Sidebar'
import { ThinkingIndicator } from '@/blocks/ThinkingIndicator'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { DropdownMenu, type DropdownMenuProps } from '@/components/DropdownMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { ChatLayout } from '@/layouts/ChatLayout'

export const Route = createFileRoute('/gallery')({
  component: Gallery,
})

const Section = ({ title, children }: { title: string; children: ReactNode }) => (
  <section className="flex flex-col gap-3">
    <h2 className="text-sm font-medium text-kumo-subtle">{title}</h2>
    <div className="flex flex-wrap items-center gap-2">{children}</div>
  </section>
)

const previewSkills: ComposerSkill[] = [
  { id: 'review', name: 'Review writing', description: 'Polish a draft and make it clearer.', source: 'Writing tools' },
  { id: 'summarize', name: 'Summarize', description: 'Turn a long document into the key takeaways.', source: 'Documents' },
  { id: 'compact', name: 'Compact chat', description: 'Make room while keeping the important context.', source: 'Gadgets' },
]

const previewConversations: SidebarConversation[] = [
  { id: 'greeting', workspaceLabel: 'CG', title: 'Casual Greeting', subtitle: '4 hours ago' },
  { id: 'assistant', workspaceLabel: 'AA', title: 'Assistant Availability Check', subtitle: 'Oct 28' },
  { id: 'untitled', workspaceLabel: 'UW', title: 'Untitled Workspace' },
  { id: 'dashboard', workspaceLabel: 'JD', title: 'Jira dashboard', subtitle: 'Oct 27', unread: true },
  { id: 'slides', workspaceLabel: 'PS', title: 'Presentation slides', subtitle: 'Oct 26' },
]

const NewItems = ({ onSelect }: { onSelect: (item: string) => void }) => (
  <>
    <DropdownMenu.Item icon={FileTextIcon} onSelect={() => onSelect('Document')}>Document</DropdownMenu.Item>
    <DropdownMenu.Item icon={TableIcon} onSelect={() => onSelect('Spreadsheet')}>Spreadsheet</DropdownMenu.Item>
    <DropdownMenu.Item icon={PresentationIcon} onSelect={() => onSelect('Presentation')}>Presentation</DropdownMenu.Item>
  </>
)

type Side = NonNullable<DropdownMenuProps['side']>
type Align = NonNullable<DropdownMenuProps['align']>
type TriggerKind = 'icon' | 'icon-text' | 'text'

const SIDES: Side[] = ['top', 'right', 'bottom', 'left']
const ALIGNS: Align[] = ['start', 'center', 'end']
const TRIGGERS: { value: TriggerKind; label: string }[] = [
  { value: 'icon', label: 'Icon' },
  { value: 'icon-text', label: 'Icon + text' },
  { value: 'text', label: 'Text' },
]

// The default, plus faster and slow-motion presets for reviewing the morph frame by frame.
const DURATIONS = [280, 360, 420, 840, 1680]

const triggerContent = (kind: TriggerKind) =>
  kind === 'icon'
    ? ({ icon: PlusIcon, 'aria-label': 'New' } as const)
    : kind === 'icon-text'
      ? ({ icon: PlusIcon, label: 'New' } as const)
      : ({ label: 'Create' } as const)

/** One trigger with toggles for every placement, so each opening direction can be reviewed. */
const DropdownMenuPlayground = () => {
  const [side, setSide] = useState<Side>('bottom')
  const [align, setAlign] = useState<Align>('start')
  const [trigger, setTrigger] = useState<TriggerKind>('icon-text')
  const [inPlace, setInPlace] = useState(false)
  const [duration, setDuration] = useState(360)
  const [action, setAction] = useState('Open the menu to preview the morph.')

  return (
    <div className="flex w-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <Tabs size="sm" value={side} onValueChange={(value) => setSide(value as Side)} tabs={SIDES.map((value) => ({ value, label: value }))} />
        <Tabs size="sm" value={align} onValueChange={(value) => setAlign(value as Align)} tabs={ALIGNS.map((value) => ({ value, label: value }))} />
        <Tabs size="sm" value={trigger} onValueChange={(value) => setTrigger(value as TriggerKind)} tabs={TRIGGERS} />
        <Tabs
          size="sm"
          value={String(duration)}
          onValueChange={(value) => setDuration(Number(value))}
          tabs={DURATIONS.map((value) => ({ value: String(value), label: `${value}ms` }))}
        />
        <Switch label="In place" checked={inPlace} onCheckedChange={setInPlace} />
      </div>
      {/* Room on every side, so the chosen placement is not flipped by collision handling. */}
      <div className="grid h-[28rem] place-items-center rounded-3xl ring-1 ring-kumo-line">
        <DropdownMenu
          // Remount on change so an open menu never straddles two placements.
          key={`${side}-${align}-${trigger}-${inPlace}`}
          {...triggerContent(trigger)}
          side={side}
          align={align}
          inPlace={inPlace}
          duration={duration}
        >
          <NewItems onSelect={(item) => setAction(`Preview: new ${item.toLowerCase()} selected.`)} />
        </DropdownMenu>
      </div>
      <p role="status" className="text-sm text-kumo-subtle">{action}</p>
    </div>
  )
}

function Gallery() {
  const [selectedConversation, setSelectedConversation] = useState('greeting')
  const [menuAction, setMenuAction] = useState('Open + to preview files, connections, and skills.')
  const addActions: ComposerAddActions = {
    onUpload: () => setMenuAction('Preview: upload files or photos selected.'),
    onAddConnection: () => setMenuAction('Preview: add a new connection selected.'),
    skills: { items: previewSkills, onSelect: (skill) => setMenuAction(`Preview: ${skill.name} selected.`) },
  }

  return (
    <div className="mx-auto flex h-full max-w-3xl flex-col gap-8 overflow-y-auto p-8">
      <h1 className="text-xl font-medium">Components</h1>
      <Section title="Button">
        <Button>Refactor conditional rendering logic</Button>
        <Button icon={CaretLeftIcon}>Back to chat</Button>
        <Button icon={CirclesFourIcon} aria-label="Apps" />
        <Button disabled>Disabled</Button>
        <Button icon={MagnifyingGlassIcon} aria-label="Search" />
      </Section>
      <Section title="DropdownMenu (side, align, trigger and in-place toggles)">
        <DropdownMenuPlayground />
      </Section>
      <Section title="Avatar">
        <Avatar name="Balint" />
        <Avatar name="Ada Lovelace" />
        <Avatar name="Broken image" src="/missing.png" />
      </Section>
      <Section title="ConnectButton">
        <ConnectButton>
          <span className="size-5 rounded-full bg-kumo-fill" />
          <span className="size-5 rounded-full bg-kumo-fill" />
        </ConnectButton>
        <ConnectButton />
      </Section>
      <Section title="WorkspaceIcon">
        <WorkspaceIcon label="EN" />
        <WorkspaceIcon label="DE" />
        <WorkspaceIcon label="FR" />
      </Section>
      <Section title="ConversationListItem (selected + unread, plain, long text)">
        <div className="flex w-80 flex-col">
          <ConversationListItem
            workspaceLabel="EN"
            title="Refactor conditional rendering logic"
            subtitle="I see what you’re aiming for…"
            unread
            selected
            onSelect={() => {}}
          />
          <ConversationListItem
            workspaceLabel="DE"
            title="Short title"
            subtitle="Yesterday"
            onSelect={() => {}}
          />
          <ConversationListItem
            workspaceLabel="FR"
            title="Create a new slideshow about the history of Paris"
            subtitle="Here’s your new slideshow with twelve slides…"
            onSelect={() => {}}
          />
          <ConversationListItem workspaceLabel="UW" title="Title only, no subtitle" onSelect={() => {}} />
        </div>
      </Section>
      <Section title="Sidebar (approach a neighbour from the active row or a distant row)">
        <div className="flex h-96 w-80 max-w-full rounded-3xl bg-kumo-base p-2">
          <Sidebar
            user={{ name: 'Ada Lovelace' }}
            conversations={previewConversations}
            selectedConversationId={selectedConversation}
            onSelectConversation={setSelectedConversation}
          />
        </div>
      </Section>
      <Section title="MessageBubble, ThinkingIndicator">
        <div className="flex w-full flex-col gap-2">
          <MessageBubble role="user">Create a dashboard showcasing my jira stats</MessageBubble>
          <MessageBubble role="user">Make it dark</MessageBubble>
          <MessageBubble role="user">And add a chart of open tickets per week, with the team split out</MessageBubble>
          <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
          <MessageBubble role="assistant">Missing implementation</MessageBubble>
          <MessageBubble role="error">Something went wrong</MessageBubble>
          <ThinkingIndicator />
        </div>
      </Section>
      <Section title="Composer">
        <div className="flex w-full flex-col gap-3">
          <p className="text-sm text-kumo-subtle">
            Starts inline, lifts above the action buttons when text wraps, and scrolls once it reaches its maximum height.
            Enter sends; Shift+Enter adds a line. The + menu morphs from its button; Escape closes it.
          </p>
          <Composer onSend={() => {}} addActions={addActions} />
          <p role="status" className="text-sm text-kumo-subtle">{menuAction}</p>
          <div className="w-80 max-w-full">
            <Composer onSend={() => {}} />
          </div>
        </div>
      </Section>
      <Section title="Composer (in-place add menu)">
        <div className="flex w-full flex-col gap-3">
          <p className="text-sm text-kumo-subtle">
            The + expands in place, keeping its anchored corner at the button while following the same curved path.
          </p>
          <Composer onSend={() => {}} addActions={addActions} addMenuInPlace />
        </div>
      </Section>
      <Section title="ChatLayout (header and composer float over the scrolling messages)">
        <div className="flex h-96 w-full flex-col overflow-hidden rounded-3xl bg-kumo-base ring-1 ring-kumo-line">
          <ChatLayout header={<Button>Refactor conditional rendering logic</Button>} composer={<Composer onSend={() => {}} addActions={addActions} />}>
            {Array.from({ length: 12 }, (_, i) => (
              <MessageBubble key={i} role={i % 2 ? 'assistant' : 'user'}>
                {i % 2 ? 'I’ll build a personal Jira dashboard with your stats.' : 'Create a dashboard showcasing my jira stats'}
              </MessageBubble>
            ))}
          </ChatLayout>
        </div>
      </Section>
      <Section title="Borders: line (input) and hairline (checkbox)">
        <Input aria-label="Text input" placeholder="Input" />
        <Checkbox label="Checkbox" />
      </Section>
    </div>
  )
}
