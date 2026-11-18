import { useRef, useState, type ChangeEvent } from 'react'
import { FolderSimpleIcon, PencilSimpleIcon, UploadSimpleIcon } from '@phosphor-icons/react'
import { AddSkillDialog } from '@/blocks/AddSkillDialog'
import { Banner } from '@/components/Banner'
import { ListToolbar } from '@/blocks/ListToolbar'
import { SettingsGroup } from '@/blocks/SettingsGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { DropdownMenu } from '@/components/DropdownMenu'
import { ENOUGH } from '@/components/listView'
import { ScrollArea } from '@/components/ScrollArea'
import { useListView } from '@/hooks/useListView'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { formatActivity } from '@/workspaces/formatActivity'
import { skillList, skillOwner } from './skillList'
import { uploadSkills } from './uploadSkills'
import { skillStore, useSkillsState } from './useSkills'

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

export type SkillLibraryProps = {
  onOpenSkill: (id: string) => void
  /** A skill's page, for its row to link to so that it can be opened in another tab. */
  skillHref?: (id: string) => string
}

/**
 * The user's skills, as any list in the app is, but for its groups: one flat list in the order
 * chosen, all on one surface, under a search, the order, the filters and the way to add one. They are rows only: a skill is a name and a line
 * about it, which a card has nothing to add to. What a skill used to be collected in is a tag on
 * it, which the list can be grouped and narrowed by, and whose it is is a picture: theirs, or the
 * organization's mark. A row opens the skill's own page. The collections themselves, which are
 * what is shared, are listed under it (`SkillCollections`).
 *
 * One is added by writing it, or from files: each Markdown file chosen is a skill, and a folder
 * with a `SKILL.md` is one with everything in it (`prepareSkillUploads`). One added alone is
 * opened, to be gone on with.
 *
 * They are the user's Context Library's (see `SkillStore`), which a user who has none is offered
 * where the deployment does. The controls are over the list on a narrow screen too, as it is one
 * group among the page's others, not the page.
 */
