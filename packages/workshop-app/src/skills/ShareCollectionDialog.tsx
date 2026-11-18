import { useEffect, useState } from 'react'
import { BuildingsIcon, XIcon } from '@phosphor-icons/react'
import type { ContextCollectionRole, ContextCollectionSharing } from '@gadgets/gatekeeper-context/src/context-types'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { AccessMenu, type AccessChoice } from '@/blocks/AccessMenu'
import { InviteField } from '@/blocks/InviteField'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { ShareNote } from '@/blocks/ShareNote'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { useUserSearch } from '@/workspaces/useUserSearch'
import { ROLE_LABELS } from './collectionList'
import type { SkillCollection } from './SkillStore'
import { skillStore } from './useSkills'

export type ShareCollectionDialogProps = {
  collection: SkillCollection
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The user gave up their own place in it, so it is no longer theirs to look at. */
  onLeft: () => void
}

const ROLES: readonly AccessChoice<ContextCollectionRole>[] = [
  { value: 'viewer', label: ROLE_LABELS.viewer, hint: 'Their assistant uses its skills.' },
  { value: 'editor', label: ROLE_LABELS.editor, hint: 'They change its skills and share it.' },
]
const OWNER: AccessChoice<ContextCollectionRole> = { value: 'owner', label: ROLE_LABELS.owner, hint: 'They can also delete it.' }

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))
type Feedback = { tone: 'success' | 'error'; message: string }

