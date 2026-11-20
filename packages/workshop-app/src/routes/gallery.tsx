import { useState } from 'react'
import { createFileRoute, Link } from '@tanstack/react-router'
import { Checkbox, Input, Tabs } from '@cloudflare/kumo'
import { CaretLeftIcon, CirclesFourIcon, FileTextIcon, MagnifyingGlassIcon, PlusIcon, PresentationIcon, SignOutIcon, TableIcon } from '@phosphor-icons/react'
import { Composer } from '@/blocks/Composer'
import type { ComposerCommand } from '@/blocks/ComposerCommandPicker'
import { ComposerAttachmentTray } from '@/blocks/ComposerAttachmentTray'
import { ChatListItem } from '@/blocks/ChatListItem'
import { ChatStart } from '@/blocks/ChatStart'
import type { ComposerAttachment } from '@/blocks/useComposerAttachments'
import { MemberListItem } from '@/blocks/MemberListItem'
import { WorkspaceIconPicker } from '@/blocks/WorkspaceIconPicker'
import { WorkspaceListItem } from '@/blocks/WorkspaceListItem'
import type { WorkspacePickerProps } from '@/blocks/WorkspacePicker'
import { MessageBubble } from '@/blocks/MessageBubble'
import { Sidebar, type SidebarActions, type SidebarChat, type SidebarWorkspace } from '@/blocks/Sidebar'
import { Avatar } from '@/components/Avatar'
import { Tag } from '@/components/Tag'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { ConfirmMenu } from '@/components/ConfirmMenu'
import { Switch } from '@/components/Switch'
import { ShimmerText } from '@/components/ShimmerText'
import { Tabs as PageTabs } from '@/components/Tabs'
import { ConnectButton } from '@/components/ConnectButton'
import { DropdownMenu, type DropdownMenuProps } from '@/components/DropdownMenu'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import { workspaceColors, workspaceShapes, type WorkspaceLook } from '@/components/workspaceLook'
import { AdminAuditPreview } from '@/gallery/AdminAuditPreview'
import { AdminFormatsPreview } from '@/gallery/AdminFormatsPreview'
import { AdminModelsPreview } from '@/gallery/AdminModelsPreview'
import { AdminSettingsPreview } from '@/gallery/AdminSettingsPreview'
import { AdminUpdatesPreview } from '@/gallery/AdminUpdatesPreview'
import { AssistantPresencePreview } from '@/gallery/AssistantPresencePreview'
import { AgentsPreview } from '@/gallery/AgentsPreview'
import { HistoryPreview, WorkspaceChatsPreview } from '@/gallery/WorkspaceChatsPreview'
import { AutomationsPreview } from '@/gallery/AutomationsPreview'
import { CardBlocksPreview } from '@/gallery/CardBlocksPreview'
import { ChatMenuPreview } from '@/gallery/ChatMenuPreview'
import { CodePreview } from '@/gallery/CodePreview'
import { DeveloperPreview } from '@/gallery/DeveloperPreview'
import { EmptyStatePreview } from '@/gallery/EmptyStatePreview'
import { ExportPreview } from '@/gallery/ExportPreview'
import { GadgetAskPreview } from '@/gallery/GadgetAskPreview'
import { GadgetPagePreview } from '@/gallery/GadgetPagePreview'
import { GadgetSettingsPreview } from '@/gallery/GadgetSettingsPreview'
import { ConnectionsPreview } from '@/gallery/ConnectionsPreview'
import { HeaderPreview } from '@/gallery/HeaderPreview'
import { LibraryListPreview } from '@/gallery/LibraryListPreview'
import { LibraryMenuPreview } from '@/gallery/LibraryMenuPreview'
import { LibraryPagePreview } from '@/gallery/LibraryPagePreview'
import { TemplateStorePreview } from '@/gallery/TemplateStorePreview'
import { ListViewPreview } from '@/gallery/ListViewPreview'
import { MascotPreview } from '@/gallery/MascotPreview'
import { UiUnderwayPreview } from '@/gallery/UiUnderwayPreview'
import { MessageBlocksPreview } from '@/gallery/MessageBlocksPreview'
import { MessageListPreview } from '@/gallery/MessageListPreview'
import { OnboardingPreview } from '@/gallery/OnboardingPreview'
import { GalleryShell, type GalleryPage } from '@/gallery/GalleryShell'
import { Section } from '@/gallery/Section'
import { AddConnectionPreview, SetUpConnectionPreview } from '@/gallery/SetUpConnectionPreview'
import { SearchPreview } from '@/gallery/SearchPreview'
import { SettingsPreview } from '@/gallery/SettingsPreview'
import { SharingPreview } from '@/gallery/SharingPreview'
import { SignInPreview } from '@/gallery/SignInPreview'
import { ShellPreview } from '@/gallery/ShellPreview'
import { SystemBlocksPreview } from '@/gallery/SystemBlocksPreview'
import { OutOfCreditsPreview } from '@/gallery/OutOfCreditsPreview'
import { ToolBlocksPreview } from '@/gallery/ToolBlocksPreview'
import { WorkspaceRemovalPreview } from '@/gallery/WorkspaceRemovalPreview'

