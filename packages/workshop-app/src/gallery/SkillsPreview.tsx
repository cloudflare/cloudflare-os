import { useState } from 'react'
import { ArrowSquareOutIcon, ChatCircleTextIcon, LinkIcon, PencilSimpleIcon, SignOutIcon, TrashIcon } from '@phosphor-icons/react'
import { Composer } from '@/blocks/Composer'
import { ComposerCommandLine } from '@/blocks/ComposerCommandLine'
import { ComposerCommandPicker, type ComposerCommand } from '@/blocks/ComposerCommandPicker'
import type { LibraryAction } from '@/blocks/LibraryRow'
import { NewSkillDialog } from '@/blocks/NewSkillDialog'
import { SkillGroup } from '@/blocks/SkillGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { NameDialog } from '@/components/NameDialog'
import { useReport } from './previewState'
import { Section } from './Section'

const BRIEF: ComposerCommand = { key: 'brief', name: 'meeting-brief', title: 'Meeting brief', description: 'Before a meeting, gather who is coming and what was last said.', kind: 'skill', source: 'My skills' }
const COMMANDS: ComposerCommand[] = [
  BRIEF,
  { key: 'weekly', name: 'weekly-update', title: 'Weekly update', description: 'Write the week up for a manager, from what changed.', kind: 'skill', source: 'For everyone at Acme' },
  { key: 'compact', name: 'compact', title: 'Compact', description: 'Sum up the chat so far, to make room for more', kind: 'builtin' },
]

const SKILLS = [
  { key: 'brief', title: 'Meeting brief', description: 'Before a meeting, gather who is coming, what was last said, and what is still open.', time: '2 hours ago' },
  { key: 'weekly', title: 'Weekly update', description: 'Write the week up for a manager from the changes merged since Monday, in five bullets or fewer.', time: 'Yesterday' },
]

// A name as a skill is called by: lowercase words joined by hyphens.
const nameOf = (title: string) => title.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 64)

/**
 * The Library's Skills tab, made of its collections, each headed with who has it, and their skills;
 * the dialogs that write a skill and name a collection; and in the composer, the picker a slash
 * opens and the line a chosen skill sits on, including when files are attached that cannot go
 * with it.
 */
export const SkillsPreview = () => {
  const { report, say, later } = useReport()
  const [creating, setCreating] = useState(false)
  const [naming, setNaming] = useState(false)
  const [highlighted, setHighlighted] = useState(0)
  const [chosen, setChosen] = useState<ComposerCommand | undefined>(BRIEF)
  const skillActions = (title: string): LibraryAction[] => [
    { key: 'open', label: 'Open', icon: ArrowSquareOutIcon, onSelect: () => say(`opened ${title}`) },
    { key: 'use', label: 'Use in a new chat', icon: ChatCircleTextIcon, onSelect: () => say(`started a chat with ${title}`) },
    { key: 'link', label: 'Copy link', icon: LinkIcon, onSelect: () => say(`copied a link to ${title}`) },
    { key: 'delete', label: 'Delete skill…', icon: TrashIcon, onSelect: () => say(`asked to delete ${title}`) },
  ]

  return (
    <>
      <Section title="SkillGroup + SkillRow (the Library’s Skills tab: one collection of yours, shared, and one for everyone)">
        <div className="flex w-full flex-col gap-6">
          <SkillGroup
            title="Yours"
            detail="Shared"
            onShare={() => say('opened sharing for Yours')}
            actions={[
              { key: 'rename', label: 'Rename…', icon: PencilSimpleIcon, onSelect: () => setNaming(true) },
              { key: 'delete', label: 'Delete collection…', icon: TrashIcon, onSelect: () => say('asked to delete the collection') },
            ]}
          >
            {SKILLS.map((skill) => (
              <SkillRow key={skill.key} title={skill.title} description={skill.description} time={skill.time} actions={skillActions(skill.title)} href="#" onSelect={() => say(`opened ${skill.title}`)} />
            ))}
          </SkillGroup>
          <SkillGroup title="Company playbooks" icon="📘" detail="For everyone at Acme" actions={[{ key: 'leave', label: 'Leave', icon: SignOutIcon, onSelect: () => say('left Company playbooks') }]}>
            <SkillRow title="Incident review" description="Turn an incident channel into a timeline, a cause and what changes next." time="Oct 27" actions={skillActions('Incident review')} onSelect={() => say('opened Incident review')} />
          </SkillGroup>
          <SkillGroup title="Design team" detail="Shared with you to use" actions={[]}>
            <p className="px-3 py-3 text-base text-kumo-subtle">Nothing here yet.</p>
          </SkillGroup>
          <p role="status" className="text-sm text-kumo-subtle">{report}</p>
        </div>
      </Section>
      <Section title="NewSkillDialog (its name, the /name it is called by, when to use it, what it says; where it goes, when there is a choice) + NameDialog">
        <Button onClick={() => setCreating(true)}>New skill</Button>
        <Button onClick={() => setNaming(true)}>Rename a collection</Button>
        <NewSkillDialog
          open={creating}
          onOpenChange={setCreating}
          collections={[{ id: 'mine', title: 'My skills' }, { id: 'team', title: 'Design team' }]}
          nameOf={nameOf}
          onCreate={async ({ title }) => {
            await later()
            say(`made ${title}`)
            return true
          }}
        />
        <NameDialog
          open={naming}
          onOpenChange={setNaming}
          title="Rename collection"
          label="Name"
          initial="My skills"
          confirm="Rename"
          onSubmit={async (name) => {
            await later()
            say(`renamed it ${name}`)
          }}
        />
      </Section>
      <Section title="ComposerCommandPicker + ComposerCommandLine (what a slash offers, and the skill a draft goes with)">
        <div className="flex w-full flex-col gap-3">
          <div className="relative mt-56 h-12 w-full rounded-[21px] ring-1 ring-kumo-line">
            <ComposerCommandPicker id="gallery-picker" commands={COMMANDS} highlighted={highlighted} onHighlight={setHighlighted} onChoose={(command) => setChosen(command)} />
          </div>
          <div className="w-full overflow-clip rounded-[21px] bg-kumo-elevated pb-1.5 ring-1 ring-kumo-line">
            <ComposerCommandLine command={chosen} onCancel={() => setChosen(undefined)} />
          </div>
          <div className="w-full overflow-clip rounded-[21px] bg-kumo-elevated pb-1.5 ring-1 ring-kumo-line">
            <ComposerCommandLine command={BRIEF} refusal="Files can’t go with a skill. Remove them, or the skill." onCancel={() => {}} />
          </div>
          {!chosen && <Button onClick={() => setChosen(BRIEF)}>Choose Meeting brief again</Button>}
        </div>
      </Section>
      <Section title="Composer (started with a skill, as “Use in a chat” starts one)">
        <div className="w-full">
          <Composer
            onSend={(text, _files, command) => {
              say(command ? `used ${command.title}${text ? ` with “${text}”` : ''}` : `sent “${text}”`)
              return true
            }}
            initialDraft={{ text: '', files: [], command: BRIEF }}
            commands={COMMANDS}
          />
        </div>
      </Section>
    </>
  )
}
