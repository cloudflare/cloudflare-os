import { useState } from 'react'
import {
  AiMagicIcon, Alert02Icon, ChipIcon, DashboardCircleIcon, Folder02Icon, Moon02Icon, PanelLeftIcon,
  PencilEdit02Icon, Search01Icon, Settings01Icon, UserIcon,
} from '@/components/icons'
import { SearchDialog, type SearchEntry, type SearchPage } from '@/blocks/SearchDialog'
import { Button } from '@gadgets/ui'
import { WorkspaceIcon } from '@/components/WorkspaceIcon'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { libraryEntries } from '@/library/libraryEntries'
import { suggestedEntries } from '@/routes/-appSearchSuggestions'
import { workspaceActionEntries } from '@/workspaces/workspaceActionEntries'
import { Section } from './Section'

const workspace = (title: string, label: string, detail: string) =>
  ({ title, group: 'Workspaces', detail, icon: <WorkspaceIcon label={label} small /> })

const MODELS = ['Claude Sonnet', 'Claude Haiku', 'GPT-5', 'Gemini Flash']
const MOTION = ['Full', 'Calm', 'Off']
const THEMES = ['System', 'Light', 'Dark']

// Everything the user has made, across workspaces, most recently active first.
const LIBRARY = [
  [20, 'Tip jar', 'Launch readiness', undefined],
  [21, 'Launch checklist', 'Launch readiness', { noun: 'Document', icon: 'fileText' }],
  [22, 'Weekly digest', 'Weekly digest', undefined],
  [12, 'Q3 planning doc', 'Garden planning', { noun: 'Document', icon: 'fileText' }],
  [11, 'Seed tracker', 'Garden planning', { noun: 'Spreadsheet', icon: 'table' }],
  [13, 'Compost log', 'Garden planning', undefined],
  [14, 'Quarterly sales dashboard', 'Launch readiness', undefined],
].map(([workpieceId, title, workspaceTitle, output]) => ({ workspaceId: String(workspaceTitle).toLowerCase().replace(/\W+/g, '-'), workpieceId, title, workspaceTitle, output })) as unknown as OutputSummary[]

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Search, as ⌘K and the sidebar's button open it. */
export const SearchPreview = () => {
  const [open, setOpen] = useState(false)
  const [said, setSaid] = useState('Search, or press ⌘K on the app’s own pages.')
  const [name, setName] = useState('Ada Lovelace')
  const [model, setModel] = useState(MODELS[0])
  const [autoOpen, setAutoOpen] = useState(true)
  const [motion, setMotion] = useState(MOTION[0])
  const [theme, setTheme] = useState(THEMES[0])
  // The models are read a moment after it opens, the first time: until then the row has no value.
  const [modelsRead, setModelsRead] = useState(true)
  // Where it is opened from: a chat or a workspace's page each have what is done there, below the library.
  const [where, setWhere] = useState<'elsewhere' | 'workspace' | 'chat'>('elsewhere')
  // The library is read as it opens, the first time: until then what is found of it is not there yet.
  const [libraryRead, setLibraryRead] = useState(true)
  const entries: SearchEntry[] = [
    { title: 'New chat', group: 'Go to', keywords: ['home', 'start'], icon: <PencilEdit02Icon /> },
    { title: 'Workspaces', group: 'Go to', icon: <Folder02Icon /> },
    { title: 'Library', group: 'Go to', keywords: ['apps', 'files'], icon: <DashboardCircleIcon /> },
    workspace('Garden planning', 'GP', 'Just now'),
    workspace('Launch readiness', 'LR', 'Yesterday'),
    workspace('Weekly digest', 'WD', 'Monday'),
  ].map((entry) => ({ ...entry, key: entry.title, onSelect: () => setSaid(`Went to ${entry.title}.`) }))

  // The settings, as they are offered in the app: one that stays open and says what it is now, one
  // typed in a page of its own, a choice from a page, one that is refused, and one asked for twice.
  const modelPage = (): SearchPage => ({
    kind: 'list',
    title: 'Default model',
    placeholder: 'Choose the model for new chats',
    entries: MODELS.map((choice) => ({
      key: choice,
      group: 'Models',
      title: choice,
      detail: choice === model ? 'Current' : undefined,
      icon: <ChipIcon />,
      onSelect: async () => {
        await wait(400)
        setModel(choice)
        setSaid(`The default model is ${choice}.`)
      },
    })),
  })
  const choice = (key: string, title: string, options: string[], current: string, set: (next: string) => void, icon: SearchEntry['icon'], group: string): SearchEntry => ({
    key,
    group,
    title,
    keywords: options,
    detail: current,
    icon,
    onSelect: () => ({
      kind: 'list',
      title,
      placeholder: `Choose ${title.toLowerCase()}`,
      entries: options.map((option) => ({
        key: option,
        group: title,
        title: option,
        detail: option === current ? 'Current' : undefined,
        icon,
        onSelect: () => {
          set(option)
          setSaid(`${title} is ${option}.`)
        },
      })),
    }),
  })
  const motionEntry = choice('motion', 'Animations', MOTION, motion, setMotion, <AiMagicIcon />, 'Preferences')
  const themeEntry = choice('theme', 'Theme', THEMES, theme, setTheme, <Moon02Icon />, 'Preferences')
  const modelEntry: SearchEntry = modelsRead
    ? { key: 'model', group: 'Models', title: 'Default model', keywords: MODELS, detail: model, icon: <ChipIcon />, onSelect: modelPage }
    : {
        key: 'model',
        group: 'Models',
        title: 'Default model',
        icon: <ChipIcon />,
        onSelect: () => {
          throw new Error('Still loading. Try again in a moment.')
        },
      }
  const here = workspaceActionEntries({
    workspaceTitle: 'Garden planning',
    onNewChat: () => setSaid('Started a new chat in Garden planning.'),
    onInvite: where === 'workspace' ? () => setSaid('Asked to invite people to Garden planning.') : undefined,
  })
  const made = libraryEntries(libraryRead ? LIBRARY : [], (output) => setSaid(`Opened ${output.title}.`))
  const settingsEntry: SearchEntry = { key: 'settings', group: 'Go to', title: 'Settings', icon: <Settings01Icon />, onSelect: () => setSaid('Went to Settings.') }
  const settings: SearchEntry[] = [
    {
      key: 'auto-open',
      group: 'Preferences',
      title: 'Auto-open outputs',
      keywords: ['side pane'],
      on: autoOpen,
      icon: <PanelLeftIcon />,
      keepOpen: true,
      onSelect: () => setAutoOpen(!autoOpen),
    },
    {
      key: 'name',
      group: 'Profile',
      title: 'Change display name',
      detail: name,
      icon: <UserIcon />,
      onSelect: () => ({
        kind: 'text',
        title: 'Display name',
        initial: name,
        onSubmit: async (next) => {
          await wait(400)
          if (next.toLowerCase() === 'root') throw new Error('That name is taken.')
          setName(next)
          setSaid(`Called ${next}.`)
        },
      }),
    },
    modelEntry,
    motionEntry,
    themeEntry,
    {
      // A page that goes on to another, to see each way back be one page.
      key: 'workspace-model',
      group: 'Models',
      title: 'Model for a workspace…',
      icon: <ChipIcon />,
      onSelect: () => ({
        kind: 'list',
        title: 'Workspace',
        placeholder: 'Find a workspace',
        entries: entries.slice(3).map(({ key, title, icon }) => ({ key, group: 'Workspaces', title, icon, onSelect: modelPage })),
      }),
    },
    {
      key: 'refused',
      group: 'Account',
      title: 'Change something that is refused',
      icon: <Alert02Icon />,
      onSelect: () => {
        throw new Error('Not connected. Try again once the connection is back.')
      },
    },
  ]

  const shownHere = where === 'elsewhere' ? undefined : { kind: where, newChat: here.newChat, invite: where === 'workspace' ? here.invite : undefined }
  const NEXT = { elsewhere: 'workspace', workspace: 'chat', chat: 'elsewhere' } as const
  const SAYS = { elsewhere: 'Open from another page', workspace: 'Open from a workspace’s page', chat: 'Open from a chat' } as const

  return (
    <Section title="SearchDialog (the sidebar’s Search, and ⌘K anywhere in the app: before anything is typed, a new chat, in the workspace from a chat or a workspace’s page (with the model from a chat, inviting from the page), with no heading; three recent workspaces; the pages gone to most; then a few settings reached for under Settings (the model is there before its value is read) ending in the way to Settings; then what fits, best first, under what each is, the library included; the arrow keys and Enter, or a click, to go; a setting changes in place, staying open to show it, or goes on to a page to type or choose it, with Backspace or Escape to come back (what was typed goes on into the page where it still finds something: “haiku” finds the model, and goes on to Haiku alone), and says why under the field when it is refused; while the library is still being read, a search that finds nothing says it is looking)">
      <Button icon={Search01Icon} onClick={() => setOpen(true)}>Search</Button>
      <Button onClick={() => setWhere(NEXT[where])}>{SAYS[NEXT[where]]}</Button>
      <Button onClick={() => setLibraryRead(!libraryRead)}>{libraryRead ? 'Show library as still being read' : 'Show library as read'}</Button>
      <Button onClick={() => setModelsRead(!modelsRead)}>{modelsRead ? 'Show models as still loading' : 'Show models as read'}</Button>
      <p role="status" className="w-full text-sm text-kumo-subtle">{said}</p>
      <SearchDialog
        open={open}
        onOpenChange={setOpen}
        entries={[...(shownHere ? [shownHere.newChat, shownHere.invite].filter((entry) => entry !== undefined) : []), ...entries, ...made, settingsEntry, ...settings]}
        suggested={suggestedEntries({
          workspaces: entries.slice(3),
          pages: entries.slice(1, 3),
          newChat: entries[0],
          model: modelEntry,
          settings: [themeEntry, motionEntry, settingsEntry],
          context: shownHere,
        })}
        reading={!libraryRead}
        placeholder="Search workspaces, library, pages and settings"
      />
    </Section>
  )
}