export const Route = createFileRoute('/gallery')({
  validateSearch: (search: Record<string, unknown>): { page?: string } => (typeof search.page === 'string' ? { page: search.page } : {}),
  component: () => <Gallery />,
})

const previewCommands: ComposerCommand[] = [
  { key: 'review', name: 'review-writing', title: 'Review Writing', description: 'Polish a draft and make it clearer.', kind: 'skill', source: 'Writing tools' },
  { key: 'summarize', name: 'summarize', title: 'Summarize', description: 'Turn a long document into the key takeaways.', kind: 'skill', source: 'Documents' },
  { key: 'compact', name: 'compact', title: 'Compact', description: 'Sum up the chat so far, to make room for more', kind: 'builtin' },
]

// Enough skills that the + menu has to be searched: about 150, from a few dozen subjects.
const SKILL_SUBJECTS = ['Meeting', 'Invoice', 'Release', 'Incident', 'Hiring', 'Budget', 'Roadmap', 'Design', 'Support', 'Contract', 'Travel', 'Research', 'Launch', 'Onboarding', 'Expense', 'Security', 'Sales', 'Survey', 'Newsletter', 'Interview', 'Quarterly', 'Vendor', 'Customer', 'Training', 'Podcast']
const SKILL_KINDS = [
  ['Brief', 'Prepare a one-page brief before it starts'],
  ['Notes', 'Write up what was said and who does what next'],
  ['Review', 'Read it through and say what should change'],
  ['Report', 'Gather the numbers into a report to share'],
  ['Checklist', 'Make a checklist of everything that has to happen'],
  ['Email', 'Draft the email that goes out about it'],
] as const
const manyCommands: ComposerCommand[] = [
  ...SKILL_SUBJECTS.flatMap((subject, s) =>
    SKILL_KINDS.map(([kind, description], k) => {
      const title = `${subject} ${kind}`
      const name = title.toLowerCase().replace(/\s+/g, '-')
      return { key: name, name, title, description: `${description}.`, kind: 'skill' as const, source: ['My skills', 'Engineering', 'Finance', 'People'][(s + k) % 4] }
    }),
  ),
  { key: 'compact', name: 'compact', title: 'Compact', description: 'Sum up the chat so far, to make room for more', kind: 'builtin' },
]

const previewWorkspaces: SidebarWorkspace[] = [
  { id: 'greeting', workspaceLabel: 'CG', title: 'Casual Greeting', subtitle: '4 hours ago' },
  { id: 'assistant', workspaceLabel: 'AA', title: 'Assistant Availability Check', subtitle: 'Oct 28' },
  { id: 'untitled', workspaceLabel: 'UW', title: 'Untitled Workspace' },
  { id: 'dashboard', workspaceLabel: 'JD', title: 'Jira dashboard', subtitle: 'Oct 27', unread: true },
  { id: 'slides', workspaceLabel: 'PS', title: 'Presentation slides', subtitle: 'Oct 26' },
]

const chatIn = (workspace: SidebarWorkspace, chat: Omit<SidebarChat, 'workspaceId' | 'workspaceTitle' | 'workspaceLabel' | 'workspaceLook'>): SidebarChat => ({
  ...chat,
  workspaceId: workspace.id,
  workspaceTitle: workspace.title,
  workspaceLabel: workspace.workspaceLabel,
  workspaceLook: workspace.workspaceLook,
})
const [greeting, assistant, , dashboard, slides] = previewWorkspaces
const previewChats: SidebarChat[] = [
  chatIn(dashboard, { id: 'dashboard:4', title: 'Sprint burndown', time: '2m', attention: 'Needs approval', preview: 'Share “Q3 plan” with finance' }),
  chatIn(greeting, { id: 'greeting:7', title: 'Plan the offsite', time: '5m', speaker: 'Maya', preview: 'Sounds good, let’s book the venue for Thursday', unread: true }),
  chatIn(slides, { id: 'slides:2', title: 'Investor update deck', time: '18m', working: true }),
  chatIn(dashboard, { id: 'dashboard:3', title: 'Bug triage', time: '1h', preview: 'I grouped the open bugs by component and flagged three as regressions.' }),
  chatIn(assistant, { id: 'assistant:1', title: 'Availability next week', time: '3h', speaker: 'You', preview: 'Can you check Tuesday instead?', muted: true }),
  chatIn(greeting, { id: 'greeting:6', title: 'Welcome email draft', time: '2d', preview: 'Here’s a shorter version with the dates up front.' }),
]

