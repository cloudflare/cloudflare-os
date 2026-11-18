import { useState } from 'react'
import { ArrowSquareOutIcon, BuildingsIcon, CaretLeftIcon, CaretRightIcon, LockSimpleIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react'
import type { CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { AccessMenu } from '@/blocks/AccessMenu'
import { CopyLinkButton } from '@/blocks/CopyLinkButton'
import { InviteField } from '@/blocks/InviteField'
import { ListGroup } from '@/blocks/ListGroup'
import { MemberListItem } from '@/blocks/MemberListItem'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { ShareNote } from '@/blocks/ShareNote'
import { Banner } from '@/components/Banner'
import { Button } from '@/components/Button'
import { Dialog } from '@/components/Dialog'
import { ServiceLogo } from '@/components/ServiceLogo'
import { webUrl } from '@/components/webUrl'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { accessLabel, canChange, covers, inviteRefusal, protectedResources, shareStanding, type ProtectedResource, type ShareTarget } from './sharingRules'
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
   * It is shared from one of its gadgets, which is what it shares to start with: people added can
   * use that gadget alone.
   */
  gadget?: { id: number; title: string }
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error))

type ContentProps = Omit<ShareWorkspaceDialogProps, 'open' | 'onOpenChange' | 'gadget'> & {
  target: ShareTarget
}

