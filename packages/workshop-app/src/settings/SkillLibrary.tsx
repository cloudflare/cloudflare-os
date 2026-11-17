import { useRef, useState } from 'react'
import { AddSkillDialog } from '@/blocks/AddSkillDialog'
import { ListToolbar } from '@/blocks/ListToolbar'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { GroupedList } from '@/components/GroupedList'
import { ENOUGH } from '@/components/listView'
import { useListView } from '@/hooks/useListView'
import { formatActivity } from '@/workspaces/formatActivity'
import { skillDetail, skillList, skillTags, type Skill } from './skillList'

const daysAgo = (days: number) => new Date(Date.now() - days * 24 * 60 * 60 * 1000)

// What the skills will read like, to start with, until they can be read for real.
const EXAMPLE_SKILLS: Skill[] = [
  { id: 'notes', name: 'Summarize meeting notes', description: 'Turn a transcript into decisions, owners and next steps.', tag: 'Meetings', source: { kind: 'mine' }, updated: daysAgo(0.2) },
  { id: 'inbox', name: 'Triage my inbox', description: 'Which mail to flag, file or draft a reply to.', tag: 'Support', source: { kind: 'mine' }, updated: daysAgo(1) },
  { id: 'email', name: 'Draft a customer email', description: 'Reply in our support voice, with the right sign-off.', tag: 'Support', source: { kind: 'mine' }, updated: daysAgo(3) },
  { id: 'report', name: 'Weekly report', description: 'How the team writes the weekly status report.', tag: 'Reports', source: { kind: 'shared', by: 'Grace Hopper' }, updated: daysAgo(5) },
  { id: 'voice', name: 'Brand voice', description: 'Tone, wording and spelling for anything customer-facing.', tag: 'Writing', source: { kind: 'organization' }, updated: daysAgo(9) },
  { id: 'review', name: 'Review a pull request', description: 'What to check, and how to phrase feedback.', tag: 'Engineering', source: { kind: 'mine' }, updated: daysAgo(16) },
  { id: 'incident', name: 'Incident write-up', description: 'The post-incident review template, and what goes in each part.', tag: 'Engineering', source: { kind: 'organization' }, updated: daysAgo(40) },
  { id: 'trip', name: 'Plan a trip', description: 'Preferences for flights and hotels, and how to lay out an itinerary.', source: { kind: 'mine' }, updated: daysAgo(75) },
]

/**
 * The user's skills, as any list in the app is: one flat list in the order chosen, under a search,
 * the order, the filters and the way to add one. They are rows only: a skill is a name and a line
 * about it, which a card has nothing to add to. What a skill used to be collected
 * in is a tag on it, which the list can be grouped and narrowed by. A skill is not opened from
 * here yet.
 *
 * None of it is there yet: the Workshop's API has no skills of the user's to read or write (they
 * are the Context Library's, which has its own app), so these are examples, and one added is kept
 * nowhere. The controls are over the list on a narrow screen too, as it is one group among the
 * page's others, not the page.
 */
export const SkillLibrary = () => {
  const [skills, setSkills] = useState(EXAMPLE_SKILLS)
  const [adding, setAdding] = useState(false)
  // How many were added, which names each.
  const added = useRef(0)
  const list = useListView('skills', skillList(skills))
  const shown = list.narrow(skills)
  // Always as rows, whatever view was kept for it: it has no other.
  const groups = list.order.arrange(shown, ENOUGH.list).map(({ key, label, entries }) => ({
    key: `${list.order.id}:${key}`,
    label,
    rows: entries.map(({ value, time }) => ({
      key: value.id,
      content: <SkillRow name={value.name} detail={skillDetail(value)} tag={value.tag} time={time ?? formatActivity(value.updated)} />,
    })),
  }))
  const { search, order, filter } = list.controls

  return (
    <SettingsGroup title="Skill library" description="Reusable instructions the assistant loads when a task calls for them." soon plain>
      {/* In from the edge as far as the group's title is, and as what is done to a group across from its title is. */}
      <div className="px-5">
        <ListToolbar noun="skills" search={search} order={order} filter={filter} action={<Button variant="primary" onClick={() => setAdding(true)}>Add skill</Button>} />
      </div>
      {skills.length === 0 && <p className="px-5 text-center text-base text-kumo-subtle">No skills yet.</p>}
      {skills.length > 0 && shown.length === 0 && (
        <p className="flex items-center justify-center gap-3 px-5 text-base text-kumo-subtle">
          Nothing matches.
          <Button variant="ghost" onClick={list.showAll}>Show all</Button>
        </p>
      )}
      {shown.length > 0 && (
        // Another order is another list, faded to rather than moved to row by row.
        <div key={list.order.id} className="appears">
          <GroupedList groups={groups} />
        </div>
      )}
      <AddSkillDialog
        open={adding}
        onOpenChange={setAdding}
        tags={skillTags(skills)}
        onAdd={(skill) => {
          const id = `added-${(added.current += 1)}`
          setSkills((current) => [...current, { ...skill, id, source: { kind: 'mine' }, updated: new Date() }])
          setAdding(false)
        }}
      />
    </SettingsGroup>
  )
}