// More than fit in the menu, one with a look of its own and one with a title too long for the button.
const pickerWorkspaces: WorkspacePickerProps['workspaces'] = [
  ...previewWorkspaces.map(({ id, workspaceLabel, title }) => ({ id, label: workspaceLabel, title })),
  { id: 'paris', label: 'CA', title: 'Create a new slideshow about the history of Paris and its many bridges', look: { shape: 'rocket', color: 'blue' } },
  { id: 'roadmap', label: 'QR', title: 'Quarterly roadmap' },
  { id: 'onboarding', label: 'OC', title: 'Onboarding checklist' },
  { id: 'budget', label: 'BT', title: 'Budget tracker' },
]

const ShimmerTextPreview = () => {
  const [active, setActive] = useState(true)
  return (
    <div className="flex flex-wrap items-center gap-6">
      <ShimmerText active={active} className="text-base text-kumo-default">Reconnecting…</ShimmerText>
      <ShimmerText active={active} className="text-sm text-kumo-subtle">Running code…</ShimmerText>
      <span className="rounded-full bg-kumo-contrast px-4 py-2 text-kumo-inverse">
        <ShimmerText active={active}>Reconnecting…</ShimmerText>
      </span>
      <Switch label="Active" checked={active} onCheckedChange={setActive} />
    </div>
  )
}

const WorkspaceIconPickerPreview = () => {
  const [look, setLook] = useState<WorkspaceLook>()
  return (
    <div className="flex w-full justify-center py-4">
      <WorkspaceIconPicker label="EN" look={look} onLookChange={setLook} />
    </div>
  )
}

const PAGE_TABS = [
  { value: 'chats', label: 'Chats' },
  { value: 'library', label: 'Library' },
  { value: 'members', label: 'Members' },
] as const

const TabsPreview = () => {
  const [tab, setTab] = useState<(typeof PAGE_TABS)[number]['value']>('chats')
  return (
    <Section title="Tabs (a workspace's page: the chosen one on a pill; arrow keys move between them)">
      <PageTabs value={tab} onValueChange={setTab} tabs={[...PAGE_TABS]} aria-label="Workspace" className="w-full gap-4">
        {PAGE_TABS.map(({ value, label }) => (
          <PageTabs.Panel key={value} value={value} className="text-center text-base text-kumo-subtle">{label} go here.</PageTabs.Panel>
        ))}
      </PageTabs>
    </Section>
  )
}

const AttachmentPreview = () => {
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => [
    { id: 'image', file: new File([PIXELS], 'Pixels.png', { type: 'image/png' }) },
    { id: 'pdf', file: new File([], 'Project brief.pdf', { type: 'application/pdf' }) },
    { id: 'csv', file: new File([], 'Quarterly results.csv', { type: 'text/csv' }) },
    { id: 'code', file: new File([], 'dashboard.tsx') },
    { id: 'long', file: new File([], 'Notes with a longer filename to check wrapping.md') },
  ])

  return (
    <div className="w-full overflow-hidden rounded-[21px] bg-kumo-elevated ring-1 ring-kumo-line">
      <ComposerAttachmentTray attachments={attachments} onRemove={(id) => setAttachments((items) => items.filter((item) => item.id !== id))} />
    </div>
  )
}

// A 2×2 PNG, so the gallery has a picture to preview.
const PIXELS = Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4H6P3rUmeAYiBLAAvHgZBFoNqxwAAAABJRU5ErkJggg=='), (char) => char.charCodeAt(0))

/** Takes a moment over each send, as one over the network does, then has it fail or go. */
const slowly = (went: boolean, then: () => void) => () =>
  new Promise<boolean>((resolve) => setTimeout(() => {
    then()
    resolve(went)
  }, 1200))

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

