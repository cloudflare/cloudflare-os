import { useEffect, useRef, useState } from 'react'
import { Switch } from '@cloudflare/kumo'
import type { ContextCollectionRole, ContextCollectionSharing } from '@gadgets/gatekeeper-context/src/context-types'
import { AccessMenu, type AccessChoice } from '@/blocks/AccessMenu'
import { InviteField } from '@/blocks/InviteField'
import { ShareList } from '@/blocks/ShareList'
import { ShareNote } from '@/blocks/ShareNote'
import { SharePersonRow } from '@/blocks/SharePersonRow'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { useUserSearch } from '@/sharing/useUserSearch'
import type { SkillCollection, SkillsLibrary } from './SkillsLibrary'

export type ShareSkillsDialogProps = {
  library: SkillsLibrary
  collection: SkillCollection
  open: boolean
  onOpenChange: (open: boolean) => void
}

const ROLES: readonly AccessChoice<ContextCollectionRole>[] = [
  { value: 'viewer', label: 'Can use', hint: 'Their agent uses its skills.' },
  { value: 'editor', label: 'Can edit', hint: 'They change its skills and share it.' },
]
const OWNER: AccessChoice<ContextCollectionRole> = { value: 'owner', label: 'Owner', hint: 'They can also delete it.' }
const LABELS: Record<ContextCollectionRole, string> = { viewer: 'Can use', editor: 'Can edit', owner: 'Owner' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
type Feedback = { tone: 'success' | 'error'; message: string }

/**
 * Who a collection of skills is shared with, and the way to share it with more: by name, each to
 * use its skills or to edit them too, and, as one switch, everyone in the deployment. What is
 * changed is read back from the gatekeeper, which says why when it refuses.
 */
export const ShareSkillsDialog = ({ library, collection, open, onOpenChange }: ShareSkillsDialogProps) => {
  const config = useServerConfig()
  const connection = useConnectionNotice()
  const input = useRef<HTMLInputElement>(null)
  const [sharing, setSharing] = useState<ContextCollectionSharing>()
  const [loadProblem, setLoadProblem] = useState<string>()
  const [value, setValue] = useState('')
  const [role, setRole] = useState<ContextCollectionRole>('viewer')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  const owners = collection.permissions.canManageOwners
  const choices = owners ? [...ROLES, OWNER] : ROLES

  const read = () => library.sharing(collection.id).then(
    (next) => {
      setSharing(next)
      setLoadProblem(undefined)
    },
    (error: unknown) => setLoadProblem(messageOf(error)),
  )
  useEffect(() => {
    if (!open) return
    let current = true
    library.sharing(collection.id).then(
      (next) => { if (current) setSharing(next) },
      (error: unknown) => { if (current) setLoadProblem(messageOf(error)) },
    )
    return () => {
      current = false
    }
  }, [open, library, collection.id])

  const search = useUserSearch(value, config?.userSearchEnabled === true, [])

  const change = async (doing: string, run: () => Promise<unknown>) => {
    setFeedback(undefined)
    if (connection?.blocked()) return
    try {
      await run()
      await read()
    } catch (error) {
      setFeedback({ tone: 'error', message: `Couldn’t ${doing}: ${messageOf(error)}` })
    }
  }

  const invite = async (userId: string) => {
    setFeedback(undefined)
    if (connection?.blocked()) return
    setPending(true)
    try {
      await library.share(collection.id, userId, role)
      await read()
      setValue('')
      setFeedback({ tone: 'success', message: `Shared with ${search?.people.find(({ id }) => id === userId)?.name ?? userId}.` })
    } catch (error) {
      setFeedback({ tone: 'error', message: messageOf(error) })
    } finally {
      setPending(false)
      input.current?.focus()
    }
  }

  const feedbackId = `share-skills-${collection.id}-feedback`
  const everyone = config?.siteName ? `Everyone at ${config.siteName}` : 'Everyone here'

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        setValue('')
        setFeedback(undefined)
      }}
      title={`Share ${collection.title}`}
      description="Whoever you share it with has its skills in every chat, and their agent uses them when they fit."
      footer={<Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>}
    >
      <div className="flex flex-col gap-2">
        <InviteField
          inputRef={input}
          value={value}
          onValueChange={setValue}
          onInvite={(userId) => void invite(userId)}
          pending={pending}
          action="Share"
          suggestions={search}
          accessChoice={<AccessMenu label={LABELS[role]} of="people you add" choices={{ options: ROLES, value: role, onChange: setRole }} />}
          invalid={feedback?.tone === 'error'}
          describedBy={feedback ? feedbackId : undefined}
        />
        {feedback && <ShareNote id={feedbackId} tone={feedback.tone}>{feedback.message}</ShareNote>}
      </div>
      {loadProblem && !sharing && (
        <ShareNote tone="error" action={<Button variant="ghost" onClick={() => void read()}>Try again</Button>}>Couldn’t read who has it: {loadProblem}</ShareNote>
      )}
      {sharing && (
        <ShareList label="Who has access">
          {collection.permissions.canEdit && (
            <ShareList.Row key="everyone">
              <SharePersonRow
                name={everyone}
                group="everyone"
                detail="Can use its skills"
                access={(
                  <Switch
                    aria-label={`${everyone} can use it`}
                    checked={sharing.everyoneCanView}
                    onCheckedChange={(on) => void change(on ? 'share it with everyone' : 'stop sharing it with everyone', () => library.setEveryoneCanView(collection.id, on))}
                  />
                )}
              />
            </ShareList.Row>
          )}
          {sharing.members.map((member) => {
            const name = member.displayName ?? (member.isViewer ? 'You' : 'Someone')
            const changeable = !member.isViewer && collection.permissions.canShare && (member.role !== 'owner' || owners)
            return (
              <ShareList.Row key={member.memberId}>
                <SharePersonRow
                  name={name}
                  you={member.isViewer && member.displayName !== undefined}
                  access={changeable ? (
                    <AccessMenu
                      label={LABELS[member.role]}
                      of={name}
                      choices={{ options: choices, value: member.role, onChange: (next) => void change('change their access', () => library.setMemberRole(collection.id, member.memberId, next)) }}
                      remove={{ label: 'Remove', onRemove: () => void change('remove them', () => library.removeMember(collection.id, member.memberId)) }}
                    />
                  ) : LABELS[member.role]}
                />
              </ShareList.Row>
            )
          })}
        </ShareList>
      )}
    </Dialog>
  )
}