const ShareContent = ({ collection, onLeft }: Pick<ShareCollectionDialogProps, 'collection' | 'onLeft'>) => {
  const config = useServerConfig()
  const connection = useConnectionNotice()
  const [sharing, setSharing] = useState<ContextCollectionSharing>()
  const [loadProblem, setLoadProblem] = useState<string>()
  const [value, setValue] = useState('')
  const [role, setRole] = useState<ContextCollectionRole>('viewer')
  const [pending, setPending] = useState(false)
  const [feedback, setFeedback] = useState<Feedback>()
  // Read again after each change, which the Context Library may have refused part of.
  const [reads, setReads] = useState(0)
  const { permissions } = collection
  const owners = permissions.canManageOwners
  const choices = owners ? [...ROLES, OWNER] : ROLES

  useEffect(() => {
    let current = true
    skillStore.sharing(collection.id).then(
      (next) => {
        if (!current) return
        setSharing(next)
        setLoadProblem(undefined)
      },
      (error: unknown) => {
        if (current) setLoadProblem(messageOf(error))
      },
    )
    return () => {
      current = false
    }
  }, [collection.id, reads])
  const readAgain = () => setReads((count) => count + 1)

  const search = useUserSearch(value, config?.userSearchEnabled === true, [])

  const change = async (doing: string, run: () => Promise<unknown>) => {
    setFeedback(undefined)
    if (connection?.blocked()) return
    try {
      await run()
    } catch (error) {
      setFeedback({ tone: 'error', message: `Couldn’t ${doing}: ${messageOf(error)}` })
    }
    readAgain()
  }

  const invite = async (typed: string) => {
    setFeedback(undefined)
    if (connection?.blocked()) return
    // Someone chosen from the matches is known by their id; what was typed is tried as one.
    const person = search?.people.find(({ id, name }) => id === typed || name.toLowerCase() === typed.toLowerCase())
    setPending(true)
    try {
      await skillStore.share(collection.id, person?.id ?? typed, role)
      setValue('')
      setFeedback({ tone: 'success', message: `Shared with ${person?.name ?? typed}.` })
    } catch (error) {
      setFeedback({ tone: 'error', message: messageOf(error) })
    } finally {
      setPending(false)
      readAgain()
    }
  }

  const leave = () => {
    setFeedback(undefined)
    if (connection?.blocked()) return
    skillStore.leaveCollection(collection.id).then(onLeft, (error: unknown) => setFeedback({ tone: 'error', message: `Couldn’t leave it: ${messageOf(error)}` }))
  }

  const feedbackId = `share-collection-${collection.id}-feedback`
  const everyone = `Everyone at ${resolveSiteName(config?.siteName)}`
  const ownerCount = sharing?.members.filter((member) => member.role === 'owner').length ?? 0

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Share “{collection.title}”</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            Whoever you share it with has its skills in every chat, and their assistant uses them when they fit.
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      {/* Room at its top for the field's focus ring, which its scrolling would otherwise cut off. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-1">
        {permissions.canShare && (
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-3 text-base">
              <span className="text-kumo-subtle">People you add</span>
              <AccessMenu label={ROLE_LABELS[role]} of="people you add" choices={{ options: choices, value: role, onChange: setRole }} />
            </div>
            <InviteField
              value={value}
              onValueChange={setValue}
              onInvite={(typed) => void invite(typed)}
              pending={pending}
              suggestions={search}
              invalid={feedback?.tone === 'error'}
              describedBy={feedback ? feedbackId : undefined}
            />
          </div>
        )}
        {feedback && (feedback.tone === 'error'
          ? <div id={feedbackId}><Banner title={feedback.message} /></div>
          : <ShareNote id={feedbackId} tone="success">{feedback.message}</ShareNote>)}
        {!sharing && !loadProblem && (
          <p role="status" className="appears-late grid min-h-32 place-items-center text-base text-kumo-subtle">Loading who has access…</p>
        )}
        {loadProblem && !sharing && <Banner title="Couldn’t load who has access" description={loadProblem} action={{ label: 'Try again', onSelect: readAgain }} />}
        {sharing && !sharing.hasOwner && (
          <ShareNote tone="caution" detail="Its owner’s account was disconnected. Editors can still change its skills, but nobody can delete it.">Nobody owns it</ShareNote>
        )}
        {sharing && (
          <ListGroup label="Who has access">
            {sharing.members.map((member) => {
              const name = member.displayName ?? (member.isViewer ? 'You' : 'Someone')
              const label = ROLE_LABELS[member.role]
              // The last owner can neither leave nor be made anything less.
              const lastOwner = member.role === 'owner' && ownerCount < 2
              if (member.isViewer) {
                return (
                  <MemberListItem
                    key={member.memberId}
                    name={name}
                    you={member.displayName !== undefined}
                    role={label}
                    access={lastOwner ? undefined : <AccessMenu label={label} of="you" remove={{ label: 'Leave collection', onRemove: leave }} />}
                  />
                )
              }
              const changeable = permissions.canShare && (member.role !== 'owner' || owners)
              return (
                <MemberListItem
                  key={member.memberId}
                  name={name}
                  role={label}
                  access={changeable
                    ? (
                        <AccessMenu
                          label={label}
                          of={name}
                          choices={lastOwner ? undefined : { options: choices, value: member.role, onChange: (next) => void change('change their access', () => skillStore.setMemberRole(collection.id, member.memberId, next)) }}
                          remove={lastOwner ? undefined : { label: 'Remove access', onRemove: () => void change('remove them', () => skillStore.removeMember(collection.id, member.memberId)) }}
                        />
                      )
                    : undefined}
                />
              )
            })}
            <MemberListItem
              icon={BuildingsIcon}
              name={everyone}
              detail="Without it being added to their skills"
              role={sharing.everyoneCanView ? ROLE_LABELS.viewer : 'No access'}
              access={permissions.canShare
                ? (
                    <AccessMenu
                      label={sharing.everyoneCanView ? ROLE_LABELS.viewer : 'No access'}
                      of={everyone}
                      choices={{
                        options: [
                          { value: 'on', label: ROLE_LABELS.viewer, hint: 'Anyone here can use its skills, as in a workspace that read it' },
                          { value: 'off', label: 'No access', hint: 'Only the people listed' },
                        ],
                        value: sharing.everyoneCanView ? 'on' : 'off',
                        onChange: (next) => void change(next === 'on' ? 'share it with everyone' : 'stop sharing it with everyone', () => skillStore.setEveryoneCanView(collection.id, next === 'on')),
                      }}
                    />
                  )
                : undefined}
            />
          </ListGroup>
        )}
        {sharing && !permissions.canShare && (
          <ShareNote tone="info">You can use what’s shared with you here, but not share it.</ShareNote>
        )}
      </div>

      <footer className="flex justify-end p-6">
        <Dialog.Close render={(props) => <Button {...props} variant="primary">Done</Button>} />
      </footer>
    </>
  )
}

/**
 * Who a collection of skills is shared with, and the way to share it with more, over the page, as
 * a workspace's is: people one at a time, each to use its skills or to edit them too (and, for its
 * owners, to own it), and everyone in the deployment as one more row. Whoever may share it changes
 * or takes away each person's access from their row; anyone leaves from their own, but its last
 * owner. What is changed is read back from the Context Library, which says why when it refuses.
 */
export const ShareCollectionDialog = ({ collection, open, onOpenChange, onLeft }: ShareCollectionDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {/* Keyed, so that another collection is read afresh. */}
    <ShareContent key={collection.id} collection={collection} onLeft={onLeft} />
  </Dialog>
)