// The app's own controls, on their own.
const BasicsPage = () => (
  <>
    <Section title="Button">
      <Button>Refactor conditional rendering logic</Button>
      <Button icon={CaretLeftIcon}>Back to chat</Button>
      <Button icon={CirclesFourIcon} aria-label="Apps" />
      <Button disabled>Disabled</Button>
      <Button icon={MagnifyingGlassIcon} aria-label="Search" />
      <Button variant="ghost">Ghost</Button>
      <Button variant="primary">Primary</Button>
      <Button variant="danger">Danger</Button>
    </Section>
    <Section title="ConfirmMenu (what cannot be taken back, asked in place: growing up from the end, and down from an icon)">
      <ConfirmMenu label="Delete chat" title="Delete this chat?" description="What was said in it goes for everyone in the workspace. What it made stays in the library." confirmLabel="Delete chat" onConfirm={() => {}} />
      <ConfirmMenu icon={SignOutIcon} aria-label="Sign out" triggerVariant="ghost" triggerClassName="text-kumo-danger" side="bottom" title="Sign out?" description="You will have to sign in again on this device." confirmLabel="Sign out" onConfirm={() => {}} />
    </Section>
    <Section title="Banner (something wrong: said alone, and with what to do about it and the way to)">
      <div className="flex w-full max-w-lg flex-col gap-3">
        <Banner title="Couldn’t connect Slack: the service did not answer." />
        <Banner title="Sign-in expired" description="Sign in to Jira again to keep using this account." action={{ label: 'Reconnect', onSelect: () => {} }} />
      </div>
    </Section>
    <Section title="ShimmerText (something under way, in the colour of what it is in; still with reduced motion, or not active)">
      <ShimmerTextPreview />
    </Section>
    <Section title="DropdownMenu (side, align, trigger, in-place and keep-trigger toggles)">
      <DropdownMenuPlayground />
    </Section>
    <Section title="Avatar">
      <Avatar name="Balint" />
      <Avatar name="Ada Lovelace" />
      <Avatar name="Broken image" src="/missing.png" />
    </Section>
    <Section title="Tag (an outline only, the same on the page and on a tinted surface)">
      <Tag>Meetings</Tag>
      <span className="flex rounded-2xl bg-kumo-tint p-3">
        <Tag>Meetings</Tag>
      </span>
    </Section>
    <Section title="ConnectButton">
      <ConnectButton>
        <span className="size-5 rounded-full bg-kumo-fill" />
        <span className="size-5 rounded-full bg-kumo-fill" />
      </ConnectButton>
      <ConnectButton />
    </Section>
    <Section title="Borders: line (input) and hairline (checkbox)">
      <Input aria-label="Text input" placeholder="Input" />
      <Checkbox label="Checkbox" />
    </Section>
  </>
)

// What a workspace is drawn as, and the way to choose it.
const WorkspaceIconsPage = () => (
  <>
    <Section title="WorkspaceIcon (and small, as in a button)">
      <WorkspaceIcon label="EN" />
      <WorkspaceIcon label="DE" />
      <WorkspaceIcon label="FR" />
      <WorkspaceIcon label="EN" small />
      <WorkspaceIcon label="MW" small />
    </Section>
    <Section title="WorkspaceIcon (every shape, and small; every colour)">
      <div className="flex w-full flex-col gap-4">
        <div className="flex flex-wrap items-center gap-4">
          {workspaceShapes.map((shape) => <WorkspaceIcon key={shape} label="EN" shape={shape} />)}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {workspaceShapes.map((shape) => <WorkspaceIcon key={shape} label="MW" shape={shape} small />)}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          {workspaceColors.map((color, index) => <WorkspaceIcon key={color} label="EN" shape={workspaceShapes[index % workspaceShapes.length]} color={color} />)}
        </div>
      </div>
    </Section>
    <Section title="WorkspaceIconPicker (a workspace’s icon on its page: click it to choose its shape and its colour, which it takes on as each is chosen)">
      <WorkspaceIconPickerPreview />
    </Section>
  </>
)

// A row of each list in the sidebar and on a workspace's page.
const ListRowsPage = () => (
  <>
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
      <div className="flex w-96 flex-col rounded-3xl bg-kumo-tint p-1.5">
        <ChatListItem title="Jira dashboard" time="4 hours ago" onSelect={() => {}} />
        <ChatListItem title="Create a new slideshow about the history of Paris" time="Oct 27" onSelect={() => {}} />
        <ChatListItem title="Title only, no time" onSelect={() => {}} />
      </div>
    </Section>
    <Section title="MemberListItem (the owner, the viewer, a collaborator who can only use it, one with no picture)">
      <div className="flex w-96 flex-col rounded-3xl bg-kumo-tint p-1.5">
        <MemberListItem name="Ada Lovelace" role="Owner" />
        <MemberListItem name="Grace Hopper" you role="Member" />
        <MemberListItem name="Alan Turing" role="Can use" />
        <MemberListItem name="A collaborator with a much longer name than fits" role="Member" />
      </div>
    </Section>
  </>
)

