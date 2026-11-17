import { useState } from 'react'
import { BuildingsIcon, XIcon } from '@phosphor-icons/react'
import type { CollaboratorInfo, CollaboratorRole } from '@gadgets/workshop-shared/api'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { AccessMenu, type AccessChoice } from '@/blocks/AccessMenu'
import { CopyLinkButton } from '@/blocks/CopyLinkButton'
import { InviteField } from '@/blocks/InviteField'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { ShareNote } from '@/blocks/ShareNote'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { Select } from '@/components/Select'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { canChange, inviteRefusal, listed, roleOf, shareStanding, signInServices } from './sharingRules'
import { useInvite } from './useInvite'
import { useRemoval } from './useRemoval'
import { useSharing } from './useSharing'
import { useUserSearch } from './useUserSearch'

export type ShareWorkspaceDialogProps = {
  workspaceId: string
  /** What the workspace is called, until its own metadata is read. */
  title: string
  /** The page it is shared from, which Copy link copies and its link lets anyone in to. */
  page: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /**
   * It is shared from one of its gadgets, by this name. A gadget is not shared on its own, so the
   * dialog says that people get all of the workspace, and starts them on only using it.
   */
  gadget?: string
}

const ROLE_LABELS: Record<CollaboratorRole, string> = { build: 'Can edit', use: 'Can use' }
const ROLE_OPTIONS = [
  { id: 'build' as const, label: ROLE_LABELS.build },
  { id: 'use' as const, label: ROLE_LABELS.use },
]

// As people are given it, so that the link reads as one more of them.
const LINK_CHOICES: readonly AccessChoice<CollaboratorRole | 'off'>[] = [
  { value: 'build', label: 'Can edit', hint: 'Anyone with the link works on everything in it' },
  { value: 'use', label: 'Can use', hint: 'Anyone with the link opens its gadgets' },
  { value: 'off', label: 'No access', hint: 'Only people you add can open it' },
]

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