export const SkillLibrary = ({ onOpenSkill, skillHref }: SkillLibraryProps) => {
  const state = useSkillsState()
  const skills = state.status === 'ready' ? state.skills : skillStore.skills
  const { user } = useApi()
  const connection = useConnectionNotice()
  const [writing, setWriting] = useState(false)
  // Why what was chosen made no skills.
  const [problem, setProblem] = useState<string>()
  const filesRef = useRef<HTMLInputElement>(null)
  const folderRef = useRef<HTMLInputElement>(null)

  const list = useListView('skills', skillList(skills))
  const shown = list.narrow(skills)
  // Always as rows, whatever view was kept for it: it has no other. And on the one surface, in the
  // order chosen: it is one group among the settings' others, not a page to be divided up. Plain
  // rows, then, on the surface that scrolls them: there are no groups for them to move between.
  const rows = list.order
    .arrange(shown, ENOUGH.list)
    .flatMap(({ entries }) => entries)
    .map(({ value, time }) => (
      <li key={value.id}>
        <SkillRow
          name={value.name}
          detail={value.description}
          owner={skillOwner(value, user.name)}
          tag={value.tag}
          time={time ?? formatActivity(value.updated)}
          href={skillHref?.(value.id)}
          onSelect={() => onOpenSkill(value.id)}
        />
      </li>
    ))
  const { search, order, filter } = list.controls

  const turnOn = () => {
    if (connection?.blocked()) return
    setProblem(undefined)
    skillStore.turnOn().catch((error: unknown) => setProblem(`Couldn’t turn on skills: ${messageOf(error)}`))
  }

  const upload = async ({ target }: ChangeEvent<HTMLInputElement>) => {
    const chosen = [...(target.files ?? [])]
    // So that choosing the same again is a change.
    target.value = ''
    if (chosen.length === 0 || connection?.blocked()) return
    setProblem(undefined)
    try {
      const ids = await uploadSkills(chosen)
      if (ids.length === 1) onOpenSkill(ids[0])
    } catch (error) {
      setProblem(messageOf(error))
    }
  }

  return (
    <SettingsGroup title="Skill library" description="Reusable instructions the assistant loads when a task calls for them." plain>
      {/* In from the edge as far as the group's title is, and as what is done to a group across from its title is. */}
      <div className="px-5">
        <ListToolbar
          noun="skills"
          search={search}
          order={order}
          filter={filter}
          action={(
            <DropdownMenu label="Add skill" caret triggerVariant="primary" align="end" inPlace>
              <DropdownMenu.Item icon={PencilSimpleIcon} onSelect={() => setWriting(true)}>Write a skill</DropdownMenu.Item>
              <DropdownMenu.Item icon={UploadSimpleIcon} onSelect={() => filesRef.current?.click()}>Upload files</DropdownMenu.Item>
              <DropdownMenu.Item icon={FolderSimpleIcon} onSelect={() => folderRef.current?.click()}>Upload a folder</DropdownMenu.Item>
            </DropdownMenu>
          )}
        />
      </div>
      <input ref={filesRef} type="file" multiple accept=".md,.markdown,text/markdown" hidden onChange={(event) => void upload(event)} />
      {/* A folder is chosen whole, which no standard attribute asks for. */}
      <input ref={folderRef} type="file" multiple hidden onChange={(event) => void upload(event)} {...{ webkitdirectory: '' }} />
      {problem && <p role="alert" className="px-5 text-base text-kumo-danger">{problem}</p>}
      {state.status === 'loading' && skills.length === 0 && <p role="status" className="appears-late px-5 text-base text-kumo-subtle">Loading skills…</p>}
      {state.status === 'failed' && (
        <p className="flex items-center gap-3 px-5 text-base text-kumo-subtle">
          Couldn’t load skills: {state.message}
          <Button variant="ghost" onClick={() => void skillStore.reload()}>Try again</Button>
        </p>
      )}
      {state.status === 'off' && (
        // They are kept in the Context Library, which a user has an account in once they turn it on.
        <div className="px-5">
          <Banner
            title="Skills aren’t turned on for you"
            description={state.canTurnOn ? 'They’re kept in your Context Library, which you can turn on here.' : 'They’re kept in the Context Library, which this deployment doesn’t offer you.'}
            action={state.canTurnOn ? { label: 'Turn on', onSelect: turnOn } : undefined}
          />
        </div>
      )}
      {state.status === 'ready' && skills.length === 0 && <p className="px-5 text-center text-base text-kumo-subtle">No skills yet.</p>}
      {skills.length > 0 && shown.length === 0 && (
        <p className="flex items-center justify-center gap-3 px-5 text-base text-kumo-subtle">
          Nothing matches.
          <Button variant="ghost" onClick={list.showAll}>Show all</Button>
        </p>
      )}
      {shown.length > 0 && (
        // Another order is another list, faded to rather than moved to row by row. No taller than
        // ten rows or so, or than most of the window: the rest are scrolled to, so that the group
        // under it is not pushed out of reach.
        <ScrollArea key={list.order.id} className="appears max-h-[min(40rem,70dvh)] rounded-3xl bg-kumo-tint">
          <ul aria-label="Skills" className="flex flex-col p-1.5">
            {rows}
          </ul>
        </ScrollArea>
      )}
      <AddSkillDialog
        open={writing}
        onOpenChange={setWriting}
        // Their own, which they can write in; their first (My skills) first.
        collections={state.status === 'ready'
          ? state.collections.filter(({ source }) => source.kind === 'mine').toSorted((a, b) => Number(b.untagged) - Number(a.untagged)).map(({ id, title }) => ({ id, title }))
          : []}
        onAdd={async (skill) => {
          if (connection?.blocked()) return
          const id = await skillStore.add(skill)
          setWriting(false)
          onOpenSkill(id)
        }}
      />
    </SettingsGroup>
  )
}
