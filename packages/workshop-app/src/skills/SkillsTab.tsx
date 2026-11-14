import { useState } from 'react'
import { ArrowSquareOutIcon, ArrowUpRightIcon, ChatCircleTextIcon, FolderPlusIcon, LinkIcon, PencilSimpleIcon, ScrollIcon, SignOutIcon, TrashIcon } from '@phosphor-icons/react'
import type { LibraryAction } from '@/blocks/LibraryRow'
import { NewSkillDialog } from '@/blocks/NewSkillDialog'
import { PaneNotice } from '@/blocks/PaneNotice'
import { SkillGroup } from '@/blocks/SkillGroup'
import { SkillRow } from '@/blocks/SkillRow'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { NameDialog } from '@/components/NameDialog'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { formatActivity } from '@/workspaces/formatActivity'
import { ShareSkillsDialog } from './ShareSkillsDialog'
import { collectionDetail, skillGroups } from './skillGroups'
import { skillNameFor, skillTitle } from './skillManifest'
import { useSkills } from './SkillsContext'
import type { Skill, SkillCollection } from './SkillsLibrary'

export type SkillsTabProps = {
  sort: 'recent' | 'name'
  query: string
  /** New skill was asked for, from the page's header. */
  creating: boolean
  onCreatingChange: (creating: boolean) => void
  onOpenSkill: (skillId: string) => void
  /** A skill's page, for its row to link to so that it can be opened in another tab. */
  skillHref?: (skillId: string) => string
  /** Starts a chat with the skill chosen in its composer. */
  onUse: (skill: Skill) => void
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const copyLink = (href: string) => {
  // Refused without permission, and missing on a page not served securely: nothing is copied.
  navigator.clipboard.writeText(new URL(href, window.location.href).href).catch(() => {})
}

/**
 * The Library's Skills tab: every skill the user's agent can use, in the collections they are kept
 * in, the user's own first, then those shared with them, then the deployment's. Each opens as its
 * own page; a collection is shared, renamed, left or deleted from its heading. Search and the order
 * are the Library's. Skills a user has never had are offered once, with one click.
 */
export const SkillsTab = ({ sort, query, creating, onCreatingChange, onOpenSkill, skillHref, onUse }: SkillsTabProps) => {
  const { library, snapshot } = useSkills()
  const config = useServerConfig()
  const connection = useConnectionNotice()
  const [problem, setProblem] = useState<string>()
  const [sharing, setSharing] = useState<SkillCollection>()
  const [renaming, setRenaming] = useState<SkillCollection>()
  const [naming, setNaming] = useState(false)
  const [deleting, setDeleting] = useState<{ skill: Skill } | { collection: SkillCollection }>()
  // What is asked about, kept while its dialog closes so its words do not change as it goes.
  const [asked, setAsked] = useState(deleting)
  const [turningOn, setTurningOn] = useState(false)

  const act = (doing: string, run: () => Promise<unknown>) => {
    setProblem(undefined)
    if (connection?.blocked()) return
    run().catch((error: unknown) => setProblem(`Couldn’t ${doing}: ${messageOf(error)}`))
  }

  if (snapshot.status === 'loading') return <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading your skills…</p>
  if (snapshot.status === 'failed') {
    return (
      <p className="flex items-center justify-center gap-3 px-4 text-base text-kumo-subtle">
        Couldn’t load your skills: {snapshot.message}
        <Button variant="ghost" onClick={() => library.restart()}>Try again</Button>
      </p>
    )
  }
  if (snapshot.status === 'off') {
    return (
      <div className="flex min-h-[40vh] flex-col">
        <PaneNotice
          icon={ScrollIcon}
          title="Skills are off for you"
          description={snapshot.canTurnOn
            ? 'A skill is how you like something done, which the agent follows when what you ask fits. Turn them on to write your own and use your team’s.'
            : 'This deployment doesn’t offer skills.'}
          action={snapshot.canTurnOn ? {
            label: turningOn ? 'Turning on…' : 'Turn on skills',
            onClick: () => {
              if (turningOn || connection?.blocked()) return
              setTurningOn(true)
              library.turnOn().catch((error: unknown) => setProblem(`Couldn’t turn on skills: ${messageOf(error)}`)).finally(() => setTurningOn(false))
            },
          } : undefined}
        />
        {problem && <p role="alert" className="px-4 text-center text-base text-kumo-subtle">{problem}</p>}
      </div>
    )
  }

  const { collections } = snapshot
  const groups = skillGroups(collections, { sort, query })
  const writable = collections.filter(({ permissions }) => permissions.canEdit)
  const ownCount = collections.filter(({ kind }) => kind === 'mine').length
  const nothing = collections.every(({ skills }) => skills.length === 0)

  const skillActions = (skill: Skill, collection: SkillCollection): LibraryAction[] => {
    const href = skillHref?.(skill.id)
    return [
      { key: 'open', label: 'Open', icon: ArrowUpRightIcon, onSelect: () => onOpenSkill(skill.id) },
      { key: 'use', label: 'Use in a new chat', icon: ChatCircleTextIcon, onSelect: () => onUse(skill) },
      ...(href
        ? [
            { key: 'tab', label: 'Open in new tab', icon: ArrowSquareOutIcon, onSelect: () => window.open(href, '_blank', 'noopener') },
            { key: 'link', label: 'Copy link', icon: LinkIcon, onSelect: () => copyLink(href) },
          ]
        : []),
      ...(collection.permissions.canEdit
        ? [{ key: 'delete', label: 'Delete skill…', icon: TrashIcon, onSelect: () => { setDeleting({ skill }); setAsked({ skill }) } }]
        : []),
    ]
  }

  const collectionActions = (collection: SkillCollection): LibraryAction[] => [
    ...(collection.permissions.canEdit && collection.kind !== 'everyone'
      ? [{ key: 'rename', label: 'Rename…', icon: PencilSimpleIcon, onSelect: () => setRenaming(collection) }]
      : []),
    ...(collection.kind === 'shared'
      ? [{ key: 'leave', label: 'Leave', icon: SignOutIcon, onSelect: () => act('leave it', () => library.leaveCollection(collection.id)) }]
      : []),
    ...(collection.permissions.canDelete && collection.kind !== 'shared'
      ? [{ key: 'delete', label: 'Delete collection…', icon: TrashIcon, onSelect: () => { setDeleting({ collection }); setAsked({ collection }) } }]
      : []),
  ]

  // The viewer's only collection is theirs without a name to tell it from others.
  const titleOf = (collection: SkillCollection) => (collection.kind === 'mine' && ownCount === 1 ? 'Yours' : collection.title)

  return (
    <>
      {problem && <p role="alert" className="px-4 text-base text-kumo-subtle">{problem}</p>}
      {nothing && query.trim() === '' && (
        <div className="appears flex flex-col items-center gap-3 px-4 py-6 text-center">
          <p className="max-w-sm text-base/6 text-kumo-subtle">
            A skill is how you like something done: a brief before a meeting, the shape of a weekly update. The agent follows it when what you ask fits, or when you call it by name with <span className="text-kumo-default">/</span>.
          </p>
          <Button variant="primary" icon={ScrollIcon} onClick={() => onCreatingChange(true)}>Write a skill</Button>
        </div>
      )}
      {groups.length === 0 && query.trim() !== '' && (
        <p className="appears px-4 text-center text-base text-kumo-subtle">No skill is called “{query.trim()}”.</p>
      )}
      {groups.map(({ collection, skills }) => (
        <SkillGroup
          key={collection.id}
          title={titleOf(collection)}
          icon={collection.icon}
          detail={collectionDetail(collection, config?.siteName)}
          onShare={collection.permissions.canShare ? () => setSharing(collection) : undefined}
          actions={collectionActions(collection)}
        >
          {skills.length === 0 ? (
            <p className="px-3 py-3 text-base text-kumo-subtle">Nothing here yet. New skills you write go here.</p>
          ) : skills.map((skill) => (
            <SkillRow
              key={skill.id}
              title={skillTitle(skill.name)}
              description={skill.description}
              time={formatActivity(skill.lastUpdated)}
              actions={skillActions(skill, collection)}
              href={skillHref?.(skill.id)}
              onSelect={() => onOpenSkill(skill.id)}
            />
          ))}
        </SkillGroup>
      ))}
      {ownCount > 0 && query.trim() === '' && (
        <div className="flex justify-center">
          <Button variant="ghost" icon={FolderPlusIcon} onClick={() => setNaming(true)} className="text-kumo-subtle">New collection</Button>
        </div>
      )}

      <NewSkillDialog
        open={creating}
        onOpenChange={onCreatingChange}
        collections={writable.map((collection) => ({ id: collection.id, title: titleOf(collection) }))}
        nameOf={skillNameFor}
        onCreate={async (skill) => {
          if (connection?.blocked()) return false
          onOpenSkill(await library.create(skill))
          return true
        }}
      />
      <NameDialog
        open={naming}
        onOpenChange={setNaming}
        title="New collection"
        description="Keep skills together to share them as one, such as with your team."
        label="Name"
        placeholder="Design team"
        confirm="Create"
        onSubmit={async (name) => {
          if (connection?.blocked()) return false
          await library.createCollection(name)
        }}
      />
      {renaming && (
        <NameDialog
          key={renaming.id}
          open
          onOpenChange={(open) => !open && setRenaming(undefined)}
          title="Rename collection"
          label="Name"
          initial={renaming.title}
          confirm="Rename"
          onSubmit={async (name) => {
            if (connection?.blocked()) return false
            await library.renameCollection(renaming.id, name)
          }}
        />
      )}
      {sharing && (
        <ShareSkillsDialog
          key={sharing.id}
          library={library}
          collection={sharing}
          open
          onOpenChange={(open) => !open && setSharing(undefined)}
        />
      )}
      <ConfirmDialog
        open={deleting !== undefined}
        onOpenChange={(open) => !open && setDeleting(undefined)}
        destructive
        title={asked && 'skill' in asked ? `Delete ${skillTitle(asked.skill.name)}?` : `Delete ${asked ? titleOf(asked.collection) : 'the collection'}?`}
        description={asked && 'skill' in asked
          ? 'The agent stops using it, in every chat, for everyone it’s shared with. This can’t be undone.'
          : 'Its skills go with it, for everyone it’s shared with. This can’t be undone.'}
        confirm={asked && 'skill' in asked ? 'Delete skill' : 'Delete collection'}
        onConfirm={async () => {
          if (!deleting || connection?.blocked()) return false
          if ('skill' in deleting) await library.remove(deleting.skill)
          else await library.deleteCollection(deleting.collection.id)
        }}
      />
    </>
  )
}