// What the dialog holds, which is only there while it is open: the workspace is read as it opens,
// let go of as it closes, and what was typed starts over each time.
const ShareContent = ({ workspaceId, title: knownTitle, page, target }: ContentProps) => {
  const { user } = useApi()
  const connection = useConnectionNotice()
  const config = useServerConfig()
  const { snapshot, session } = useSharing(workspaceId, true, { page, target })
  // Why the last change to the link did not go through.
  const [problem, setProblem] = useState<string>()
  const [linkPending, setLinkPending] = useState(false)
  // Looking at what it reads that whoever it is shared with must see for themselves, in its place.
  const [showingResources, setShowingResources] = useState(false)

  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const title = ready?.metadata.title || knownTitle
  const gadget = target.kind === 'gadget' ? target : undefined
  const standing = ready && shareStanding(ready.metadata, user)
  const collaborators = (ready?.collaborators ?? []).filter(({ profile }) => profile.id !== standing?.owner.id)
  const editors = collaborators.filter(({ access }) => access.role === 'build')
  // Shared from a gadget, its people are those who use it; whoever edits is one line above them.
  const listedPeople = gadget ? collaborators.filter(({ access }) => access.role === 'use' && covers(access, target)) : collaborators
  const siteName = resolveSiteName(config?.siteName)

  const invite = useInvite({
    session,
    refusal: (userId) => standing && inviteRefusal(userId, target, standing.owner, collaborators),
    admitted: ({ profile }) => gadget ? `${profile.name} can now use ${gadget.title}.` : `${profile.name} is now a member of ${title}.`,
  })
  const search = useUserSearch(invite.value, config?.userSearchEnabled === true, [
    ...(standing ? [standing.owner.id] : []),
    // Whoever it already covers; someone who uses a gadget can still be let edit.
    ...collaborators.filter(({ access }) => covers(access, target)).map(({ profile }) => profile.id),
  ])
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators] })

  const setLink = (on: boolean) => {
    if (linkPending || connection?.blocked()) return
    setProblem(undefined)
    setLinkPending(true)
    session.setLink(on).catch((error: unknown) => setProblem(messageOf(error))).finally(() => setLinkPending(false))
  }

  const link = ready?.link
  const linkOn = link?.status === 'on'
  // Off, its address still opens it for whoever has access already.
  const copied = linkOn ? link.url : page
  const feedbackId = `share-${workspaceId}-feedback`
  const removable = (person: CollaboratorInfo) => standing !== undefined && person.profile.id !== user.id && canChange(person, standing, user.id)
  const resources = ready?.requirements && protectedResources(ready.requirements, ready.vendors)
  const linkGives = gadget ? 'Can use' : 'Can join'
  // As people are given it, so that the link reads as one more of them.
  const linkChoices = [
    { value: 'on' as const, label: linkGives, hint: gadget ? `Anyone with the link can use ${gadget.title}` : 'Anyone with the link can join' },
    { value: 'off' as const, label: 'No access', hint: gadget ? 'Only people you add can use it' : 'Only people you add can join' },
  ]

  const linkAccess = () => {
    if (!standing || !link || link.status === 'loading') return <span className="shrink-0 px-3 text-kumo-subtle">…</span>
    // Once only the owner may let anyone in, a link lets nobody in.
    if (link.status === 'failed' || !standing.canShare || standing.ownerOnly) return undefined
    return (
      <AccessMenu
        label={linkPending ? 'Changing…' : linkOn ? linkGives : 'No access'}
        of="anyone with your link"
        disabled={linkPending}
        choices={{ options: linkChoices, value: linkOn ? 'on' : 'off', onChange: (value) => setLink(value === 'on') }}
      />
    )
  }

  const what = gadget?.title ?? title
  if (showingResources && resources) {
    return <ProtectedResources what={what} gadget={gadget !== undefined} resources={resources} onBack={() => setShowingResources(false)} />
  }

  return (
    <>
      <header className="flex items-start gap-3 p-6 pb-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
          <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">Share “{gadget?.title ?? title}”</Dialog.Title>
          <Dialog.Description className="text-sm text-kumo-subtle">
            {gadget
              ? 'People you add can use it, but won’t see the chats or anything else in its workspace.'
              : 'People you add become members. They can see its chats, start their own, and use and change its gadgets.'}
          </Dialog.Description>
        </div>
        <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
      </header>

      {/* Room at its top for the field's focus ring, which its scrolling would otherwise cut off. */}
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pt-1 pb-1">
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
                  onInvite={(userId) => invite.invite(userId)}
                  pending={invite.pending}
                  suggestions={search}
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
              <ShareNote tone="caution" detail="It has read data that needs each person to be let in by you, so nobody else can invite anyone and links don’t work.">
                Only you can invite people
              </ShareNote>
            )}
            {ready.metadata.containsRestrictedData && !standing.ownerOnly && (
              <ShareNote tone="caution" detail={gadget ? `Anyone you add can see what ${gadget.title} shows of it.` : 'Anyone you invite can read it, and ask its agent about it.'}>
                This workspace has read restricted data
              </ShareNote>
            )}
            {problem && <Banner title="Couldn’t change your link" description={problem} />}
            {/* Someone who can only use it is not told who else can. */}
            {ready.metadata.role !== 'use' && (
              <ListGroup label="Who has access">
                <MemberListItem name={standing.owner.name} role="Owner" you={standing.isOwner} />
                {gadget && editors.length > 0 && (
                  <MemberListItem
                    icon={UsersThreeIcon}
                    name={`Everyone in ${title}`}
                    detail={editors.length === 1 ? editors[0]!.profile.name : `${editors.length} people`}
                    role="Can edit"
                  />
                )}
                {listedPeople.map((person) => {
                  const { id, name } = person.profile
                  const label = gadget ? 'Can use' : accessLabel(person.access)
                  return (
                    <MemberListItem
                      key={id}
                      name={name}
                      role={label}
                      you={id === user.id}
                      landed={invite.landed === id}
                      access={removable(person)
                        ? <AccessMenu label={label} of={name} remove={{ label: gadget ? `Remove from ${gadget.title}` : 'Remove from workspace', onRemove: () => removal.ask({ id, name }) }} />
                        : undefined}
                    />
                  )
                })}
                {link && (
                  <MemberListItem
                    icon={BuildingsIcon}
                    name="Anyone with the link"
                    // Who that can be: only those who can sign in where it is.
                    detail={link.status === 'failed' ? 'Couldn’t check your link' : `Signed in to ${siteName}`}
                    role={linkOn && !standing.ownerOnly ? linkGives : 'No access'}
                    access={linkAccess()}
                  />
                )}
              </ListGroup>
            )}
          </>
        )}
      </div>

      <footer className="flex items-center gap-2 p-6">
        {/* Said only once the services are known, and not at all when nothing asks it. */}
        {standing?.canShare && resources && resources.length > 0 && (
          <button
            type="button"
            onClick={() => setShowingResources(true)}
            className="inline-flex h-(--control-size) min-w-0 items-center gap-1.5 rounded-full bg-kumo-info-tint px-(--control-pad) text-(length:--control-text) font-medium text-kumo-info hover:brightness-95 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
          >
            <LockSimpleIcon aria-hidden="true" weight="bold" className="size-[1.125em] shrink-0" />
            <span className="truncate">Protected resources</span>
            <span className="opacity-70">({resources.length})</span>
            <CaretRightIcon aria-hidden="true" weight="bold" className="size-[0.875em] shrink-0" />
          </button>
        )}
        <span className="flex-1" />
        {/* Until its key is minted, a link that is on has nothing to copy that would let anyone in. */}
        <CopyLinkButton link={copied ?? page} title={what} labelled primary disabled={linkOn && copied === undefined} />
      </footer>
      {/* Within it, so that it is the one Escape and a click outside put away. */}
      {removal.dialog && <RemovalDialog {...removal.dialog} gadget={gadget?.title} />}
    </>
  )
}

