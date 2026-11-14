import { useEffect, useState } from 'react'
import { InputArea } from '@cloudflare/kumo'
import { CaretLeftIcon, ChatCircleTextIcon, DotsThreeIcon, LinkIcon, PencilSimpleIcon, ScrollIcon, TrashIcon, WarningCircleIcon } from '@phosphor-icons/react'
import { PaneNotice } from '@/blocks/PaneNotice'
import { Button } from '@/components/Button'
import { ConfirmDialog } from '@/components/ConfirmDialog'
import { DropdownMenu } from '@/components/DropdownMenu'
import { EditableTitle } from '@/components/EditableTitle'
import { HeaderBubble } from '@/components/HeaderBubble'
import { Markdown } from '@/components/Markdown'
import { useDocumentTitle } from '@/hooks/useDocumentTitle'
import { PageLayout } from '@/layouts/PageLayout'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { formatActivity } from '@/workspaces/formatActivity'
import { collectionDetail } from './skillGroups'
import { MAX_SKILL_DESCRIPTION, skillTitle } from './skillManifest'
import { useSkills } from './SkillsContext'
import type { SkillContent } from './SkillsLibrary'

export type SkillPaneProps = {
  skillId: string
  onBack: () => void
  /** Starts a chat with the skill chosen in its composer. */
  onUse: (skill: SkillContent) => void
  /** It was renamed, which moves it: show it where it is now. */
  onMoved: (skillId: string) => void
  /** It was deleted: go somewhere that is still there. */
  onDeleted: () => void
  /** Its own address, for Copy link. */
  link: string
}

type Read = { status: 'loading' } | { status: 'gone' } | { status: 'failed'; message: string } | { status: 'ready'; skill: SkillContent }

// As a phrase: "Changed 3 hours ago", "Changed yesterday", "Changed on Aug 1".
const changed = (when: Date) => {
  const at = formatActivity(when)
  return /^(Just now|Yesterday)$|ago$/.test(at) ? `Changed ${at.toLowerCase()}` : `Changed on ${at}`
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section className="flex flex-col gap-2">
    <h2 className="px-4 text-sm font-medium text-kumo-subtle">{title}</h2>
    {children}
  </section>
)

/**
 * One skill: its name in plain words, renamed in place, the name it is called by in a chat, where
 * it is kept, then when the agent uses it and what it says, rendered as written. Whoever may edit
 * its collection changes both at once with Edit, saved or let go of from the header; anyone can
 * start a chat with it.
 */