// The app's sidebar, as it was and as it is, expanded and on the rail.
const SidebarPage = () => {
  const [selectedWorkspace, setSelectedWorkspace] = useState<string | undefined>('greeting')
  const [selectedChat, setSelectedChat] = useState<string>()
  const [sidebarPage, setSidebarPage] = useState<'library' | 'workspaces' | 'connections' | 'settings'>()
  const [chats, setChats] = useState(previewChats)
  const [hidden, setHidden] = useState<string[]>([])
  const [pinned, setPinned] = useState(['greeting', 'dashboard'])
  const [said, setSaid] = useState('Right-click a row, or press and hold it on a touch screen, for its menu.')
  const shownChats = chats
    .filter(({ id }) => !hidden.includes(id))
    .map((chat) => ({ ...chat, workspacePinned: pinned.includes(chat.workspaceId) }))
  const workspaces = previewWorkspaces.filter(({ id }) => pinned.includes(id)).map((workspace) => ({ ...workspace, pinned: true }))
  const change = (id: string, to: Partial<SidebarChat>) => setChats((current) => current.map((chat) => (chat.id === id ? { ...chat, ...to } : chat)))
  const actions: SidebarActions = {
    onOpenWorkspace: (id) => setSaid(`Go to the workspace ${id}.`),
    onPinWorkspace: (id, on) => setPinned((current) => (on ? [id, ...current] : current.filter((other) => other !== id))),
    onMuteWorkspace: (id, length) => {
      setChats((current) => current.map((chat) => (chat.workspaceId === id ? { ...chat, workspaceMuted: length !== null } : chat)))
      setSaid(length ? `Muted ${id} (${length}).` : `Unmuted ${id}.`)
    },
    onMarkWorkspaceRead: (id) => setChats((current) => current.map((chat) => (chat.workspaceId === id ? { ...chat, unread: false } : chat))),
    onNewChat: (id) => setSaid(`A new chat in ${id}.`),
    onMuteChat: (chat, muted) => change(chat.id, { muted }),
    onMarkChatRead: (chat, read) => change(chat.id, { unread: !read }),
    onHideChat: (chat) => setHidden((current) => [...current, chat.id]),
  }
  // A message arrives in the last chat: it moves up once the sidebar is no longer pointed at.
  const arrive = () => setChats((current) => {
    const last = current.at(-1)!
    return [{ ...last, time: 'now', unread: true, speaker: 'Grace', preview: 'Just pushed the fix, can you take a look?' }, ...current.slice(0, -1)]
  })
  return (
    <>
      <Section title="Sidebar, expanded and collapsed to a rail: the pinned workspaces, then the viewer’s recent chats, each under its workspace’s icon, with what waits on them first. Right-click a row (or press and hold it) for its menu; a chat removed can be put back from where it was for a while. The chats keep their order while the list is pointed at: send a message to the last one and it moves up once the pointer leaves. On the rail, each workspace is its icon, pinned first, and pointing at one opens a card of its chats. As it was, with the pages as icons beside the logo, kept to compare, then as it is, with them as rows under the list">
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <Button onClick={arrive}>A message arrives in the last chat</Button>
            <Button onClick={() => setHidden([])} disabled={hidden.length === 0}>Put back removed chats</Button>
            <p role="status" className="text-sm text-kumo-subtle">{said}</p>
          </div>
          <div className="flex gap-4">
            {(['icons', 'rows'] as const).flatMap((layout) => [false, true].map((collapsed) => (
              <div key={`${layout}-${collapsed}`} className={`flex h-[40rem] shrink-0 flex-col rounded-3xl bg-kumo-canvas p-2 ring-1 ring-kumo-line ${collapsed ? 'w-14' : 'w-72'}`}>
                <Sidebar
                  user={{ name: 'Ada Lovelace' }}
                  workspaces={workspaces}
                  selectedWorkspaceId={sidebarPage || (selectedChat && !collapsed) ? undefined : selectedWorkspace}
                  onSelectWorkspace={(id) => {
                    setSelectedWorkspace(id)
                    setSelectedChat(undefined)
                    setSidebarPage(undefined)
                  }}
                  chats={shownChats}
                  selectedChatId={sidebarPage ? undefined : selectedChat}
                  onSelectChat={(chat) => {
                    setSelectedChat(chat.id)
                    setSelectedWorkspace(chat.workspaceId)
                    setSidebarPage(undefined)
                    change(chat.id, { unread: false })
                  }}
                  actions={actions}
                  onUnhideChat={(chat) => setHidden((current) => current.filter((id) => id !== chat.id))}
                  connections={[{ name: 'Google' }, { name: 'Linear' }, { name: 'Cloudflare' }]}
                  library={{ current: sidebarPage === 'library', onOpen: () => setSidebarPage('library'), waiting: 3 }}
                  workspacesPage={{ current: sidebarPage === 'workspaces', onOpen: () => setSidebarPage('workspaces') }}
                  connectionsPage={{ current: sidebarPage === 'connections', onOpen: () => setSidebarPage('connections') }}
                  // The user's own menu has the settings and signing out.
                  settingsPage={{ current: sidebarPage === 'settings', onOpen: () => setSidebarPage('settings') }}
                  onSignOut={() => {}}
                  collapsed={collapsed}
                  layout={layout}
                />
              </div>
            )))}
          </div>
        </div>
      </Section>
    </>
  )
}

