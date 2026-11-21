import { useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { ArrowSquareOutIcon, BuildingsIcon, CaretLeftIcon, CaretRightIcon, EyeIcon, LockSimpleIcon, UsersThreeIcon, XIcon } from '@phosphor-icons/react'
import type { CollaboratorInfo } from '@gadgets/workshop-shared/api'
import { resolveSiteName } from '@gadgets/workshop-shared/api'
import { AccessMenu, Banner, Button, Dialog, ListGroup, MemberListItem, ShareNote, webUrl } from '@gadgets/ui'
import { CopyLinkButton } from '@/blocks/CopyLinkButton'
import { InviteField } from '@/blocks/InviteField'
import { RemovalDialog } from '@/blocks/RemovalDialog'
import { SnapshotPreview } from '@/blocks/SnapshotPreview'
import { formatAsideRef } from '@/aside/asideItems'
import { describeModelProblem, useDefaultModel } from '@/chat/useDefaultModel'
import { ServiceLogo } from '@/components/ServiceLogo'
import { useApi } from '@/rpc/ApiContext'
import { useConnectionNotice } from '@/rpc/ConnectionNoticeContext'
import { useServerConfig } from '@/rpc/serverConfig'
import { ACCESS_LABELS, canChange, covers, holdsOnlyView, inviteRefusal, protectedResources, shareStanding, snapshotFixPrompt, type GadgetAccess, type ProtectedResource, type ShareTarget } from './sharingRules'
import { useInvite } from './useInvite'
import { useRemoval } from './useRemoval'
import { useSharing } from './useSharing'
import { useSnapshotPreview } from './useSnapshotPreview'
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
  /** Whether the dialog is as wide as the window has room for, which a snapshot looked at closely asks for. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onClose: () => void
}

// What each access to a gadget lets whoever has it do, under its name in a menu.
const ACCESS_CHOICES: { value: GadgetAccess; label: string; hint: string }[] = [
  { value: 'use', label: ACCESS_LABELS.use, hint: 'Opens it live, once they verify access to its connections' },
  { value: 'view', label: ACCESS_LABELS.view, hint: 'Opens a read-only snapshot, with nothing to verify' },
]

// What the dialog holds, which is only there while it is open: the workspace is read as it opens,
// let go of as it closes, and what was typed starts over each time.
const ShareContent = ({ workspaceId, title: knownTitle, page, target, expanded, onExpandedChange, onClose }: ContentProps) => {
  const { user } = useApi()
  const connection = useConnectionNotice()
  const config = useServerConfig()
  const { snapshot, session } = useSharing(workspaceId, true, { page, target })
  // Why the last change to the link did not go through.
  const [problem, setProblem] = useState<string>()
  const [linkPending, setLinkPending] = useState(false)
  // Looking, in its place, at what it reads that whoever it is shared with must see for
  // themselves, or at the snapshot whoever may only view it opens.
  const [subpage, setSubpage] = useState<'resources' | 'snapshot'>()
  // What a gadget is shared for with whoever is invited next. A view chosen before the deployment
  // forbade them is kept, and sends nothing until use is chosen, so that a change of policy never
  // makes a view a live share.
  const [inviteAccess, setInviteAccess] = useState<GadgetAccess>('use')
  // Whose access to the gadget is being changed, and what came of the last change.
  const [changing, setChanging] = useState<string>()
  const [changed, setChanged] = useState<{ tone: 'success' | 'info' | 'error'; message: string }>()

  const ready = snapshot.status === 'ready' ? snapshot : undefined
  const title = ready?.metadata.title || knownTitle
  const gadget = target.kind === 'gadget' ? target : undefined
  const standing = ready && shareStanding(ready.metadata, user)
  const collaborators = (ready?.collaborators ?? []).filter(({ profile }) => profile.id !== standing?.owner.id)
  const editors = collaborators.filter(({ access }) => access.role === 'build')
  // Shared from a gadget, its people are those who use it, whoever edits being one line above them;
  // the workspace's are its members, as whoever only uses one of its apps is not in it.
  const listedPeople = gadget ? collaborators.filter(({ access }) => access.role === 'use' && covers(access, target)) : editors
  const siteName = resolveSiteName(config?.siteName)
  // While the deployment forbids sharing to view only, a gadget is shared only for use, its
  // snapshot cannot be looked at, and views already given are only listed, to be raised or removed.
  const viewsAllowed = config?.snapshotSharingEnabled !== false
  const offered = viewsAllowed ? ACCESS_CHOICES : ACCESS_CHOICES.filter(({ value }) => value === 'use')
  const viewForbidden = gadget !== undefined && inviteAccess === 'view' && !viewsAllowed
  const heldOf = (person: CollaboratorInfo): GadgetAccess => (gadget && holdsOnlyView(person.access, gadget.gadgetId) ? 'view' : 'use')

  const invite = useInvite({
    session,
    access: gadget ? inviteAccess : undefined,
    refusal: (userId) => standing && inviteRefusal(userId, target, standing.owner, collaborators, inviteAccess),
    admitted: (person) => !gadget
      ? `${person.profile.name} is now a member of ${title}.`
      // Given a view while holding its use, which a share never narrows.
      : inviteAccess === 'view' && !holdsOnlyView(person.access, gadget.gadgetId)
        ? `${person.profile.name} can still use this gadget through someone else’s share.`
        : `${person.profile.name} ${ACCESS_LABELS[inviteAccess].toLowerCase()} this gadget.`,
  })
  const search = useUserSearch(invite.value, config?.userSearchEnabled === true, [
    ...(standing ? [standing.owner.id] : []),
    // Whoever it already covers; someone who uses a gadget can still be let edit, and someone
    // who can only view it can still be let use it.
    ...collaborators.filter(({ access }) => covers(access, target) && !(gadget && inviteAccess === 'use' && holdsOnlyView(access, gadget.gadgetId))).map(({ profile }) => profile.id),
  ])
  const removal = useRemoval({ session, people: [user, ...(standing ? [standing.owner] : []), ...collaborators] })

  const setLink = (access: GadgetAccess | 'off') => {
    if (linkPending || connection?.blocked()) return
    setProblem(undefined)
    setLinkPending(true)
    session.setLink(access).catch((error: unknown) => setProblem(messageOf(error))).finally(() => setLinkPending(false))
  }

  const changeAccess = ({ profile }: CollaboratorInfo, access: GadgetAccess) => {
    if (changing !== undefined || connection?.blocked()) return
    setChanging(profile.id)
    setChanged(undefined)
    session.changeAccess(profile.id, access).then(
      (held) => setChanged(held === access
        ? { tone: 'success', message: `${profile.name} ${ACCESS_LABELS[access].toLowerCase()} this gadget.` }
        : { tone: 'info', message: `${profile.name} can still use this gadget through someone else’s share.` }),
      (error: unknown) => setChanged({ tone: 'error', message: messageOf(error) || 'Failed to change their access.' }),
    ).finally(() => setChanging(undefined))
  }

  const link = ready?.link
  const linkOn = link?.status === 'on'
  const linkAccess = link?.status === 'on' ? link.access : undefined
  const feedbackId = `share-${workspaceId}-feedback`
  const removable = (person: CollaboratorInfo) => standing !== undefined && person.profile.id !== user.id && canChange(person, standing, user.id)
  const resources = ready?.requirements && protectedResources(ready.requirements, ready.vendors)
  const linkGives = gadget ? ACCESS_LABELS[linkAccess ?? 'use'] : 'Can join'
  // As people are given it, so that the link reads as one more of them. A view link made before
  // views were forbidden still says what it is.
  const linkChoices: { value: GadgetAccess | 'off'; label: string; hint: string }[] = [
    ...(gadget
      ? [
          { value: 'use' as const, label: ACCESS_LABELS.use, hint: `Anyone with your link can use ${gadget.title}` },
          ...(viewsAllowed || linkAccess === 'view' ? [{ value: 'view' as const, label: ACCESS_LABELS.view, hint: 'Anyone with your link can view a snapshot of it' }] : []),
        ]
      : [{ value: 'use' as const, label: 'Can join', hint: 'Anyone with your link can join' }]),
    { value: 'off', label: 'Requires invite', hint: gadget ? 'Only people you add can open it' : 'Only people you add can join' },
  ]
  // A gadget's snapshot matters once anyone may open it, which only whoever can view it does:
  // whoever can use it opens it live, or not at all. Nobody can while views are forbidden.
  const snapshotOffered = gadget !== undefined && viewsAllowed && standing?.canShare === true &&
    (inviteAccess === 'view' || linkAccess === 'view' || collaborators.some(({ access }) => holdsOnlyView(access, gadget.gadgetId)))

  const linkMenu = () => {
    if (!standing || !link || link.status === 'loading') return <span className="shrink-0 px-3 text-kumo-subtle">…</span>
    // Once only the owner may let anyone in, a link lets nobody in.
    if (link.status === 'failed' || !standing.canShare || standing.ownerOnly) return undefined
    return (
      <AccessMenu
        label={linkPending ? 'Changing…' : linkOn ? linkGives : 'Requires invite'}
        of="anyone with your link"
        disabled={linkPending}
        choices={{ options: linkChoices, value: linkAccess ?? 'off', onChange: setLink }}
      />
    )
  }

  const what = gadget?.title ?? title
  const resourcesShown = subpage === 'resources' && resources !== undefined
  const snapshotShown = subpage === 'snapshot' && snapshotOffered && gadget !== undefined

  return (
    <>
      {resourcesShown && <ProtectedResources gadget={gadget !== undefined} resources={resources} onBack={() => setSubpage(undefined)} />}
      {snapshotShown && standing && (
        <Snapshot
          workspaceId={workspaceId}
          gadget={gadget}
          workspaceTitle={title}
          owner={standing.isOwner ? undefined : standing.owner.name}
          expanded={expanded}
          onExpandedChange={onExpandedChange}
          // Back at the sharing, it is as wide as that is.
          onBack={() => {
            onExpandedChange(false)
            setSubpage(undefined)
          }}
          onClose={onClose}
        />
      )}
      {/* Kept while the resources are looked at, only hidden: drawn again on coming back, it was
          laid out while the dialog glided between their heights, and its menus measured from there. */}
      <div hidden={resourcesShown || snapshotShown} className="contents">
        <header className="flex items-start gap-3 p-6 pb-4">
          <div className="flex min-w-0 flex-1 flex-col gap-1 leading-snug">
            <Dialog.Title className="text-lg font-medium wrap-anywhere text-kumo-default">{gadget ? 'Share' : 'Invite to'} “{what}”</Dialog.Title>
            <Dialog.Description className="text-sm text-kumo-subtle">
              {gadget
                ? `People you add can ${viewsAllowed ? 'use or view' : 'use'} this gadget without seeing anything else in the workspace.`
                : standing?.ownerOnly
                  ? 'People you add can create chats and edit gadgets.'
                  : 'People you add can create chats, edit gadgets, and invite other users.'}
            </Dialog.Description>
          </div>
          <CloseButton />
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
                    disabled={viewForbidden}
                    access={gadget && (viewsAllowed || inviteAccess === 'view') && (
                      <AccessMenu
                        label={ACCESS_LABELS[inviteAccess]}
                        of="whoever you invite"
                        disabled={invite.pending}
                        choices={{ options: offered, value: inviteAccess, onChange: setInviteAccess }}
                      />
                    )}
                  />
                  {viewForbidden && <Banner title="View-only sharing is turned off on this deployment. Choose Can use to give live access." />}
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
              {changed && (changed.tone === 'error' ? <Banner title={changed.message} /> : <ShareNote tone={changed.tone}>{changed.message}</ShareNote>)}
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
                    const held = heldOf(person)
                    const label = changing === id ? 'Changing…' : gadget ? ACCESS_LABELS[held] : 'Member'
                    const mine = removable(person)
                    // Anyone who can share can give its use; narrowing takes their grant away first.
                    const changeable = gadget !== undefined && standing.canShare && id !== user.id && (held === 'view' || (mine && viewsAllowed))
                    return (
                      <MemberListItem
                        key={id}
                        name={name}
                        role={label}
                        you={id === user.id}
                        landed={invite.landed === id}
                        access={mine || changeable
                          ? (
                              <AccessMenu
                                label={label}
                                of={name}
                                disabled={changing !== undefined}
                                choices={changeable
                                  // Down to a view only by whoever could take it away.
                                  ? { options: mine ? offered : offered.filter(({ value }) => value === 'use'), value: held, onChange: (access) => changeAccess(person, access) }
                                  : undefined}
                                remove={mine ? { label: gadget ? `Remove from ${gadget.title}` : 'Remove from workspace', onRemove: () => removal.ask({ id, name }) } : undefined}
                              />
                            )
                          : undefined}
                      />
                    )
                  })}
                  {link && (
                    <MemberListItem
                      icon={BuildingsIcon}
                      name="Anyone with your link"
                      // Who that can be: only those who can sign in where it is.
                      detail={link.status === 'failed' ? 'Couldn’t check your link' : `Signed in to ${siteName}`}
                      role={linkOn && !standing.ownerOnly ? linkGives : 'Requires invite'}
                      access={linkMenu()}
                    />
                  )}
                </ListGroup>
              )}
              {snapshotOffered && (
                <button
                  type="button"
                  onClick={() => setSubpage('snapshot')}
                  className="flex cursor-pointer items-center gap-3 rounded-(--surface-radius) p-3 text-left text-base ring-1 ring-kumo-line hover:bg-kumo-contrast/5 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
                >
                  <span className="grid size-9 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-subtle"><EyeIcon aria-hidden="true" className="size-[1.125em]" /></span>
                  <span className="flex min-w-0 flex-1 flex-col leading-snug">
                    <span className="truncate font-medium text-kumo-default">Viewers can see a snapshot</span>
                    <span className="text-sm text-pretty text-kumo-subtle">A read-only copy with no connections that does not require verification</span>
                  </span>
                  <CaretRightIcon aria-hidden="true" weight="bold" className="size-3.5 shrink-0 text-kumo-subtle" />
                </button>
              )}
            </>
          )}
        </div>

        <footer className="flex items-center gap-2 p-6">
          {/* Said only once the services are known, and not at all when nothing asks it. */}
          {standing?.canShare && resources && resources.length > 0 && (
            <button
              type="button"
              onClick={() => setSubpage('resources')}
              className="inline-flex h-(--control-size) min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-info-tint px-(--control-pad) text-(length:--control-text) font-medium text-kumo-info hover:brightness-95 focus-visible:ring-2 focus-visible:ring-kumo-focus focus-visible:outline-none"
            >
              <LockSimpleIcon aria-hidden="true" weight="bold" className="size-[1.125em] shrink-0" />
              <span className="truncate">Protected resources</span>
              <span className="opacity-70">({resources.length})</span>
              <CaretRightIcon aria-hidden="true" weight="bold" className="size-[0.875em] shrink-0" />
            </button>
          )}
          <span className="flex-1" />
          {/* Off, its address still opens it for whoever has access already; on, a key is minted for the copy. */}
          <CopyLinkButton link={() => session.linkToCopy()} title={what} labelled primary />
        </footer>
      </div>
      {/* Within it, so that it is the one Escape and a click outside put away. */}
      {removal.dialog && <RemovalDialog {...removal.dialog} gadget={gadget?.title} />}
    </>
  )
}

