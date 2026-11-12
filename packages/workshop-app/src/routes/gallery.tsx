import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { Checkbox, Input, Switch, Tabs } from '@cloudflare/kumo'
import { CaretLeftIcon, CirclesFourIcon, FileTextIcon, MagnifyingGlassIcon, PlusIcon, PresentationIcon, TableIcon } from '@phosphor-icons/react'
import { Composer } from '@/blocks/Composer'
import type { ComposerSkill } from '@/blocks/ComposerAddMenu'
import { ComposerAttachmentTray } from '@/blocks/ComposerAttachmentTray'
import { ChatListItem } from '@/blocks/ChatListItem'
import type { ComposerAttachment } from '@/blocks/useComposerAttachments'
import { WorkspaceListItem } from '@/blocks/WorkspaceListItem'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Sidebar, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Avatar } from '@/components/Avatar'
import { Button } from '@/components/Button'
import { ConnectButton } from '@/components/ConnectButton'
import { DropdownMenu, type DropdownMenuProps } from '@/components/DropdownMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { AssistantPresencePreview } from '@/gallery/AssistantPresencePreview'
import { CardBlocksPreview } from '@/gallery/CardBlocksPreview'
import { HeaderPreview } from '@/gallery/HeaderPreview'
import { MascotPreview } from '@/gallery/MascotPreview'
import { MessageBlocksPreview } from '@/gallery/MessageBlocksPreview'
import { MessageListPreview } from '@/gallery/MessageListPreview'
import { Section } from '@/gallery/Section'
import { ShellPreview } from '@/gallery/ShellPreview'
import { SystemBlocksPreview } from '@/gallery/SystemBlocksPreview'
import { ToolBlocksPreview } from '@/gallery/ToolBlocksPreview'

export const Route = createFileRoute('/gallery')({
  component: () => (
    <div className="h-full overflow-y-auto">
      <Gallery />
    </div>
  ),
})

const previewSkills: ComposerSkill[] = [
  { id: 'review', name: 'Review writing', description: 'Polish a draft and make it clearer.', source: 'Writing tools' },
  { id: 'summarize', name: 'Summarize', description: 'Turn a long document into the key takeaways.', source: 'Documents' },
  { id: 'compact', name: 'Compact chat', description: 'Make room while keeping the important context.', source: 'Gadgets' },
]

const previewWorkspaces: SidebarWorkspace[] = [
  { id: 'greeting', workspaceLabel: 'CG', title: 'Casual Greeting', subtitle: '4 hours ago' },
  { id: 'assistant', workspaceLabel: 'AA', title: 'Assistant Availability Check', subtitle: 'Oct 28' },
  { id: 'untitled', workspaceLabel: 'UW', title: 'Untitled Workspace' },
  { id: 'dashboard', workspaceLabel: 'JD', title: 'Jira dashboard', subtitle: 'Oct 27', unread: true },
  { id: 'slides', workspaceLabel: 'PS', title: 'Presentation slides', subtitle: 'Oct 26' },
]