// Messages drawn as bubbles, in runs.
const BubblesPage = () => (
  <>
    <Section title="MessageBubble, MessageActions (a run of messages tucks together; point at a message, or tab to it, for its actions)">
      <div className="flex w-full flex-col gap-2">
        <MessageBubble role="user">Create a dashboard showcasing my jira stats</MessageBubble>
        <MessageBubble role="user">Make it dark</MessageBubble>
        <MessageBubble role="user">And add a chart of open tickets per week, with the team split out</MessageBubble>
        <MessageBubble role="assistant">I’ll build a personal Jira dashboard.</MessageBubble>
        <MessageBubble role="error">Something went wrong</MessageBubble>
      </div>
    </Section>
  </>
)

// The composer in each of the ways it is written in, and the home page around it.
const ComposerPage = () => {
  const [menuAction, setMenuAction] = useState('Open + to preview files, connections, and skills.')
  const addActions = {
    onAddConnection: () => setMenuAction('Preview: add a new connection selected.'),
  }
  const previewSend = (text: string, files: File[], command?: ComposerCommand) => {
    setMenuAction(command
      ? `Preview: sent /${command.name}${text ? ` with “${text}”` : ''}.`
      : `Preview: sent ${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}${text ? ` with “${text}”` : ''}.`)
    return true
  }
  const [replying, setReplying] = useState(true)
  const [startWorkspace, setStartWorkspace] = useState<string>()
  const [startsWithFormat, setStartsWithFormat] = useState(true)
  const [sendFailed, setSendFailed] = useState(true)
  const [working, setWorking] = useState(true)

  return (
    <>
      <Section title="Composer">
        <div className="flex w-full flex-col gap-3">
          <p className="text-sm text-kumo-subtle">
            Starts inline, lifts above the action buttons when text wraps, and scrolls once it reaches its maximum height.
            Enter sends; Shift+Enter adds a line. The + menu morphs from its button; Escape closes it.
            Pick, paste, or drop files to preview local attachments. Dragging over the composer uses its focus highlight.
            A slash at the start of a word offers the skills and commands, the arrow keys and Enter or Tab choosing one, which then heads the draft; the + menu lists them too, under a field to find one by. Backspace at the start or Escape takes it off.
          </p>
          <Composer onSend={previewSend} addActions={addActions} commands={previewCommands} />
          <p role="status" className="text-sm text-kumo-subtle">{menuAction}</p>
          <div className="w-80 max-w-full">
            <Composer onSend={previewSend} />
          </div>
        </div>
      </Section>
      <Section title="Composer (150 skills: the + menu opens at the height it keeps, its list scrolling, with the field nearest the composer and the focus in it; typing narrows the list as a slash does, the arrow keys move, Enter or Tab chooses and Escape closes. The second is still reading its skills, and keeps their room)">
        <div className="flex w-full flex-col gap-3">
          <Composer onSend={previewSend} addActions={addActions} commands={manyCommands} />
          <Composer onSend={previewSend} addActions={addActions} commandsLoading />
        </div>
      </Section>
      <Section title="ChatStart (the home page, before the first message; under the composer, the workspace the chat starts in: a new one until another is chosen from the menu, where typing narrows them; a slash offers the user’s skills, from the Library, as there is no workspace yet to list them)">
        <div className="flex h-[32rem] w-full rounded-3xl bg-kumo-base">
          <ChatStart
            greeting="Hello Ada, what should we do today?"
            onSend={previewSend}
            commands={previewCommands.filter(({ kind }) => kind === 'skill')}
            workspace={{ workspaces: pickerWorkspaces, value: startWorkspace, onValueChange: setStartWorkspace }}
          />
        </div>
      </Section>
      <Section title="Composer (replying: a line of the message being answered sits above the draft, with any attachments under it; the cross or Escape makes it an ordinary message again)">
        <div className="flex w-full flex-col gap-3">
          <Composer
            onSend={(text, files) => {
              setReplying(false)
              return previewSend(text, files)
            }}
            reply={replying
              ? { quote: 'The chart now covers 12 weeks (148 tickets). One edit to src/worker.ts failed because the limit is named maxResults there; I left it alone since 50 per page is enough.', onCancel: () => setReplying(false) }
              : undefined}
          />
          <div><Button disabled={replying} onClick={() => setReplying(true)}>Reply to a message</Button></div>
        </div>
      </Section>
      <Section title="Composer (starting with a format, as from the library’s New menu: what the message asks for something as sits above the draft, which can then be sent with no words; the cross makes it an ordinary message again)">
        <div className="flex w-full flex-col gap-3">
          <Composer
            onSend={(text, files) => {
              setMenuAction(`Preview: sent “${startsWithFormat ? ['Document', text].filter(Boolean).join(' ') : text}”, with ${files.length} ${files.length === 1 ? 'attachment' : 'attachments'}.`)
              return true
            }}
            format={startsWithFormat ? { noun: 'Document', icon: 'fileText', onRemove: () => setStartsWithFormat(false) } : undefined}
          />
          <div><Button disabled={startsWithFormat} onClick={() => setStartsWithFormat(true)}>Start with a document</Button></div>
        </div>
      </Section>
      <Section title="Composer (the agent working: Stop, with Send beside it for words that steer; stopping puts what was waiting in the draft)">
        <div className="flex w-full flex-col gap-3">
          <Composer
            onSend={previewSend}
            stop={working ? { waiting: ['Make it shorter'], onStop: async () => setWorking(false) } : undefined}
          />
          <div><Button disabled={working} onClick={() => setWorking(true)}>Start working</Button></div>
        </div>
      </Section>
      <Section title="Composer (a message that did not go: why, in a bar over the composer, until it is dismissed or the next send; a long one wraps. While a message is going its draft stays, dimmed and unsendable, and is kept if it does not go: the first composer fails every other send, the second takes a moment over a reply that fails, keeping the quote and the files)">
        <div className="flex w-full flex-col gap-3">
          <Composer
            onSend={(text, files) => {
              if (!sendFailed) {
                setSendFailed(true)
                return false
              }
              setSendFailed(false)
              return previewSend(text, files)
            }}
            problem={sendFailed ? { message: 'Files can be sent once the agent has finished.', onDismiss: () => setSendFailed(false) } : undefined}
          />
          <Composer
            onSend={slowly(false, () => setMenuAction('Preview: the reply did not go, and its draft is kept.'))}
            reply={{ quote: 'The chart now covers 12 weeks (148 tickets).', onCancel: () => {} }}
          />
          <div><Button disabled={sendFailed} onClick={() => setSendFailed(true)}>Fail a send</Button></div>
          <div className="w-80 max-w-full">
            <Composer
              onSend={previewSend}
              problem={{
                message: 'The files come to more than 5 MB, the most a message can carry. Remove some of them, or send them over more than one message.',
                onDismiss: () => {},
              }}
            />
          </div>
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
          <Composer onSend={previewSend} addActions={addActions} commands={previewCommands} addMenuInPlace />
        </div>
      </Section>
    </>
  )
}