// The dialog's own close, at the end of each page's header.
const CloseButton = () => (
  <Dialog.Close render={(props) => <Button {...props} variant="ghost" icon={<XIcon weight="bold" />} aria-label="Close" className="text-kumo-subtle hover:text-kumo-default focus-visible:text-kumo-default" />} />
)

// How long the dialog takes to glide to a page's height (`SurfaceGlide`), and a little.
const ARRIVES_AFTER = 350
const TAKING = { status: 'loading' } as const

/**
 * What whoever may only view a gadget opens, in the share dialog's place: the snapshot itself,
 * taken as this is shown and let go as it is left, under what it is, and the way to have the
 * agent make the gadget work as one, in a chat of its own beside the gadget.
 */
const Snapshot = ({ workspaceId, gadget, workspaceTitle, owner, expanded, onExpandedChange, onBack, onClose }: {
  workspaceId: string
  gadget: Extract<ShareTarget, { kind: 'gadget' }>
  workspaceTitle: string
  /** Whose the workspace is, where it is not the viewer's. */
  owner?: string
  /** Whether the dialog is as wide as the window has room for, the snapshot with it. */
  expanded: boolean
  onExpandedChange: (expanded: boolean) => void
  onBack: () => void
  onClose: () => void
}) => {
  const { api } = useApi()
  const connection = useConnectionNotice()
  const navigate = useNavigate()
  const model = useDefaultModel()
  const [asking, setAsking] = useState(false)
  const [problem, setProblem] = useState<string>()
  const preview = useSnapshotPreview(workspaceId, gadget.gadgetId, gadget.title, () => onExpandedChange(false))
  // The gadget's page is drawn only once the dialog has glided to this page's height: starting it
  // is work enough to make that glide stutter.
  const [arrived, setArrived] = useState(false)
  useEffect(() => {
    const timer = setTimeout(() => setArrived(true), ARRIVES_AFTER)
    return () => clearTimeout(timer)
  }, [])

  // Starts a chat whose first message asks the agent to make the gadget work for people who have
  // none of its connections, as its snapshot does, and opens it with the gadget beside it.
  const askAgent = async () => {
    if (asking || connection?.blocked()) return
    if (model.status !== 'ready') return setProblem(describeModelProblem(model))
    setAsking(true)
    setProblem(undefined)
    // Disposed by hand: `using` is not lowered for every browser this runs in.
    const overseer = api.openWorkspace(workspaceId)
    try {
      const chatId = await overseer.newChat(snapshotFixPrompt(gadget.title), model.id)
      onClose()
      await navigate({ to: '/workspace/$workspaceId/chat/$chatId', params: { workspaceId, chatId }, search: { open: formatAsideRef({ kind: 'output', workpieceId: gadget.gadgetId }) } })
    } catch {
      setProblem('Couldn’t start a chat with the agent.')
    } finally {
      overseer[Symbol.dispose]()
      setAsking(false)
    }
  }

  return (
    <>
      <header className="flex items-center gap-2 p-6 pb-2">
        <Button variant="ghost" icon={<CaretLeftIcon weight="bold" />} aria-label="Back to sharing" onClick={onBack} className="-ms-2 text-kumo-subtle hover:text-kumo-default" />
        <h2 className="min-w-0 flex-1 truncate text-lg font-medium text-kumo-default">Snapshot</h2>
        <CloseButton />
      </header>
      <div className="appears flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
        <p className="text-base text-pretty text-kumo-subtle">
          Viewers open a read-only snapshot of this gadget with {owner ? `${owner}’s` : 'your'} stored data. Snapshots come
          with no connections and any writes stay in the viewer’s own copy.
        </p>
        <SnapshotPreview gadgetTitle={gadget.title} workspaceTitle={workspaceTitle} ownerName={owner} {...preview} snapshot={arrived ? preview.snapshot : TAKING} expanded={expanded} onExpandedChange={onExpandedChange} />
        {problem && <Banner title={problem} />}
        <div className="flex shrink-0 items-center justify-end gap-3">
          <p className="text-sm text-kumo-subtle">Snapshot broken?</p>
          <Button variant="primary" disabled={asking} onClick={() => void askAgent()}>Ask agent to fix</Button>
        </div>
      </div>
    </>
  )
}