/**
 * What a workspace reads that someone it is shared with must be able to see with their own
 * account, in the share dialog's place: each by its name, under its service's logo, linked where it
 * has an address, which is what to give them access to first.
 */
const ProtectedResources = ({ what, gadget, resources, onBack }: { what: string; gadget: boolean; resources: ProtectedResource[]; onBack: () => void }) => (
  <>
    <header className="flex items-center gap-2 p-6 pb-2">
      <Button variant="ghost" icon={<CaretLeftIcon weight="bold" />} aria-label="Back to sharing" onClick={onBack} className="-ms-2 text-kumo-subtle hover:text-kumo-default" />
      <Dialog.Title className="min-w-0 flex-1 truncate text-lg font-medium text-kumo-default">Protected resources</Dialog.Title>
      <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
    </header>
    <div className="appears flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
      <Dialog.Description className="text-base text-pretty text-kumo-subtle">
        {gadget ? 'Anyone you add' : 'Anyone who joins'} must have their own access to these before they can open {what}. If they don’t, give them access there first.
      </Dialog.Description>
      <ListGroup label="Protected resources">
        {resources.map(({ key, title, url, service }) => {
          const href = webUrl(url)
          const row = (
            <>
              <ServiceLogo name={service.name} src={service.logoUrl} color={service.color} small />
              <span className="flex min-w-0 flex-1 flex-col leading-snug">
                <span className="truncate font-medium text-kumo-default">{title}</span>
                <span className="truncate text-kumo-subtle">{service.name}</span>
              </span>
            </>
          )
          return href ? (
            <a key={key} href={href} target="_blank" rel="noreferrer noopener" className="group flex items-center gap-3 rounded-2xl p-3 text-base hover:bg-kumo-contrast/5">
              {row}
              <ArrowSquareOutIcon aria-label="Opens in a new tab" className="size-4 shrink-0 text-kumo-subtle opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100 pointer-coarse:opacity-100" />
            </a>
          ) : (
            <div key={key} className="flex items-center gap-3 rounded-2xl p-3 text-base">{row}</div>
          )
        })}
      </ListGroup>
    </div>
  </>
)

/**
 * Who a workspace, or one of its gadgets, is shared with, and the way to share it with more, over
 * the page. A workspace's people can edit everything in it; a gadget's can use that gadget alone,
 * under whoever can edit the workspace. Whoever may share it invites people one at a time, by name or email, turns
 * their own link on or off, and takes access away from a person's row, having been told what that
 * does to whom. What its data asks of anyone it is shared with, the resources they must see for themselves, is a page of its own, from its footer.
 */
export const ShareWorkspaceDialog = ({ open, onOpenChange, gadget, ...props }: ShareWorkspaceDialogProps) => {
  const target: ShareTarget = gadget ? { kind: 'gadget', gadgetId: gadget.id, title: gadget.title } : { kind: 'workspace' }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Keyed, so that another workspace, or what is shared of it, is read afresh. */}
      <ShareContent key={`${props.workspaceId} ${props.page} ${gadget?.id ?? ''}`} {...props} target={target} />
    </Dialog>
  )
}