export const SkillPane = ({ skillId, onBack, onUse, onMoved, onDeleted, link }: SkillPaneProps) => {
  const { library, snapshot } = useSkills()
  const config = useServerConfig()
  const connection = useConnectionNotice()
  const [read, setRead] = useState<Read>({ status: 'loading' })
  const [editing, setEditing] = useState<{ description: string; instructions: string }>()
  const [saving, setSaving] = useState(false)
  const [problem, setProblem] = useState<string>()
  const [deleting, setDeleting] = useState(false)

  // Read again when the list changes, as it does after this or anything else changed it.
  const listed = snapshot.status === 'ready' ? snapshot.collections : undefined
  useEffect(() => {
    let current = true
    library.read(skillId).then(
      (skill) => { if (current) setRead(skill ? { status: 'ready', skill } : { status: 'gone' }) },
      // What was read stays up when reading it again fails.
      (error: unknown) => { if (current) setRead((was) => (was.status === 'ready' ? was : { status: 'failed', message: messageOf(error) })) },
    )
    return () => {
      current = false
    }
  }, [library, skillId, listed])

  const skill = read.status === 'ready' ? read.skill : undefined
  const collection = listed?.find(({ id }) => id === skill?.collectionId)
  const canEdit = collection?.permissions.canEdit ?? false
  const title = skill ? skillTitle(skill.name) : undefined
  useDocumentTitle(title ? `${title} · Skills` : 'Skill')

  const header = (
    <>
      <HeaderBubble>
        <Button icon={CaretLeftIcon} onClick={onBack}>Skills</Button>
      </HeaderBubble>
      {skill && (editing ? (
        <>
          <HeaderBubble className="ms-auto">
            <Button disabled={saving} onClick={() => { setEditing(undefined); setProblem(undefined) }}>Cancel</Button>
          </HeaderBubble>
          <HeaderBubble>
            <Button
              variant="primary"
              disabled={saving || !editing.description.trim()}
              onClick={() => {
                setProblem(undefined)
                if (connection?.blocked()) return
                setSaving(true)
                library.save(skill, editing).then(
                  () => setEditing(undefined),
                  (error: unknown) => setProblem(`Couldn’t save it: ${messageOf(error)}`),
                ).finally(() => setSaving(false))
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </HeaderBubble>
        </>
      ) : (
        <>
          {canEdit && (
            <HeaderBubble className="ms-auto">
              <Button icon={PencilSimpleIcon} onClick={() => setEditing({ description: skill.description, instructions: skill.instructions })}>Edit</Button>
            </HeaderBubble>
          )}
          <HeaderBubble className={canEdit ? undefined : 'ms-auto'}>
            <DropdownMenu icon={DotsThreeIcon} aria-label="More" align="end">
              <DropdownMenu.Item icon={LinkIcon} onSelect={() => navigator.clipboard.writeText(link).catch(() => {})}>Copy link</DropdownMenu.Item>
              {canEdit && <DropdownMenu.Item icon={TrashIcon} danger onSelect={() => setDeleting(true)}>Delete skill…</DropdownMenu.Item>}
            </DropdownMenu>
          </HeaderBubble>
          <HeaderBubble>
            <Button variant="primary" icon={ChatCircleTextIcon} onClick={() => onUse(skill)}>Use in a chat</Button>
          </HeaderBubble>
        </>
      ))}
    </>
  )

  if (read.status === 'gone' || read.status === 'failed') {
    return (
      <PageLayout header={header}>
        <div className="flex min-h-[60vh] flex-col">
          {read.status === 'gone'
            ? <PaneNotice icon={WarningCircleIcon} title="This skill isn’t here" description="It may have been deleted, renamed, or not shared with you." />
            : <PaneNotice icon={WarningCircleIcon} title="Couldn’t load the skill" description={read.message} action={{ label: 'Try again', onClick: () => library.restart() }} />}
        </div>
      </PageLayout>
    )
  }

  const where = collection && [collection.kind === 'mine' && listed?.filter(({ kind }) => kind === 'mine').length === 1 ? 'Yours' : `In ${collection.title}`, collectionDetail(collection, config?.siteName)].filter(Boolean).join(' · ')

  return (
    <PageLayout header={header}>
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-8 pb-8">
        <div className="flex flex-col items-center gap-2 pt-8 text-center">
          <span aria-hidden="true" className="grid size-9 place-items-center rounded-full bg-kumo-tint text-kumo-default [&>svg]:size-[1.125em]">
            <ScrollIcon />
          </span>
          <h1 className="flex max-w-full justify-center text-xl font-medium text-kumo-default">
            {skill && canEdit && !editing
              ? (
                  <EditableTitle
                    value={title!}
                    aria-label="Skill name"
                    placeholder="Untitled skill"
                    className="text-center"
                    onRename={(next) => {
                      setProblem(undefined)
                      if (connection?.blocked()) return
                      library.rename(skill, next).then(
                        (moved) => { if (moved !== skillId) onMoved(moved) },
                        (error: unknown) => setProblem(`Couldn’t rename it: ${messageOf(error)}`),
                      )
                    }}
                  />
                )
              : <span className="px-2.5 py-1">{title ?? 'Skill'}</span>}
          </h1>
          {skill && (
            <p className="appears text-base/5 text-kumo-subtle">
              <span className="text-kumo-default">/{skill.name}</span>
              {where && ` · ${where}`}
              {` · ${changed(skill.lastUpdated)}`}
            </p>
          )}
          {collection && !canEdit && <p className="appears max-w-sm text-sm/5 text-kumo-subtle">You can use it, but only whoever edits {collection.title} can change it.</p>}
          {problem && <p role="alert" className="text-base text-kumo-danger">{problem}</p>}
        </div>
        {read.status === 'loading' && <p role="status" className="appears-late px-4 text-center text-base text-kumo-subtle">Loading the skill…</p>}
        {skill && (
          <div className="appears flex flex-col gap-8">
            <Section title="When the agent uses it">
              {editing ? (
                <InputArea
                  aria-label="When the agent uses it"
                  value={editing.description}
                  onChange={(event) => setEditing({ ...editing, description: event.target.value })}
                  rows={3}
                  maxLength={MAX_SKILL_DESCRIPTION}
                  disabled={saving}
                  className="rounded-3xl px-4 py-3 text-base/6"
                />
              ) : (
                <p className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-default">{skill.description}</p>
              )}
            </Section>
            <Section title="What it says">
              {editing ? (
                <InputArea
                  aria-label="What it says"
                  value={editing.instructions}
                  onChange={(event) => setEditing({ ...editing, instructions: event.target.value })}
                  autoResize
                  minRows={12}
                  disabled={saving}
                  className="rounded-3xl px-4 py-3 font-mono text-sm/6"
                />
              ) : (
                <div className="rounded-3xl bg-kumo-tint px-5 py-4 text-base/6 text-kumo-default">
                  {skill.instructions.trim() ? <Markdown>{skill.instructions}</Markdown> : <p className="text-kumo-subtle">It says nothing yet.</p>}
                </div>
              )}
            </Section>
          </div>
        )}
      </div>
      <ConfirmDialog
        open={deleting}
        onOpenChange={setDeleting}
        destructive
        title={`Delete ${title ?? 'this skill'}?`}
        description="The agent stops using it, in every chat, for everyone it’s shared with. This can’t be undone."
        confirm="Delete skill"
        onConfirm={async () => {
          if (!skill || connection?.blocked()) return false
          await library.remove(skill)
          onDeleted()
        }}
      />
    </PageLayout>
  )
}