/**
 * What a workspace reads that someone it is shared with must be able to see with their own
 * account, in the share dialog's place: each by its name, under its service's logo, linked where it
 * has an address, which is what to give them access to first.
 */
const ProtectedResources = ({ gadget, resources, onBack }: { gadget: boolean; resources: ProtectedResource[]; onBack: () => void }) => (
  <>
    <header className="flex items-center gap-2 p-6 pb-2">
      <Button variant="ghost" icon={<CaretLeftIcon weight="bold" />} aria-label="Back to sharing" onClick={onBack} className="-ms-2 text-kumo-subtle hover:text-kumo-default" />
      {/* A heading rather than the dialog's title, which stays the sharing's, kept under it. */}
      <h2 className="min-w-0 flex-1 truncate text-lg font-medium text-kumo-default">Protected resources</h2>
      <CloseButton />
    </header>
    <div className="appears flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-6 pb-6">
      <p className="text-base text-pretty text-kumo-subtle">
        People you add must verify access to these resources before they can use this {gadget ? 'gadget' : 'workspace'}.
      </p>
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
 * does to whom. What its data asks of anyone it is shared with, the resources they must see for
 * themselves, is a page of its own, from its footer.
 */
export const ShareWorkspaceDialog = ({ open, onOpenChange, gadget, ...props }: ShareWorkspaceDialogProps) => {
  const target: ShareTarget = gadget ? { kind: 'gadget', gadgetId: gadget.id, title: gadget.title } : { kind: 'workspace' }
  // Only while it is open: opened again, it is as it first was.
  const [expanded, setExpanded] = useState(false)
  if (!open && expanded) setExpanded(false)
  return (
    <Dialog open={open} onOpenChange={onOpenChange} expanded={expanded}>
      {/* Keyed, so that another workspace, or what is shared of it, is read afresh. */}
      <ShareContent key={`${props.workspaceId} ${props.page} ${gadget?.id ?? ''}`} {...props} target={target} expanded={expanded} onExpandedChange={setExpanded} onClose={() => onOpenChange(false)} />
    </Dialog>
  )
}