// What the dialog holds, which is only there while it is open: the workspace is read as it opens,
// let go of as it closes, and what was typed starts over each time.
const ShareContent = ({ workspaceId, title: knownTitle, page, gadget }: Omit<ShareWorkspaceDialogProps, 'open' | 'onOpenChange'>) => {
  const { user } = useApi()
  const connection = useConnectionNotice()
  const config = useServerConfig()
  const { snapshot, session } = useSharing(workspaceId, true, page)
  // What people added from here are given.
  const [role, setRole] = useState<CollaboratorRole>(gadget ? 'use' : 'build')
  // Why the last change to the link did not go through.
  const [problem, setProblem] = useState<string>()
  const [linkPending, setLinkPending] = useState(false)

  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const title = ready?.metadata.title || knownTitle
  const standing = ready && shareStanding(ready.metadata, user)
  const collaborators = (ready?.collaborators ?? []).filter(({ profile }) => profile.id !== standing?.owner.id)
  const siteName = resolveSiteName(config?.siteName)

  const invite = useInvite({
    session,
    refusal: (userId, chosen) => standing && inviteRefusal(userId, chosen, standing.owner, collaborators),
    admitted: ({ profile }, given) => given === 'build' ? `${profile.name} can now work on everything in ${title}.` : `${profile.name} can now use ${title}.`,
  })
  const search = useUserSearch(invite.value, config?.userSearchEnabled === true, [
    ...(standing ? [standing.owner.id] : []),
    // Someone who can only use it can still be let edit.
    ...collaborators.filter((person) => roleOf(person) === 'build').map(({ profile }) => profile.id),
  ])
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators] })

  const setLink = (to: CollaboratorRole | 'off') => {
    if (linkPending || connection?.blocked()) return
    setProblem(undefined)
    setLinkPending(true)
    session.setLink(to).catch((error: unknown) => setProblem(messageOf(error))).finally(() => setLinkPending(false))
  }

  const link = ready?.link
  const linkOn = link?.status === 'on'
  // Off, its address still opens it for whoever has access already.
  const copied = linkOn ? link.url : page
  const feedbackId = `share-${workspaceId}-feedback`
  const removable = (person: CollaboratorInfo) => standing !== undefined && person.profile.id !== user.id && canChange(person, standing, user.id)
  const needs = ready && signInServices(ready.requirements[role] ?? [], ready.vendors)

  const linkAccess = () => {
    if (!standing || !link || link.status === 'loading') return <span className="shrink-0 px-3 text-kumo-subtle">…</span>
    if (link.status === 'failed') return undefined
    const value = linkOn ? link.role : 'off'
    const label = LINK_CHOICES.find((choice) => choice.value === value)?.label ?? 'No access'
    // Once only the owner may let anyone in, a link lets nobody in.
    if (!standing.canShare || standing.ownerOnly) return undefined
    return (
      <AccessMenu
        label={linkPending ? 'Changing…' : label}
        of="anyone with the link"
        disabled={linkPending}
        choices={{ options: LINK_CHOICES, value, onChange: setLink }}
      />
    )
  }
  const linkRole = !link || link.status !== 'on' || standing?.ownerOnly ? 'No access' : ROLE_LABELS[link.role]

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-5">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Share “{gadget ?? title}”</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {gadget
              ? `People you add get all of ${title}, not only ${gadget}.`
              : 'Whoever can edit works on everything in it with you. Whoever can use it opens its gadgets.'}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-1">
        {snapshot.status === 'loading' && (
          // As tall as a short list, so that the dialog does not jump much once it is read.
          <p role="status" className="appears-late grid min-h-32 place-items-center text-base text-kumo-subtle">Loading who has access…</p>
        )}
        {snapshot.status === 'failed' && (
          <Banner title="Couldn’t load who has access" description={snapshot.message} action={{ label: 'Try again', onSelect: () => session.start() }} />
        )}
        {ready && standing && (
          <>
            {standing.canShare ? (
              <div className="flex flex-col gap-2">
                <InviteField
                  value={invite.value}
                  onValueChange={invite.setValue}
                  onInvite={(userId) => invite.invite(userId, role)}
                  pending={invite.pending}
                  suggestions={search}
                  role={<Select aria-label="What they can do" value={role} onValueChange={setRole} options={ROLE_OPTIONS} />}
                  invalid={invite.feedback?.tone === 'error'}
                  describedBy={invite.feedback ? feedbackId : undefined}
                />
                {invite.feedback && (invite.feedback.tone === 'error'
                  ? <div id={feedbackId}><Banner title={invite.feedback.message} /></div>
                  : <ShareNote id={feedbackId} tone={invite.feedback.tone}>{invite.feedback.message}</ShareNote>)}
              </div>
            ) : (
              <ShareNote tone="info">
                {standing.ownerOnly && ready.metadata.role !== 'use'
                  ? `Only ${standing.owner.name} can invite people to this workspace.`
                  : 'You can use what’s shared with you here, but not share it.'}
              </ShareNote>
            )}
            {standing.isOwner && standing.ownerOnly && (
              <ShareNote tone="caution" detail="It has read data that needs each person to be let in by you, so nobody else can invite anyone and its link doesn’t work.">
                Only you can invite people
              </ShareNote>
            )}
            {ready.metadata.containsRestrictedData && !standing.ownerOnly && (
              <ShareNote tone="caution" detail="Anyone you invite can read it, and ask its agent about it.">
                This workspace has read restricted data
              </ShareNote>
            )}
            {/* Said only once the services are known, and not at all when none asks. */}
            {standing.canShare && needs && needs.length > 0 && (
              <ShareNote tone="info" detail={`If they can’t, give them access in ${listed(needs)} first.`}>
                Anyone who joins confirms with their own {listed(needs)} {needs.length === 1 ? 'account' : 'accounts'} that they can see what this workspace reads.
              </ShareNote>
            )}
            {problem && <Banner title="Couldn’t change the link" description={problem} />}
            {/* Someone who can only use it is not told who else can. */}
            {ready.metadata.role !== 'use' && (
              <ListGroup label="Who has access">
                <MemberListItem name={standing.owner.name} role="Owner" you={standing.isOwner} />
                {collaborators.map((person) => {
                  const { id, name } = person.profile
                  const label = ROLE_LABELS[roleOf(person)]
                  return (
                    <MemberListItem
                      key={id}
                      name={name}
                      role={label}
                      you={id === user.id}
                      landed={invite.landed === id}
                      access={removable(person)
                        ? <AccessMenu label={label} of={name} remove={{ label: 'Remove from workspace', onRemove: () => removal.ask({ id, name }) }} />
                        : undefined}
                    />
                  )
                })}
                {link && (
                  <MemberListItem
                    icon={BuildingsIcon}
                    name={`Anyone in ${siteName}`}
                    detail={link.status === 'failed' ? 'Couldn’t check the link' : linkOn && !standing.ownerOnly ? 'With the link' : undefined}
                    role={linkRole}
                    access={linkAccess()}
                  />
                )}
              </ListGroup>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center gap-2 p-6">
        {/* Until its key is minted, a link that is on has nothing to copy that would let anyone in. */}
        <CopyLinkButton link={copied ?? page} title={gadget ?? title} labelled disabled={linkOn && copied === undefined} />
        <span className="flex-1" />
        <Dialog.Close render={(props) => <Button {...props} variant="primary">Done</Button>} />
      </footer>
      {/* Within it, so that it is the one Escape and a click outside put away. */}
      {removal.dialog && <RemovalDialog {...removal.dialog} />}
    </>
  )
}

/**
 * Who a workspace is shared with, and the way to invite more, over the page: its owner, whoever
 * can edit it or only use it, and anyone in the deployment with its link. Whoever may share it
 * invites people one at a time, by name or email, choosing what they can do, and takes access
 * away from a person's row, having been told what that does to whom. What its data asks of anyone
 * it is shared with is said before they are invited.
 */
export const ShareWorkspaceDialog = ({ open, onOpenChange, ...props }: ShareWorkspaceDialogProps) => (
  <Dialog open={open} onOpenChange={onOpenChange}>
    {/* Keyed, so that another workspace is read afresh. */}
    <ShareContent key={`${props.workspaceId} ${props.page}`} {...props} />
  </Dialog>
)
