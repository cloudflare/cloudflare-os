import { useRef, useState } from 'react'
import type { CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { AccessMenu, type AccessChoice } from '@/blocks/AccessMenu'
import { CopyLinkButton } from '@/blocks/CopyLinkButton'
import { InviteField } from '@/blocks/InviteField'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { ShareList } from '@/blocks/ShareList'
import { ShareNote } from '@/blocks/ShareNote'
import { SharePersonRow } from '@/blocks/SharePersonRow'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { RequirementsNote, SharingPending } from './SharingParts'
import type { SharingSnapshot } from './SharingSession'
import {
  accessBeyondGadget,
  canChange,
  gadgetShareRefusal,
  holdersOf,
  levelOf,
  membersOf,
  shareStanding,
  type GadgetLevel,
} from './sharingRules'
import { useInvite } from './useInvite'
import { useRemoval } from './useRemoval'
import { useSharing } from './useSharing'
import { useUserSearch } from './useUserSearch'

export type ShareGadgetDialogProps = {
  workspaceId: string
  gadgetId: number
  /** What the gadget is called. */
  title: string
  /** Its own page's address, which its link lets anyone in to. */
  page: string
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Who one gadget is shared with, apart from its workspace: people given it on its own, to use it
 * live or, where the deployment allows, only to see the owner's view of it, and whether anyone who
 * can sign in may open it from its link.
 */
export const ShareGadgetDialog = (props: ShareGadgetDialogProps) => (
  <GadgetSharing key={`${props.workspaceId}/${props.gadgetId}`} {...props} />
)

const LEVELS: readonly AccessChoice<GadgetLevel>[] = [
  { value: 'use', label: 'Can use', hint: 'Opens it live, with your data' },
  { value: 'view', label: 'Can view', hint: 'Sees it as you last left it' },
]

const LEVEL_LABEL = { use: 'Can use', view: 'Can view' } as const

const LINK: readonly AccessChoice<'on' | 'off'>[] = [
  { value: 'on', label: 'Can use', hint: 'Anyone with the link can open it' },
  { value: 'off', label: 'No access', hint: 'Only people you add can open it' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

const GadgetSharing = ({ workspaceId, gadgetId, title, page, open, onOpenChange }: ShareGadgetDialogProps) => {
  const { user } = useApi()
  const connection = useConnectionNotice()
  const [options] = useState(() => ({ gadget: { id: gadgetId, page } }))
  const { snapshot, session } = useSharing(workspaceId, options, open)
  const config = useServerConfig()
  const input = useRef<HTMLInputElement>(null)
  // What people added from here are given.
  const [level, setLevel] = useState<GadgetLevel>('use')
  // Why the last change to someone's access, or the link, did not go through.
  const [problem, setProblem] = useState<string>()
  const [linkPending, setLinkPending] = useState(false)

  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const workspaceTitle = ready?.metadata.title ?? 'its workspace'
  const standing = ready && shareStanding(ready.metadata, user)
  const collaborators = ready?.collaborators ?? []
  const members = standing ? membersOf(collaborators, standing.owner) : []
  const holders = holdersOf(collaborators, gadgetId)
  const viewsAvailable = ready?.metadata.sharedViewsAvailable === true
  const siteName = resolveSiteName(config?.siteName)

  const invite = useInvite({
    session,
    refusal: (userId) => standing && gadgetShareRefusal(userId, standing.owner, collaborators, gadgetId),
    grant: () => (viewsAvailable && level === 'view' ? { gadgetId, viewOnly: true } : { gadgetId }),
    admitted: (person) => {
      const beyond = accessBeyondGadget(person)
      return beyond ? { tone: 'info', message: beyond } : { tone: 'success', message: `Shared with ${person.profile.name}.` }
    },
  })
  const search = useUserSearch(invite.value, config?.userSearchEnabled === true, [
    ...(standing ? [standing.owner.id] : []),
    ...members.map(({ profile }) => profile.id),
    ...holders.map(({ profile }) => profile.id),
  ])
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators], from: 'gadget' })

  const attempt = async (change: () => Promise<unknown>) => {
    if (connection?.blocked()) return
    setProblem(undefined)
    try {
      await change()
    } catch (error) {
      setProblem(messageOf(error))
    }
  }
  const setLinkOn = (on: boolean) => {
    if (linkPending) return
    setLinkPending(true)
    void attempt(() => session.setLinkOn(on)).finally(() => setLinkPending(false))
  }

  const link = ready?.link
  const linkOn = link?.status === 'on'
  // Off, its address still opens it for anyone who has it already.
  const copied = linkOn ? link.url : page
  const feedbackId = `share-${workspaceId}-${gadgetId}-feedback`
  const changeable = (person: CollaboratorInfo) => standing !== undefined && canChange(person, standing, user.id)

  const linkAccess = () => {
    if (!standing || !link || link.status === 'loading') return <span className="px-3 text-kumo-subtle">…</span>
    if (link.status === 'failed') return 'Couldn’t check'
    if (standing.ownerOnly) return 'No access'
    const label = linkOn ? 'Can use' : 'No access'
    if (!standing.canShare) return label
    return (
      <AccessMenu
        label={linkPending ? (linkOn ? 'Turning off…' : 'Turning on…') : label}
        of={`anyone in ${siteName}`}
        disabled={linkPending}
        choices={{ options: LINK, value: linkOn ? 'on' : 'off', onChange: (value) => setLinkOn(value === 'on') }}
      />
    )
  }

  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      onClosed={() => {
        invite.reset()
        setProblem(undefined)
      }}
      title={`Share “${title}”`}
      description={`People you add get this gadget on its own, without the rest of ${workspaceTitle}.`}
      footer={(
        <>
          <CopyLinkButton link={copied ?? page} title={title} labelled disabled={linkOn && copied === undefined} />
          <Button variant="primary" onClick={() => onOpenChange(false)}>Done</Button>
        </>
      )}
    >
      {!ready ? (
        <SharingPending snapshot={snapshot as Exclude<SharingSnapshot, { status: 'ready' }>} onRetry={() => session.start()} />
      ) : (
        <>
          {standing?.canShare ? (
            <div className="flex flex-col gap-2">
              <InviteField
                inputRef={input}
                value={invite.value}
                onValueChange={invite.setValue}
                onInvite={invite.invite}
                pending={invite.pending}
                action="Share"
                suggestions={search}
                invalid={invite.feedback?.tone === 'error'}
                describedBy={invite.feedback ? feedbackId : undefined}
                accessChoice={viewsAvailable && (
                  <AccessMenu
                    label={LEVEL_LABEL[level]}
                    of="people you add"
                    disabled={invite.pending}
                    choices={{ options: LEVELS, value: level, onChange: setLevel }}
                  />
                )}
              />
              {invite.feedback && <ShareNote id={feedbackId} tone={invite.feedback.tone}>{invite.feedback.message}</ShareNote>}
            </div>
          ) : (
            <ShareNote tone="info">
              {standing?.ownerOnly ? `Only ${standing.owner.name} can share this gadget.` : 'You can use this gadget, but not share it.'}
            </ShareNote>
          )}
          {standing?.isOwner && ready.metadata.ownerInvitesOnly && (
            <ShareNote tone="caution" detail="Its data needs each person to be let in by you, so its link doesn’t work.">
              Only you can share this gadget
            </ShareNote>
          )}
          <RequirementsNote requirements={ready.requirements} what="it" />
          {problem && <ShareNote tone="error">{problem}</ShareNote>}
          <ShareList label="Who has access">
            {standing && (
              <ShareList.Row key={standing.owner.id}>
                <SharePersonRow name={standing.owner.name} you={standing.isOwner} access="Owner" />
              </ShareList.Row>
            )}
            {members.length > 0 && (
              <ShareList.Row key="members">
                <SharePersonRow
                  group="people"
                  name={`Members of ${workspaceTitle}`}
                  detail={members.length === 1 ? '1 member' : `${members.length} members`}
                  access="Can edit"
                />
              </ShareList.Row>
            )}
            <ShareList.Row key="link">
              <SharePersonRow
                group="everyone"
                name={`Anyone in ${siteName}`}
                detail={linkOn ? 'With the link' : undefined}
                access={linkAccess()}
              />
            </ShareList.Row>
            {holders.map((person) => {
              const held = levelOf(person, gadgetId)
              const { id, name } = person.profile
              return (
                <ShareList.Row key={id}>
                  <SharePersonRow
                    name={name}
                    you={id === user.id}
                    landed={invite.landed === id}
                    access={changeable(person) ? (
                      <AccessMenu
                        label={LEVEL_LABEL[held]}
                        of={name}
                        choices={viewsAvailable ? { options: LEVELS, value: held, onChange: (next) => void attempt(() => session.setLevel(id, next)) } : undefined}
                        remove={{ label: 'Remove access', onRemove: () => removal.ask({ id, name }) }}
                      />
                    ) : LEVEL_LABEL[held]}
                  />
                </ShareList.Row>
              )
            })}
          </ShareList>
        </>
      )}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </Dialog>
  )
}