// A whole conversation, as it scrolls.
const MessageListPage = () => (
  <>
    <Section title="ChatLayout + MessageList + LiveRows (virtual pages, streaming, slow history, expandable cards; send a message or add a card to see a row arrive, remove the card to see it leave; go to the oldest loaded message from near it to scroll there, or from pages away to fade over to it)">
      <MessageListPreview />
    </Section>
  </>
)

// Each page of the gallery, in the order its index lists them, a group at a time.
// Pages drawn whole, at an address of their own, over a fake backend.
const WholePagesPage = () => (
  <p className="text-base text-kumo-subtle">
    Whole pages, over a fake backend:{' '}
    <Link to="/gallery/no-access" className="underline underline-offset-2">opening a link to an app without access</Link>
  </p>
)

const PAGES: GalleryPage[] = [
  { id: 'basics', group: 'Foundations', name: 'Basics', Page: BasicsPage },
  { id: 'workspace-icons', group: 'Foundations', name: 'Workspace icons', Page: WorkspaceIconsPage },
  { id: 'list-rows', group: 'Foundations', name: 'List rows', Page: ListRowsPage },
  { id: 'tabs', group: 'Foundations', name: 'Tabs', Page: TabsPreview },
  { id: 'empty-states', group: 'Foundations', name: 'Empty states', Page: EmptyStatePreview },
  { id: 'list-controls', group: 'Foundations', name: 'List controls', Page: ListViewPreview },
  { id: 'headers', group: 'Foundations', name: 'Headers', Page: HeaderPreview },
  { id: 'mascot', group: 'Foundations', name: 'Mascot', Page: MascotPreview },
  { id: 'assistant-presence', group: 'Foundations', name: 'Assistant presence', Page: AssistantPresencePreview },
  { id: 'under-way', group: 'Foundations', name: 'Under way', Page: UiUnderwayPreview },

  { id: 'composer', group: 'Chat', name: 'Composer', Page: ComposerPage },
  { id: 'bubbles', group: 'Chat', name: 'Message bubbles', Page: BubblesPage },
  { id: 'messages', group: 'Chat', name: 'Messages', Page: MessageBlocksPreview },
  { id: 'message-list', group: 'Chat', name: 'Message list', Page: MessageListPage },
  { id: 'cards', group: 'Chat', name: 'Cards', Page: CardBlocksPreview },
  { id: 'tools', group: 'Chat', name: 'Work log', Page: ToolBlocksPreview },
  { id: 'system', group: 'Chat', name: 'System rows', Page: SystemBlocksPreview },
  { id: 'code', group: 'Chat', name: 'Code', Page: CodePreview },
  { id: 'chat-menu', group: 'Chat', name: 'Chat menu', Page: ChatMenuPreview },
  { id: 'out-of-credits', group: 'Chat', name: 'Out of credits', Page: OutOfCreditsPreview },
  { id: 'developer', group: 'Chat', name: 'Developer mode', Page: DeveloperPreview },

  { id: 'workspace-chats', group: 'Workspace', name: 'Chats', Page: WorkspaceChatsPreview },
  { id: 'history', group: 'Workspace', name: 'Activity log', Page: HistoryPreview },
  { id: 'agents', group: 'Workspace', name: 'Agents', Page: AgentsPreview },
  { id: 'automations', group: 'Workspace', name: 'Automations', Page: AutomationsPreview },
  { id: 'sharing', group: 'Workspace', name: 'Sharing', Page: SharingPreview },
  { id: 'workspace-removal', group: 'Workspace', name: 'Removing a workspace', Page: WorkspaceRemovalPreview },

  { id: 'library', group: 'Library', name: 'Library page', Page: LibraryPagePreview },
  { id: 'library-rows', group: 'Library', name: 'Library rows', Page: LibraryListPreview },
  { id: 'library-menu', group: 'Library', name: 'Library menu', Page: LibraryMenuPreview },
  { id: 'templates', group: 'Library', name: 'Templates', Page: TemplateStorePreview },
  { id: 'export', group: 'Library', name: 'Export', Page: ExportPreview },

  { id: 'gadget-page', group: 'Apps', name: 'App page', Page: GadgetPagePreview },
  { id: 'gadget-settings', group: 'Apps', name: 'App settings', Page: GadgetSettingsPreview },
  { id: 'gadget-asks', group: 'Apps', name: 'App asks', Page: GadgetAskPreview },

  { id: 'connections', group: 'Connections', name: 'Connections', Page: ConnectionsPreview },
  { id: 'set-up-connection', group: 'Connections', name: 'Set up a connection', Page: SetUpConnectionPreview },
  { id: 'add-connection', group: 'Connections', name: 'Add a connection', Page: AddConnectionPreview },

  { id: 'settings', group: 'Settings', name: 'Settings', Page: SettingsPreview },
  { id: 'admin', group: 'Settings', name: 'Admin', Page: AdminSettingsPreview },
  { id: 'admin-formats', group: 'Settings', name: 'Admin formats', Page: AdminFormatsPreview },
  { id: 'admin-models', group: 'Settings', name: 'Admin models', Page: AdminModelsPreview },
  { id: 'admin-audit', group: 'Settings', name: 'Admin audit', Page: AdminAuditPreview },
  { id: 'admin-updates', group: 'Settings', name: 'Admin updates', Page: AdminUpdatesPreview },

  { id: 'shell', group: 'App', name: 'Shell', Page: ShellPreview },
  { id: 'sidebar', group: 'App', name: 'Sidebar', Page: SidebarPage },
  { id: 'search', group: 'App', name: 'Search', Page: SearchPreview },
  { id: 'sign-in', group: 'App', name: 'Sign in', Page: SignInPreview },
  { id: 'onboarding', group: 'App', name: 'Onboarding', Page: OnboardingPreview },
  { id: 'whole-pages', group: 'App', name: 'Whole pages', Page: WholePagesPage },
]

function Gallery() {
  const { page } = Route.useSearch()
  const navigate = Route.useNavigate()
  return (
    <GalleryShell
      pages={PAGES}
      current={page}
      href={(id) => `/gallery?page=${id}`}
      onSelect={(id) => void navigate({ search: { page: id } })}
    />
  )
}
