import { useState } from 'react'
import { AddCollectionDialog } from '@/blocks/AddCollectionDialog'
import { ApprovalRules, type ApprovalRule } from '@/blocks/ApprovalRules'
import { AddSkillDialog } from '@/blocks/AddSkillDialog'
import { BrowserNotificationsRow } from '@/blocks/BrowserNotificationsRow'
import { FilePreviewCard } from '@/blocks/FilePreviewCard'
import { FileEditor } from '@/blocks/FileEditor'
import { ListToolbar } from '@/blocks/ListToolbar'
import { ModelListItem } from '@/blocks/ModelListItem'
import { MutedWorkspaces, type MutableWorkspace } from '@/blocks/MutedWorkspaces'
import { PasswordForm } from '@/blocks/PasswordForm'
import { ProfilePicture } from '@/blocks/ProfilePicture'
import { SettingField } from '@/blocks/SettingField'
import { SettingPresets } from '@/blocks/SettingPresets'
import { SettingRow } from '@/blocks/SettingRow'
import { SettingsCard, SettingsGroup } from '@/blocks/SettingsGroup'
import { SettingsMenu } from '@/blocks/SettingsMenu'
import { SettingsSidebar } from '@/blocks/SettingsSidebar'
import { SkillFileRow } from '@/blocks/SkillFileRow'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { Markdown } from '@/components/Markdown'
import { ScrollArea } from '@/components/ScrollArea'
import { Select } from '@/components/Select'
import { Switch } from '@/components/Switch'
import { Tabs } from '@/components/Tabs'
import { TextField } from '@/components/TextField'
import { ModelDialog, type ModelDialogProps } from '@/settings/ModelDialog'
import type { ModelSource } from '@/settings/modelForm'
import { settingsNavGroups } from '@/settings/settingsSections'
import { useReport } from './previewState'
import { Section } from './Section'

// An admin's, with the deployment's parts after their own.
const GROUPS = settingsNavGroups(undefined, true)

// One of the user's models, as the server reads it: its key and one header saved, and withheld.
const OWN_MODEL: ModelSource = {
  profile: { type: 'agent', id: 'gpt-proxy', name: 'GPT through our proxy' },
  config: { provider: 'openai', model: 'gpt-proxy', apiToken: null, apiUrl: 'https://proxy.example.com/v1', extraHeaders: { 'X-Proxy-Key': null, 'X-Team': 'design' }, contextWindow: 128000 },
}
const PROVIDERS: ModelDialogProps['providers'] = ['anthropic', 'openai', 'google', 'cloudflare', 'ollama']

// The model dialog's states, by the button that opens each.
const MODEL_DIALOGS: { label: string; props: Pick<ModelDialogProps, 'mode' | 'gateway' | 'providers'> }[] = [
  { label: 'Add own model', props: { mode: { kind: 'add' }, gateway: false, providers: PROVIDERS } },
  { label: 'Add own model, with AI Gateway', props: { mode: { kind: 'add' }, gateway: true, providers: ['anthropic', 'openai'] } },
  { label: 'Edit, key saved', props: { mode: { kind: 'edit', source: OWN_MODEL }, gateway: false, providers: PROVIDERS } },
  { label: 'Duplicate', props: { mode: { kind: 'duplicate', source: OWN_MODEL }, gateway: false, providers: PROVIDERS } },
  { label: 'Reading the model', props: { mode: { kind: 'edit', reading: true }, gateway: false, providers: PROVIDERS } },
  { label: 'Couldn’t read it', props: { mode: { kind: 'edit', reading: true, problem: 'Model not found.' }, gateway: false, providers: PROVIDERS } },
]

const WORKSPACES: MutableWorkspace[] = [
  { id: 'design', title: 'Design review', label: 'DR', look: { shape: 'folder', color: 'blue' } },
  { id: 'trip', title: 'Trip planning, with a name long enough that it has to be cut off somewhere along the line', label: 'TP' },
  { id: 'reports', title: 'Weekly reports', label: 'WR' },
  { id: 'inbox', title: 'Inbox triage', label: 'IT' },
]