const AttachmentPreview = () => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => [
    { id: 'image', file: new File([], 'Cloudflare.svg', { type: 'image/svg+xml' }), previewUrl: '/favicon.svg' },
    { id: 'pdf', file: new File([], 'Project brief.pdf', { type: 'application/pdf' }) },
    { id: 'csv', file: new File([], 'Quarterly results.csv', { type: 'text/csv' }) },
    { id: 'code', file: new File([], 'dashboard.tsx') },
    { id: 'long', file: new File([], 'Notes with a longer filename to check wrapping.md') },
  ])

  return (
    <div className="w-full overflow-hidden rounded-[21px] bg-kumo-canvas ring-1 ring-kumo-line">
      <ComposerAttachmentTray attachments={attachments} onRemove={(id) => setAttachments((items) => items.filter((item) => item.id !== id))} />
    </div>
  )
}

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
  const [keepTrigger, setKeepTrigger] = useState(false)
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
        <Switch label="Keep trigger" checked={keepTrigger} disabled={inPlace} onCheckedChange={setKeepTrigger} />
      </div>
      {/* Room on every side, so the chosen placement is not flipped by collision handling. */}
      <div className="grid h-[28rem] place-items-center rounded-3xl ring-1 ring-kumo-line">
        <DropdownMenu
          // Remount on change so an open menu never straddles two placements.
          key={`${side}-${align}-${trigger}-${inPlace}-${keepTrigger}`}
          {...triggerContent(trigger)}
          side={side}
          align={align}
          inPlace={inPlace}
          keepTrigger={keepTrigger}
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
  const [selectedWorkspace, setSelectedWorkspace] = useState('greeting')
  const [menuAction, setMenuAction] = useState('Open + to preview files, connections, and skills.')
  const addActions = {
    onAddConnection: () => setMenuAction('Preview: add a new connection selected.'),
    skills: { items: previewSkills, onSelect: (skill: ComposerSkill) => setMenuAction(`Preview: ${skill.name} selected.`) },
  }
  const previewSend = (text: string, files: File[]) => setMenuAction(
    `Preview: sent ${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}${text ? ` with “${text}”` : ''}.`,
  )
  const [replying, setReplying] = useState(true)

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-8 p-8">
      <h1 className="text-xl font-medium">Components</h1>
      <Section title="Button">
        <Button>Refactor conditional rendering logic</Button>
        <Button icon={CaretLeftIcon}>Back to chat</Button>
        <Button icon={CirclesFourIcon} aria-label="Apps" />
        <Button disabled>Disabled</Button>
        <Button icon={MagnifyingGlassIcon} aria-label="Search" />
        <Button variant="ghost">Ghost</Button>
        <Button variant="primary">Primary</Button>
      </Section>
      <Section title="DropdownMenu (side, align, trigger, in-place and keep-trigger toggles)">
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
      <Section title="WorkspaceIcon (and small, as in a button)">
        <WorkspaceIcon label="EN" />
        <WorkspaceIcon label="DE" />
        <WorkspaceIcon label="FR" />
        <WorkspaceIcon label="EN" small />
        <WorkspaceIcon label="MW" small />
      </Section>
      <Section title="WorkspaceListItem (selected + unread, plain, long text)">
        <div className="flex w-80 flex-col">
          <WorkspaceListItem
            workspaceLabel="EN"
            title="Refactor conditional rendering logic"
            subtitle="I see what you’re aiming for…"
            unread
            selected
            onSelect={() => {}}
          />
          <WorkspaceListItem
            workspaceLabel="DE"
            title="Short title"
            subtitle="Yesterday"
            onSelect={() => {}}
          />
          <WorkspaceListItem
            workspaceLabel="FR"
            title="Create a new slideshow about the history of Paris"
            subtitle="Here’s your new slideshow with twelve slides…"
            onSelect={() => {}}
          />
          <WorkspaceListItem workspaceLabel="UW" title="Title only, no subtitle" onSelect={() => {}} />
        </div>
      </Section>
      <Section title="ChatListItem (with activity, long title, title only)">
        <div className="flex w-80 flex-col">
          <ChatListItem title="Jira dashboard" subtitle="4 hours ago" onSelect={() => {}} />
          <ChatListItem title="Create a new slideshow about the history of Paris" subtitle="Oct 27" onSelect={() => {}} />
          <ChatListItem title="Title only, no subtitle" onSelect={() => {}} />
        </div>
      </Section>
      <HeaderPreview />
      <ShellPreview />
      <Section title="Sidebar (approach a neighbour from the active row or a distant row)">
        <div className="flex h-96 w-80 max-w-full rounded-3xl bg-kumo-base p-2">
          <Sidebar
            user={{ name: 'Ada Lovelace' }}
            workspaces={previewWorkspaces}
            selectedWorkspaceId={selectedWorkspace}
            onSelectWorkspace={setSelectedWorkspace}
          />
        </div>
      </Section>
      <MascotPreview />
      <AssistantPresencePreview />
      <Section title="MessageBubble, MessageActions (a run of messages tucks together; point at a message, or tab to it, for its actions)">
        <div className="flex w-full flex-col gap-2">
          <MessageBubble role="user">Create a dashboard showcasing my jira stats</MessageBubble>
          <MessageBubble role="user">Make it dark</MessageBubble>
          <MessageBubble role="user">And add a chart of open tickets per week, with the team split out</MessageBubble>
          <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
          <MessageBubble role="error">Something went wrong</MessageBubble>
        </div>
      </Section>
      <MessageBlocksPreview />
      <ToolBlocksPreview />
      <CardBlocksPreview />
      <SystemBlocksPreview />
      <Section title="Composer">
        <div className="flex w-full flex-col gap-3">
          <p className="text-sm text-kumo-subtle">
            Starts inline, lifts above the action buttons when text wraps, and scrolls once it reaches its maximum height.
            Enter sends; Shift+Enter adds a line. The + menu morphs from its button; Escape closes it.
            Pick, paste, or drop files to preview local attachments. Dragging over the composer uses its focus highlight.
          </p>
          <Composer onSend={previewSend} addActions={addActions} />
          <p role="status" className="text-sm text-kumo-subtle">{menuAction}</p>
          <div className="w-80 max-w-full">
            <Composer onSend={previewSend} />
          </div>
        </div>
      </Section>
      <Section title="Composer (replying: a line of the message being answered sits above the draft, with any attachments under it; the cross or Escape makes it an ordinary message again)">
        <div className="flex w-full flex-col gap-3">
          <Composer
            onSend={(text, files) => {
              previewSend(text, files)
              setReplying(false)
            }}
            reply={replying
              ? { quote: 'The chart now covers 12 weeks (148 tickets). One edit to src/worker.ts failed because the limit is named maxResults there; I left it alone since 50 per page is enough.', onCancel: () => setReplying(false) }
              : undefined}
          />
          <div><Button disabled={replying} onClick={() => setReplying(true)}>Reply to a message</Button></div>
        </div>
      </Section>
      <Section title="Attachments (image, PDF, spreadsheet, code, and long filename)">
        <AttachmentPreview />
      </Section>
      <Section title="Composer (in-place add menu)">
        <div className="flex w-full flex-col gap-3">
          <p className="text-sm text-kumo-subtle">
            The + expands in place, keeping its anchored corner at the button while following the same curved path.
          </p>
          <Composer onSend={previewSend} addActions={addActions} addMenuInPlace />
        </div>
      </Section>
      <Section title="ChatLayout + MessageList + LiveRows (virtual pages, streaming, slow history, expandable cards; send a message or add a card to see a row arrive, remove the card to see it leave; go to the oldest loaded message from near it to scroll there, or from pages away to fade over to it)">
        <MessageListPreview />
      </Section>
      <Section title="Borders: line (input) and hairline (checkbox)">
        <Input aria-label="Text input" placeholder="Input" />
        <Checkbox label="Checkbox" />
      </Section>
    </div>
  )
}