const RULES: ApprovalRule[] = [
  { id: 'calendar', text: 'Adding events to my own calendar', enabled: true },
  { id: 'send', text: 'Sending anything to someone outside my company, however it is worded and whoever it is that asks for it to be sent', enabled: true },
  { id: 'delete', text: 'Deleting files or messages', enabled: false },
]

const THEMES = [
  { id: 'system', label: 'As the system' },
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
]
const LIMITS = [{ id: '', label: 'No limit' }, { id: '10', label: '$10' }, { id: '25', label: '$25' }]
const WINDOWS = [{ id: '', label: '262K (model default)' }, { id: '200000', label: '200K' }, { id: '128000', label: '128K' }]
const MODELS = ['Claude Opus', 'Claude Sonnet', 'GPT', 'Gemini Pro', 'Kimi K2.7 Code (Workers AI)', 'Llama'].map((label) => ({ id: label, label }))

/** The settings' blocks, and the two components they brought: a field for text and a menu to choose one from, with a field's corners both. */
export const SettingsPreview = () => {
  const { report, later, say } = useReport()
  const [part, setPart] = useState('profile')
  const [name, setName] = useState('Ada Lovelace')
  const [email, setEmail] = useState('')
  const [theme, setTheme] = useState('system')
  const [model, setModel] = useState(MODELS[1].id)
  const [on, setOn] = useState(true)
  const [soon, setSoon] = useState(false)
  const [limit, setLimit] = useState('')
  const [tokens, setTokens] = useState('150000')
  const [text, setText] = useState('')
  const [notes, setNotes] = useState('')
  const [fileQuery, setFileQuery] = useState('')
  const [skillTab, setSkillTab] = useState('preview')
  const [openTabs, setOpenTabs] = useState(['summary.md', 'report.md'])
  const [fileText, setFileText] = useState('---\nname: summarize-meeting-notes\ndescription: Turn a transcript into decisions, owners and next steps.\n---\n\n# Summarize meeting notes\n\n1. List the decisions that were made.\n2. Name an owner for each action.\n')
  const [picture, setPicture] = useState<string>()
  const [rules, setRules] = useState(RULES)
  const [quiet, setQuiet] = useState(['design'])
  const [browserOn, setBrowserOn] = useState(false)
  const [browserPending, setBrowserPending] = useState(false)
  const [addingSkill, setAddingSkill] = useState(false)
  const [addingToCollection, setAddingToCollection] = useState(false)
  const [makingCollection, setMakingCollection] = useState(false)
  const [modelDialog, setModelDialog] = useState<number>()
  const [modelDialogOpen, setModelDialogOpen] = useState(false)

  return (
    <>
      <Section title="TextField: a line, with a label over it, one that cannot be kept, disabled, and several lines">
        <div className="grid w-full max-w-3xl grid-cols-2 items-end gap-4">
          <TextField aria-label="A line of text" placeholder="A line of text" value={text} onValueChange={setText} />
          <TextField label="With a label" value={text} onValueChange={setText} />
          <TextField aria-label="Invalid" value="not an address" invalid onValueChange={() => {}} />
          <TextField aria-label="Disabled" value="Disabled" disabled onValueChange={() => {}} />
          <div className="col-span-2">
            <TextField aria-label="Several lines" rows={3} placeholder="Several lines" value={notes} onValueChange={setNotes} />
          </div>
        </div>
      </Section>
      <Section title="Select: one of a few, from a menu that opens in place out of a field’s corners; with a field to find one by; and while the value is none of them">
        <Select aria-label="Theme" value={theme} options={THEMES} onValueChange={setTheme} />
        <Select aria-label="Model" value={model} options={MODELS} searchable onValueChange={setModel} />
        <Select aria-label="Mute a workspace" value="" options={MODELS} placeholder="Choose…" searchable onValueChange={(id) => say(`chose ${id}`)} />
      </Section>
      <Section title="SettingsGroup of SettingRows: a switch, a menu, a button, one that is not there yet (which still works), one stacked, and one that only says; a group of several cards; one that is not there yet as a whole; and one that holds a field for several lines">
        <div className="flex w-full max-w-3xl flex-col gap-12">
          <SettingsGroup title="Defaults">
            <SettingRow title="A switch" description="What it does, or why it is as it is.">
              <Switch aria-label="A switch" checked={on} onCheckedChange={setOn} />
            </SettingRow>
            <SettingRow title="A menu" description="A description long enough to take several lines where there is not the room for it on one, beside which what it is set by stays level with the row’s top.">
              <Select aria-label="A menu" value={theme} options={THEMES} onValueChange={setTheme} />
            </SettingRow>
            <SettingRow title="A button">
              <Button onClick={() => say('pressed the button')}>Do it</Button>
            </SettingRow>
            <SettingRow title="Not there yet" description="Said beside its title. It is drawn fainter, and what it is set by is out of use." soon>
              <Switch aria-label="Not there yet" checked={soon} onCheckedChange={setSoon} />
            </SettingRow>
            <SettingRow title="Stacked" description="What it is set by is under what is said of it." stacked>
              <TextField aria-label="Stacked" rows={2} value={notes} onValueChange={setNotes} />
            </SettingRow>
            <SettingRow title="Only says" description="With nothing to set it by." />
          </SettingsGroup>
          <SettingsGroup title="In more than one lot" plain>
            <SettingsCard>
              <SettingRow title="A menu" description="With what depends on it under it.">
                <Select aria-label="A menu of the first lot" value={theme} options={THEMES} onValueChange={setTheme} />
              </SettingRow>
              <SettingRow title="A switch">
                <Switch aria-label="A switch of the first lot" checked={on} onCheckedChange={setOn} />
              </SettingRow>
            </SettingsCard>
            <SettingsCard>
              <SettingRow title="A button" description="Apart from the rest.">
                <Button onClick={() => say('pressed the button')}>Do it</Button>
              </SettingRow>
            </SettingsCard>
          </SettingsGroup>
          <SettingsGroup title="Not there yet" soon>
            <SettingRow title="A switch" description="As it will be.">
              <Switch aria-label="A switch that is not there yet" checked={soon} onCheckedChange={setSoon} />
            </SettingRow>
            <SettingRow title="A button">
              <Button>Do it</Button>
            </SettingRow>
          </SettingsGroup>
          <SettingsGroup title="A field for several lines" plain>
            <SettingsCard field>
              <TextField aria-label="A field for several lines" rows={3} placeholder="Several lines, filling the surface, their corners curving with its own" value={notes} onValueChange={setNotes} className="rounded-2xl" />
            </SettingsCard>
          </SettingsGroup>
        </div>
      </Section>
      <Section title="SettingPresets: one of a few values or, with Custom, one typed beside the menu; “abc” is refused; one kept that is none of the values shows as Custom from the start">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <SettingsGroup title="Limits">
            <SettingPresets
              title="Monthly limit"
              description="An empty field is no limit."
              value={limit}
              presets={LIMITS}
              customLabel="Monthly limit, in dollars"
              placeholder="$ a month"
              inputMode="decimal"
              onSave={async (typed) => {
                await later()
                if (typed !== '' && !/^\d+$/.test(typed)) return { saved: false, problem: 'A whole number of dollars, such as 75.' }
                setLimit(typed)
                return { saved: true }
              }}
            />
            <SettingPresets
              title="Context window"
              description="Kept as 150,000, which is none of the values."
              value={tokens}
              presets={WINDOWS}
              customLabel="Context window, in tokens"
              placeholder="Tokens"
              inputMode="numeric"
              format={(kept) => (kept === '' ? '' : Number(kept).toLocaleString('en'))}
              onSave={async (typed) => {
                const digits = typed.replace(/,/g, '')
                if (digits !== '' && !/^\d+$/.test(digits)) return { saved: false, problem: 'A whole number of tokens, such as 200,000.' }
                setTokens(digits)
                return { saved: true }
              }}
            />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="ProfilePicture: click it to upload an image or remove the one there is, which is offered only while there is one; and while one is on its way">
        <ProfilePicture
          name={name}
          src={picture}
          onChoose={(file) => {
            setPicture((current) => {
              if (current) URL.revokeObjectURL(current)
              return URL.createObjectURL(file)
            })
          }}
          onRemove={() => setPicture(undefined)}
        />
        <ProfilePicture name="Grace Hopper" busy onChoose={() => {}} onRemove={() => {}} />
      </Section>
      <Section title="SettingField: a name is kept after a moment, an empty one is put back; an address without an @ is refused, and may be left empty">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <SettingsGroup title="You">
            <SettingField
              title="Name"
              description="What you are called in chats."
              value={name}
              onSave={async (next) => {
                await later()
                setName(next)
                return { saved: true }
              }}
            />
            <SettingField
              title="Commit email"
              description="Left empty, one is made for you."
              value={email}
              optional
              type="email"
              placeholder="name@example.com"
              onSave={async (next) => {
                await later()
                if (next && !next.includes('@')) return { saved: false, problem: 'Expected an address like name@example.com.' }
                setEmail(next)
                return { saved: true }
              }}
            />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="PasswordForm: a new password shorter than 8 is refused before it is sent, as are two that differ; “wrong” as the current one is refused after">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <SettingsGroup title="Password">
            <PasswordForm
              onChange={async (current) => {
                await later()
                return current === 'wrong' ? 'The current password is not right.' : undefined
              }}
            />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="ApprovalRules: rules under what they say, one long, one switched off; Add rule opens a field under them (Escape or Cancel puts it away); switch one, remove one; and with none yet">
        <div className="flex w-full max-w-3xl flex-col gap-12">
          <ApprovalRules
            title="Allow without asking"
            description="What the title alone does not say, in a line under it."
            rules={rules}
            placeholder="Describe what’s allowed"
            onAdd={(about) => setRules((current) => [...current, { id: String(Date.now()), text: about, enabled: true }])}
            onRemove={(id) => setRules((current) => current.filter((rule) => rule.id !== id))}
            onEnabledChange={(id, enabled) => setRules((current) => current.map((rule) => (rule.id === id ? { ...rule, enabled } : rule)))}
          />
          <ApprovalRules title="With none yet" soon rules={[]} onAdd={(about) => say(`added “${about}”`)} onRemove={() => {}} onEnabledChange={() => {}} />
        </div>
      </Section>
      <Section title="BrowserNotificationsRow: this browser’s notifications off, then switched on (which asks the browser, held meanwhile); while it is being read; blocked by the browser; on an iPhone, whose notifications come from the app, with no switch; and where switching failed, under why">
        <div className="flex w-full max-w-3xl flex-col gap-12">
          <SettingsGroup title="Channels">
            <BrowserNotificationsRow
              state={browserOn ? 'on' : 'off'}
              pending={browserPending}
              onChange={(next) => {
                setBrowserPending(true)
                setTimeout(() => {
                  setBrowserPending(false)
                  setBrowserOn(next)
                }, 800)
              }}
            />
            <BrowserNotificationsRow state="loading" onChange={() => {}} />
            <BrowserNotificationsRow state="blocked" onChange={() => {}} />
            <BrowserNotificationsRow state="appleMobile" onChange={() => {}} />
            <BrowserNotificationsRow state="off" problem="Couldn’t turn on browser notifications: the service couldn’t be reached." onChange={() => {}} />
          </SettingsGroup>
        </div>
      </Section>
      <Section title="MutedWorkspaces: one muted until a time (mute another, which is until it is unmuted and says nothing of when), with the way to mute another across from the title, which opens in place to those that could be, under a field to find one by; point at one to unmute it; while they load; when they could not be read; and with none muted and something that could not be done">
        <div className="flex w-full max-w-3xl flex-col gap-12">
          <MutedWorkspaces
            title="Muted workspaces"
            description="What muting one does, in a line under the title."
            muted={WORKSPACES.filter(({ id }) => quiet.includes(id)).map((workspace) => ({ ...workspace, until: workspace.id === 'design' ? 'Until Nov 18, 2026, 9:00 AM' : undefined }))}
            others={WORKSPACES.filter(({ id }) => !quiet.includes(id))}
            onMute={(id) => setQuiet((current) => [...current, id])}
            onUnmute={(id) => setQuiet((current) => current.filter((other) => other !== id))}
          />
          <MutedWorkspaces title="While they load" muted={[]} others={[]} loading onMute={() => {}} onUnmute={() => {}} />
          <MutedWorkspaces title="Not read" muted={[]} others={[]} failure="the server could not be reached" onMute={() => {}} onUnmute={() => {}} />
          <MutedWorkspaces title="With none" muted={[]} others={WORKSPACES} problem="Couldn’t mute the workspace." onMute={(id) => say(`muted ${id}`)} onUnmute={() => {}} />
        </div>
      </Section>
      <Section title="SkillRow, in a ScrollArea, which is as tall as three of them and draws its scrollbar over their ends: a skill as a list has it, which opens it: the viewer’s own with a tag, somebody else’s, the organization’s, one with nobody’s picture, tag or time, and one whose name and what it is for are too long. AddSkillDialog: a name and what it is for, without which it cannot be added, and a tag, offered from those there are; held while it is added, and open under why where it could not be (one called Weekly report)">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <ScrollArea className="max-h-48 rounded-3xl bg-kumo-tint">
            <div className="flex flex-col p-1.5">
              <SkillRow name="Summarize meeting notes" detail="Turn a transcript into decisions, owners and next steps." owner={{ kind: 'person', name: 'Ada Lovelace', you: true }} tag="Meetings" time="2h ago" onSelect={() => say('opened the skill')} />
              <SkillRow name="Weekly report" detail="How the team writes the weekly status report." owner={{ kind: 'person', name: 'Grace Hopper' }} tag="Reports" time="Nov 12" onSelect={() => say('opened the skill')} />
              <SkillRow name="Brand voice" detail="How the organization writes." owner={{ kind: 'organization' }} time="Oct 2" onSelect={() => say('opened the skill')} />
              <SkillRow name="Plan a trip" detail="Preferences for flights and hotels." onSelect={() => say('opened the skill')} />
              <SkillRow name="A skill with a name long enough that it has to be cut off somewhere along the line it is on" detail="And with so much to say of what it is for that it cannot all be said on the one line there is for it" tag="A tag that is long too" time="Sep 3" onSelect={() => say('opened the skill')} />
            </div>
          </ScrollArea>
          <div>
            <Button onClick={() => setAddingSkill(true)}>Add skill</Button>
          </div>
          <AddSkillDialog
            open={addingSkill}
            onOpenChange={setAddingSkill}
            tags={['Engineering', 'Meetings', 'Reports']}
            onAdd={async (skill) => {
              // As long as keeping it takes, and refused as one there is already would be.
              await new Promise((resolve) => setTimeout(resolve, 600))
              if (skill.name.toLowerCase() === 'weekly report') throw new Error('A skill is already there.')
              say(`added “${skill.name}”${skill.tag ? `, tagged ${skill.tag}` : ''}`)
              setAddingSkill(false)
            }}
          />
        </div>
      </Section>
      <Section title="Collections, a SkillRow each, as the Skills part of the settings lists them under the skills: the viewer’s own first, My skills ahead, one shared with others, one somebody shared with them, and the organization’s. AddCollectionDialog: a name, without which it cannot be made, and what it is for; held while it is made, and open under why where it could not be (one called Taken). AddSkillDialog from a collection’s page, which says where it goes in place of a tag">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <div className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
            <SkillRow name="My skills" detail="4 skills" owner={{ kind: 'person', name: 'Ada Lovelace', you: true }} onSelect={() => say('opened My skills')} />
            <SkillRow name="Design team" detail="2 skills · Shared" owner={{ kind: 'person', name: 'Ada Lovelace', you: true }} onSelect={() => say('opened Design team')} />
            <SkillRow name="Support playbook" detail="No skills · Shared by Grace Hopper" owner={{ kind: 'person', name: 'Grace Hopper' }} onSelect={() => say('opened Support playbook')} />
            <SkillRow name="Company" detail="12 skills · Organization" owner={{ kind: 'organization' }} onSelect={() => say('opened Company')} />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setMakingCollection(true)}>New collection</Button>
            <Button onClick={() => setAddingToCollection(true)}>Add skill to Design team</Button>
          </div>
          <AddCollectionDialog
            open={makingCollection}
            onOpenChange={setMakingCollection}
            onAdd={async ({ title }) => {
              await new Promise((resolve) => setTimeout(resolve, 600))
              if (title.toLowerCase() === 'taken') throw new Error('The Context Library refused it.')
              say(`made “${title}”`)
              setMakingCollection(false)
            }}
          />
          <AddSkillDialog
            open={addingToCollection}
            onOpenChange={setAddingToCollection}
            into="Design team"
            onAdd={(skill) => {
              say(`added “${skill.name}” to Design team`)
              setAddingToCollection(false)
            }}
          />
        </div>
      </Section>
      <Section title="SkillFileRow: a skill’s files, with the ways to download one and to take it out while it is pointed at: its instructions, which cannot be taken out, one in a folder, a picture, and one that is only downloaded, under a ListToolbar whose search is open all along. FileEditor: what is written in one, saved with Cmd or Ctrl and S, then one that is only read">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <div className="px-5">
            <ListToolbar noun="files" search={{ value: fileQuery, onChange: setFileQuery }} searchExpanded action={<Button variant="primary" onClick={() => say('chose files')}>Upload files</Button>} />
          </div>
          <ul className="flex flex-col rounded-3xl bg-kumo-tint p-1.5">
            <SkillFileRow path="SKILL.md" kind="text" detail="Markdown · 412 B" role="Instructions" onSelect={() => say('opened SKILL.md')} onDownload={() => say('downloaded SKILL.md')} />
            <SkillFileRow path="templates/summary.md" kind="text" detail="Markdown · 1.2 KB" onSelect={() => say('opened the template')} onDownload={() => say('downloaded the template')} onRemove={() => say('deleted the template')} />
            <SkillFileRow path="assets/a-diagram-with-a-name-long-enough-that-it-has-to-be-cut-off-somewhere-along-the-line-it-is-on.png" kind="image" detail="Image · 48 KB" onSelect={() => say('opened the picture')} onDownload={() => say('downloaded the picture')} onRemove={() => say('deleted the picture')} />
            <SkillFileRow path="data/archive.zip" kind="other" detail="ZIP file · 1.4 MB" onDownload={() => say('downloaded the archive')} onRemove={() => say('deleted the archive')} />
          </ul>
          <FileEditor aria-label="SKILL.md" value={fileText} onValueChange={setFileText} onSave={() => say('saved SKILL.md')} />
          <FileEditor aria-label="notes.txt" value={'Ana: the importer is done, review today.\nBen: blocked on the staging database.'} onValueChange={() => {}} readOnly />
        </div>
      </Section>
      <Section title="FilePreviewCard: a file as a card that opens it, with the start of what is in it: one with more than there is room for, which fades out, and more room than the rest have; a short one; and one there is nothing to show of. Tabs: with two that were opened between its own, each with the way to put it away, and one of them with something unsaved, which has a dot instead">
        <div className="flex w-full max-w-3xl flex-col gap-6">
          <Tabs
            value={skillTab}
            onValueChange={setSkillTab}
            aria-label="Skill"
            tabs={[
              { value: 'preview', label: 'Preview' },
              { value: 'files', label: 'Files' },
              ...openTabs.map((file) => ({ value: file, label: file, title: `templates/${file}`, unsaved: file === 'report.md', onClose: () => { setOpenTabs(openTabs.filter((other) => other !== file)); setSkillTab('preview') } })),
              { value: 'settings', label: 'Settings' },
            ]}
          >
            {['preview', 'files', 'settings', ...openTabs].map((value) => <Tabs.Panel key={value} value={value} className="text-center text-base text-kumo-subtle">{value}</Tabs.Panel>)}
          </Tabs>
          <ul className="flex flex-col gap-3">
            <FilePreviewCard path="SKILL.md" detail="Markdown · 2.1 KB" role="Instructions" tall onSelect={() => say('opened SKILL.md')}>
              <Markdown onTint>{'# Summarize meeting notes\n\n' + Array.from({ length: 24 }, (_, at) => `${at + 1}. List the decisions that were made, one line each, with \`code\` where it helps.`).join('\n') + '\n\n```\nA block of code\n```'}</Markdown>
            </FilePreviewCard>
            <FilePreviewCard path="templates/summary.md" detail="Markdown · 105 B" onSelect={() => say('opened the template')}>
              <Markdown onTint>{'## Decisions\n\n## Actions'}</Markdown>
            </FilePreviewCard>
            <FilePreviewCard path="data/archive.zip" detail="ZIP file · 1.4 MB" onSelect={() => say('opened the archive')} />
          </ul>
        </div>
      </Section>
      <Section title="ModelListItem: the deployment's, the user's own with the way to remove it, what each is used for, one known only by its id, and one being removed">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <SettingsGroup title="Models">
            <ul aria-label="Models" className="flex flex-col">
              <ModelListItem name="Claude Opus" id="anthropic/claude-opus" builtIn roles={['default']} />
              <ModelListItem name="Kimi K2.7 Code (Workers AI)" id="@cf/moonshotai/kimi-k2.7-code" builtIn roles={['default', 'quick']} />
              <ModelListItem name="My local Llama, with a name long enough that it has to be cut off somewhere along the line" id="ollama/llama-with-an-id-that-is-long-too" roles={['quick']} onEdit={() => say('opened it to edit')} onDuplicate={() => say('opened a duplicate')} onRemove={() => say('removed the model')} />
              <ModelListItem name="gpt-5.1-pro" id="gpt-5.1-pro" onEdit={() => say('opened it to edit')} onDuplicate={() => say('opened a duplicate')} onRemove={() => say('removed the model')} />
              <ModelListItem name="Being removed" id="openai/going" onRemove={() => {}} busy />
            </ul>
          </SettingsGroup>
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      </Section>
      <Section title="ModelDialog: adding one of the user's own models, whose fields follow the provider (a key, Workers AI's account, Ollama's address, and under More options an address, extra headers and limits), with no keys asked for where AI Gateway has its own; changing one, whose saved key and header say Saved and are kept unless typed over (change the address and they must be typed again); duplicating one, its key copied; while the model is read, and where it could not be. Saving fails for a model called taken, and what can't be kept says why once Add model is pressed. Under them, the line shown where the administrator turned adding models off">
        <div className="flex w-full max-w-3xl flex-col gap-3">
          <div className="flex flex-wrap gap-2">
            {MODEL_DIALOGS.map(({ label }, index) => (
              <Button key={label} onClick={() => { setModelDialog(index); setModelDialogOpen(true) }}>{label}</Button>
            ))}
          </div>
          {modelDialog !== undefined && (
            <ModelDialog
              key={modelDialog}
              open={modelDialogOpen}
              onOpenChange={setModelDialogOpen}
              {...MODEL_DIALOGS[modelDialog].props}
              onSave={async (save) => {
                // As long as keeping it takes, and refused as one there is already would be.
                await new Promise((resolve) => setTimeout(resolve, 600))
                if (save.profile.id === 'taken') throw new Error('You already have a model called taken.')
                // Whether a key is sent, never the key.
                const key = save.config.apiToken === null ? 'kept' : save.config.apiToken === '' ? 'none' : 'typed'
                const copied = save.kind === 'add' && save.copySecretsFrom ? `, saved keys copied from ${save.copySecretsFrom}` : ''
                say(`${save.kind === 'update' ? 'saved' : 'added'} ${save.profile.name} (${save.profile.id}), key ${key}${copied}`)
              }}
            />
          )}
          <SettingsGroup title="Your own models, turned off" plain>
            <SettingsCard>
              <p className="py-4 text-kumo-subtle">Your administrator has turned off adding your own models.</p>
            </SettingsCard>
          </SettingsGroup>
        </div>
        <p role="status" className="w-full text-sm text-kumo-subtle">{report}</p>
      </Section>
      <Section title="SettingsSidebar, expanded and on the rail, in the app's sidebar's place while the settings show (point at a part on the rail for its name); and SettingsMenu, the parts as a page of their own on a narrow screen">
        <div className="flex gap-4">
          {[false, true].map((collapsed) => (
            <div key={String(collapsed)} className={`flex h-[44rem] shrink-0 flex-col rounded-3xl bg-kumo-canvas p-2 ring-1 ring-kumo-line ${collapsed ? 'w-14' : 'w-64'}`}>
              <SettingsSidebar groups={GROUPS} current={part} onSelect={setPart} onClose={() => say('left the settings')} collapsed={collapsed} />
            </div>
          ))}
          <div className="h-[44rem] w-96 shrink-0 overflow-y-auto rounded-3xl bg-kumo-base px-3 ring-1 ring-kumo-line">
            <SettingsMenu user={{ name, detail: 'ada@example.com', avatarUrl: picture }} groups={GROUPS} onSelect={setPart} />
          </div>
        </div>
      </Section>
    </>
  )
}
