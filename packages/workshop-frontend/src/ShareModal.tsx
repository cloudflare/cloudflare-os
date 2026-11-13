import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useId, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Checkbox, Dialog, DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { CaretDown, CaretLeft, CaretRight, Check, Copy, Link, LockSimple, PencilSimple, ShieldWarning, Trash, UserPlus, UsersThree, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AuthenticatedApi,
  CollaboratorInfo,
  AffectedCollaborator,
  ShareLinkInfo,
  WorkspaceMetadata,
  AiChatAuthorInfo,
  CollaboratorGrant,
  ObserverBindingNeed,
  PermissionEdge,
  WorkpieceId,
} from '@gadgets/workshop-shared/api'
import { WorkshopButton, WorkshopIconButton } from './components/WorkshopControls'
import { PersonAvatar } from './components/PersonAvatar'
import { ComposerChip } from './components/ComposerChip'
import { copyToClipboard } from './clipboard'
import { isImeComposing } from './keyboardEvent'
import { useServerConfig } from './ServerConfigContext'
import { useUserDirectorySearch } from './features/user-directory/useUserDirectorySearch'
import { GatekeeperIcon } from './components/GatekeeperIcon'
import { useVendorBranding, type VendorBranding } from './useVendorBranding'

/**
 * What a share dialog hands out: the workspace, whose members edit every gadget and use chat
 * ("build"), or one gadget's deployed UI.
 */
export type ShareTarget =
  | { kind: 'workspace' }
  | { kind: 'gadget'; gadgetId: WorkpieceId; title: string }

function grantFor(gadgetId: WorkpieceId | undefined): CollaboratorGrant {
  return gadgetId === undefined ? 'workspace' : { gadgetId }
}

// Where a recipient lands: the workspace, opened on the shared gadget if there is one. A share
// link carries its key in the fragment, which browsers never send to a server.
function destinationUrl(workspaceId: string, gadgetId: WorkpieceId | undefined, key?: string): string {
  const url = new URL(`/workspace/${workspaceId}`, window.location.origin)
  if (gadgetId !== undefined) url.searchParams.set('w', String(gadgetId))
  if (key !== undefined) url.hash = `share=${key}`
  return url.href
}

// A person queued in the composer but not yet invited. `error` is set when their invite failed so
// the chip stays for correction while everyone else's goes through.
type StagedRecipient = { id: string; name: string; error?: string }
const NO_IDS: ReadonlySet<string> = new Set()
const NAME_LIST = new Intl.ListFormat('en', { type: 'conjunction' })

function withRecipient(list: StagedRecipient[], recipient: StagedRecipient): StagedRecipient[] {
  return list.some(entry => entry.id === recipient.id) ? list : [...list, recipient]
}

// "Name (id)" when they differ, so two accounts with one display name stay tellable apart.
function recipientLabel({ id, name }: StagedRecipient): string {
  return name === id ? name : `${name} (${id})`
}

type ConfirmationTarget =
  | { kind: 'remove'; profileId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }
  | { kind: 'revoke'; linkId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: WorkspaceMetadata
  target: ShareTarget
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

function formatRelativeTime(date: Date): string {
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes}m ago`
  if (diffHours < 24) return `${diffHours}h ago`
  if (diffDays < 7) return `${diffDays}d ago`
  return date.toLocaleDateString()
}

function InlineConfirm({
  label,
  busy,
  busyLabel,
  tone = 'danger',
  onConfirm,
  onCancel,
}: {
  label: string
  busy: boolean
  busyLabel?: string
  tone?: 'danger' | 'brand'
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="flex items-center gap-1 share-confirm-in">
      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className={`inline-flex h-7 cursor-pointer items-center rounded-lg px-2.5 text-[12px] leading-4 font-medium tracking-[-0.1px] transition-[background-color,transform] duration-150 ease-out active:scale-[0.97] disabled:opacity-60 ${
          tone === 'danger'
            ? 'text-kumo-danger hover:bg-kumo-danger-tint'
            : 'text-kumo-brand hover:bg-kumo-tint'
        }`}
      >
        {busy ? (busyLabel ?? `${label}…`) : label}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        aria-label="Cancel"
        className="grid h-7 w-7 cursor-pointer place-items-center rounded-lg text-kumo-inactive transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-tint hover:text-kumo-default active:scale-[0.96] disabled:opacity-60"
      >
        <X size={14} />
      </button>
    </div>
  )
}

function DependentKeepList({
  dependents,
  keepSet,
  onKeepSetChange,
}: {
  dependents: AffectedCollaborator[]
  keepSet: Set<string>
  onKeepSetChange: (next: Set<string>) => void
}) {
  if (dependents.length === 0) return null

  return (
    <div className="space-y-1.5">
      {dependents.map(dep => (
        <div
          key={dep.profile.id}
          className={`rounded-xl px-3 py-2 transition-colors ${
            keepSet.has(dep.profile.id) ? 'bg-kumo-tint' : 'bg-kumo-elevated/50 hover:bg-kumo-elevated'
          }`}
        >
          <Checkbox
            label={(
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="truncate text-[12px] font-medium text-kumo-default">{dep.profile.name}</span>
                <span className="truncate text-[11px] text-kumo-subtle">{dep.profile.id}</span>
              </span>
            )}
            checked={keepSet.has(dep.profile.id)}
            onCheckedChange={(checked) => {
              const next = new Set(keepSet)
              if (checked) next.add(dep.profile.id)
              else next.delete(dep.profile.id)
              onKeepSetChange(next)
            }}
          />
        </div>
      ))}
    </div>
  )
}

// The trigger of a row's access menu, in the text style of the plain role labels beside it.
const ACCESS_MENU_TRIGGER = 'inline-flex h-8 shrink-0 cursor-pointer items-center gap-1 rounded-lg px-2 text-[13px] text-kumo-default transition-colors hover:bg-kumo-tint disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:bg-kumo-tint'
const ACCESS_LABEL = 'shrink-0 px-2 text-[13px] text-kumo-default'
const ROW_ICON = 'grid h-8 w-8 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-subtle'

// One row of the people list: someone, or something, with access, and what they hold.
function AccessRow({
  avatar,
  title,
  detail,
  trailing,
  highlighted = false,
  children,
}: {
  avatar: ReactNode
  title: ReactNode
  detail?: string
  trailing: ReactNode
  highlighted?: boolean
  children?: ReactNode
}) {
  return (
    <div className={`group rounded-xl px-2 py-2 ${highlighted ? 'share-row-land' : ''}`}>
      <div className="flex items-center gap-3">
        {avatar}
        <div className="min-w-0 flex-1">
          <p className="truncate text-[14px] leading-5 tracking-[-0.25px] text-kumo-default">{title}</p>
          {detail && (
            <p className="truncate text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">{detail}</p>
          )}
        </div>
        {trailing}
      </div>
      {children}
    </div>
  )
}

function DottedDivider() {
  return <hr className="mx-2 my-2 border-0 border-t border-dotted border-kumo-line" />
}

// What a recipient is asked to do before what they were given will open for them. Recipients
// don't inherit the owner's connections: they must point their own account at each connection in
// scope, so sharers should know that cost before they invite anyone.
function ProtectedResourceList({
  requirements,
  failed,
  vendorBranding,
}: {
  requirements: ObserverBindingNeed[]
  failed: boolean
  vendorBranding: Map<string, VendorBranding>
}) {
  if (failed) {
    return (
      <p className="text-[13px] leading-5 tracking-[-0.15px] text-kumo-subtle">
        Couldn’t check which resources recipients will be asked to verify.
      </p>
    )
  }
  return (
    <ul className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-2">
      {requirements.map(requirement => (
        <li key={requirement.gatekeeperId} className="flex min-w-0 items-center gap-3 rounded-xl px-2 py-2">
          <GatekeeperIcon
            vendorId={requirement.vendorId}
            fallbackText={requirement.resourceTitle}
            {...vendorBranding.get(requirement.vendorId)}
            size={20}
            className="h-10 w-10 rounded-xl"
          />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] leading-5 font-medium tracking-[-0.25px] text-kumo-default">
              {requirement.resourceTitle}
            </p>
            {requirement.resourceUrl && (
              <p className="truncate text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
                {requirement.resourceUrl}
              </p>
            )}
          </div>
        </li>
      ))}
    </ul>
  )
}

export default function ShareModal({ open, onClose, overseer, metadata, target, currentUser, authenticatedApi }: Props) {
  const toasts = useKumoToastManager()
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membershipStatus, setMembershipStatus] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [shareLinks, setShareLinks] = useState<ShareLinkInfo[]>([])
  const [addUsername, setAddUsername] = useState('')
  const [staged, setStaged] = useState<StagedRecipient[]>([])
  // Focus stays in the field when a chip is added or removed, so the change is announced here.
  const [composerNotice, setComposerNotice] = useState('')
  const [activeDirectoryIndex, setActiveDirectoryIndex] = useState(0)
  // The result popover is dismissed when focus leaves the combobox or on Escape; typing or
  // refocusing brings it back. The query and its search survive a dismissal.
  const [directoryDismissed, setDirectoryDismissed] = useState(true)
  const directoryListboxId = useId()
  const activeDirectoryOptionRef = useRef<HTMLButtonElement>(null)
  const directoryListboxRef = useRef<HTMLDivElement>(null)
  const directoryAnchorRef = useRef<HTMLDivElement>(null)
  const peopleInputRef = useRef<HTMLInputElement>(null)
  const wasOpenRef = useRef(false)
  const userSearchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const isOwner = !metadata.owner
  const gadgetId = target.kind === 'gadget' ? target.gadgetId : undefined
  const containsRestrictedData = metadata.containsRestrictedData === true
  // The server refuses share links and non-owner invites once this is set; hide those controls.
  const ownerInvitesOnly = metadata.ownerInvitesOnly === true
  const canInvite = !ownerInvitesOnly || isOwner
  const canUseShareLinks = !ownerInvitesOnly
  const directoryQuery = addUsername.trim()
  // Everyone who already holds what this dialog grants -- the caller, the owner (absent from
  // listCollaborators() when the caller is a collaborator), and collaborators with the workspace or
  // with this gadget -- plus everyone already staged. Anyone else can still be given it, such as a
  // gadget's recipient being invited to the whole workspace.
  const directoryExcludeIds = useMemo(() => [
    ...(currentUser ? [currentUser.id] : []),
    ...(metadata.owner ? [metadata.owner.id] : []),
    ...collaborators
      .filter(({ access }) => access.role === 'build' ||
        (gadgetId !== undefined && access.gadgetIds.includes(gadgetId)))
      .map(({ profile }) => profile.id),
    ...staged.map(recipient => recipient.id),
  ], [collaborators, currentUser, gadgetId, metadata.owner, staged])
  const membershipSettled = open && wasOpenRef.current && membershipStatus !== 'loading'
  const membershipReady = membershipSettled && membershipStatus === 'ready'
  const directorySearching = userSearchEnabled && membershipReady && directoryQuery !== ''
  const searchDirectory = useCallback((query: string) =>
    authenticatedApi.searchUsers(query, directoryExcludeIds), [authenticatedApi, directoryExcludeIds])
  const directory = useUserDirectorySearch({
    query: directoryQuery,
    enabled: open && directorySearching,
    search: searchDirectory,
  })
  // Gated on canInvite too: a live metadata update can set ownerInvitesOnly while results are
  // open, unmounting the search field without blurring it, and the popover's scroll lock on the
  // dialog body must not outlive the field.
  const directoryOpen = canInvite && directorySearching && directory.current && !directoryDismissed
  const directorySettled = directory.settled
  const showDirectDirectoryOption = directory.status === 'ready' && directory.results.length > 0
  const directoryOptionCount = directory.results.length + (showDirectDirectoryOption ? 1 : 0)
  const activeDirectoryOptionId = directoryOpen && activeDirectoryIndex < directoryOptionCount
    ? `${directoryListboxId}-option-${activeDirectoryIndex}`
    : undefined
  // Once the search has settled, the typed text can always be staged as a canonical id: the
  // directory is a lazily backfilled convenience, so a valid id may be missing from it (or
  // shadowed by unrelated substring matches), and a directory outage must not block invites.
  // A membership-load failure also falls back to the authoritative direct-invite path.
  const canStage = directoryQuery !== '' && (!userSearchEnabled ||
    (membershipSettled && (!membershipReady || directorySettled)))
  // What the composer holds besides the chips: the highlighted result, else the typed text once
  // it can be staged.
  const highlightedUser = directoryOpen ? directory.results[activeDirectoryIndex] : undefined
  const typedRecipient: StagedRecipient | null = highlightedUser
    ? { id: highlightedUser.id, name: highlightedUser.name }
    : canStage ? { id: directoryQuery, name: directoryQuery } : null
  // Exactly what Invite would send, so the label never counts a typed id that is already a chip.
  const pendingRecipients = typedRecipient ? withRecipient(staged, typedRecipient) : staged
  const inviteCount = pendingRecipients.length
  // Nothing is sent while the field holds text that cannot be staged yet (its search is still
  // pending), so the button waits too: Enter already does, and a click would silently drop the name.
  const canSubmitInvite = inviteCount > 0 && (directoryQuery === '' || typedRecipient !== null)
  const [adding, setAdding] = useState(false)
  const [newLinkNote, setNewLinkNote] = useState('')
  const [requirements, setRequirements] = useState<ObserverBindingNeed[] | null>(null)
  const [requirementsFailed, setRequirementsFailed] = useState(false)
  // A page of the dialog that stands in for the sharing view until its back button.
  const [subpage, setSubpage] = useState<'resources' | 'advanced' | null>(null)
  const vendorBranding = useVendorBranding(authenticatedApi)
  const [creatingLink, setCreatingLink] = useState(false)
  const [creatingDefaultLink, setCreatingDefaultLink] = useState(false)
  const [showLinkComposer, setShowLinkComposer] = useState(false)
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const creatingLinkRef = useRef(false)
  const addingRef = useRef(false)
  const landedTimerRef = useRef<number | null>(null)
  const [directoryPortalContainer, setDirectoryPortalContainer] =
    useState<HTMLDivElement | null>(null)
  // Menus portal here, inside the dialog: Kumo's own body portal paints beneath the dialog, and a
  // host elsewhere on the body is hidden from assistive technology while the dialog is modal.
  const [menuPortalContainer, setMenuPortalContainer] = useState<HTMLDivElement | null>(null)
  const [gadgetTooltip, setGadgetTooltip] = useState<{ linkId: string; pinned: boolean } | null>(null)
  const gadgetTooltipId = useId()
  const [scrolled, setScrolled] = useState(false)
  const [landedPersonIds, setLandedPersonIds] = useState<ReadonlySet<string>>(NO_IDS)
  const [landedShareLinkId, setLandedShareLinkId] = useState<string | null>(null)
  const [editingShareLinkId, setEditingShareLinkId] = useState<string | null>(null)
  const [editingShareLinkNote, setEditingShareLinkNote] = useState('')
  const [savingShareLinkNote, setSavingShareLinkNote] = useState(false)
  const [copyingLinkId, setCopyingLinkId] = useState<string | null>(null)
  const [copiedLinkId, setCopiedLinkId] = useState<string | null>(null)
  const linkNameRef = useRef<HTMLInputElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const savingShareLinkNoteRef = useRef(false)
  const copyingLinkRef = useRef(false)
  const copiedTimerRef = useRef<number | null>(null)
  // Freshly-minted share URLs, kept only in memory for the life of this modal session so repeat
  // Copy clicks on the same link re-use the URL.
  const copiedUrlsRef = useRef<Map<string, string>>(new Map())

  // Focus the link-name field when the composer opens, without scrolling the sticky region
  // (autoFocus would jump the scroll position and shift layout).
  useEffect(() => {
    if (showLinkComposer) {
      linkNameRef.current?.focus({ preventScroll: true })
    }
  }, [showLinkComposer])

  useEffect(() => {
    if (editingShareLinkId) {
      renameInputRef.current?.focus({ preventScroll: true })
      renameInputRef.current?.select()
    }
  }, [editingShareLinkId])

  useEffect(() => {
    return () => {
      if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (open && directorySearching) setActiveDirectoryIndex(0)
  }, [directorySearching, directoryQuery, open, searchDirectory])

  // Keep the listbox inside the dialog's accessibility tree, but outside its scrolling body so
  // opening results cannot make the dialog itself scroll. The anchor grows and shrinks as chips
  // wrap (or a batch settles mid-search), so it is observed as well as the viewport.
  useLayoutEffect(() => {
    if (!directoryOpen) return
    const anchor = directoryAnchorRef.current
    if (!anchor) return
    const position = () => {
      const listbox = directoryListboxRef.current
      const dialog = listbox?.parentElement
      if (!listbox || !dialog) return
      const anchorRect = anchor.getBoundingClientRect()
      const dialogRect = dialog.getBoundingClientRect()
      listbox.style.left = `${anchorRect.left - dialogRect.left}px`
      listbox.style.top = `${anchorRect.bottom - dialogRect.top + 8}px`
      listbox.style.width = `${anchorRect.width}px`
      listbox.style.maxHeight = `${Math.max(0, Math.min(
        205,
        dialogRect.bottom - anchorRect.bottom - 20,
      ))}px`
    }
    position()
    const observer = new ResizeObserver(position)
    observer.observe(anchor)
    const viewport = window.visualViewport
    window.addEventListener('resize', position)
    viewport?.addEventListener('resize', position)
    viewport?.addEventListener('scroll', position)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', position)
      viewport?.removeEventListener('resize', position)
      viewport?.removeEventListener('scroll', position)
    }
  }, [directoryOpen])

  useLayoutEffect(() => {
    if (!directoryOpen) return

    const listbox = directoryListboxRef.current
    const option = activeDirectoryOptionRef.current
    if (!listbox || !option) return

    // scrollIntoView() also scrolls the modal's ancestor scroller. Adjust only the result list so
    // keyboard navigation cannot move the modal underneath its sticky search field.
    const listboxRect = listbox.getBoundingClientRect()
    const optionRect = option.getBoundingClientRect()
    if (optionRect.top < listboxRect.top) {
      listbox.scrollTop -= listboxRect.top - optionRect.top
    } else if (optionRect.bottom > listboxRect.bottom) {
      listbox.scrollTop += optionRect.bottom - listboxRect.bottom
    }
  }, [activeDirectoryIndex, directoryOpen, directory.results])

  const loadData = useCallback(async () => {
    try {
      const [collabs, keys] = await Promise.all([
        overseer.listCollaborators(),
        overseer.listShareLinks(),
      ])
      setCollaborators(collabs)
      setShareLinks(keys)
      setMembershipStatus('ready')
      return { collaborators: collabs, shareLinks: keys }
    } catch (err) {
      console.error('Failed to load share data:', err)
      toasts.add({ title: 'Failed to load sharing info', variant: 'error' })
      setMembershipStatus(current => current === 'ready' ? current : 'failed')
      return null
    }
  }, [overseer])

  // Refresh on focus as well as open: bindings cannot change in this modal, but they can change in
  // another tab while it remains open. A failed refresh is informational and never blocks sharing.
  useEffect(() => {
    if (!open) return
    let cancelled = false
    let requestId = 0
    setRequirements(null)
    const refresh = () => {
      const thisRequest = ++requestId
      setRequirementsFailed(false)
      overseer.listObserverRequirements(grantFor(gadgetId))
        .then(next => {
          if (!cancelled && thisRequest === requestId) setRequirements(next)
        })
        .catch(err => {
          console.error('Failed to load observer requirements:', err)
          if (!cancelled && thisRequest === requestId) setRequirementsFailed(true)
        })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [open, overseer, gadgetId])

  useEffect(() => {
    if (open) {
      setMembershipStatus('loading')
      loadData()
      if (!wasOpenRef.current) {
        setAddUsername('')
        setComposerNotice('')
        // A fresh open starts the composer over, except for people whose invite is still in flight
        // or has failed: their chip is the only record of the outcome.
        const inFlight = addingRef.current
        setStaged(current => inFlight ? current : current.filter(recipient => recipient.error))
        setNewLinkNote('')
        setShowLinkComposer(false)
        setSubpage(null)
        setConfirmationTarget(null)
        setEditingShareLinkId(null)
        setEditingShareLinkNote('')
        setCopiedLinkId(null)
        setCopyingLinkId(null)
        setGadgetTooltip(null)
        if (copiedTimerRef.current !== null) {
          window.clearTimeout(copiedTimerRef.current)
          copiedTimerRef.current = null
        }
        copiedUrlsRef.current.clear()
      }
    } else {
      setMembershipStatus('loading')
    }
    wasOpenRef.current = open
  }, [open, loadData])

  const ownerProfile: AiChatAuthorInfo | null = isOwner ? currentUser : (metadata.owner ?? null)
  // The workspace dialog lists the workspace's members. A gadget's lists the people given that
  // gadget, since every member holds it anyway: the gadget dialog sums them up in one row. The
  // workspace dialog gives the viewer their own row.
  const members = collaborators.filter(({ profile, access }) => profile.id !== currentUser?.id &&
    (gadgetId === undefined
      ? access.role === 'build'
      : access.role === 'use' && access.gadgetIds.includes(gadgetId)))
  // Anyone besides the viewer who can open what the plain (secret-free) URL leads to.
  const othersHaveAccess = !isOwner || collaborators.some(({ profile, access }) =>
    profile.id !== currentUser?.id &&
    (access.role === 'build' || (gadgetId !== undefined && access.gadgetIds.includes(gadgetId))))
  const sortedShareLinks = useMemo(
    () => [...shareLinks].toSorted((a, b) => b.created.getTime() - a.created.getTime()),
    [shareLinks],
  )
  // Links to one gadget name it; a link naming none grants the workspace, or the several gadgets
  // it lists, which stay with the workspace since no one gadget's dialog owns them.
  const visibleShareLinks = sortedShareLinks.filter(link => link.gadgetId === gadgetId)
  // The viewer's own default link gets the "Anyone with your link" control; every other link,
  // including other people's defaults, is managed on the dialog's Advanced page. Once share links
  // are disabled (`ownerInvitesOnly`) no link grants anything, so the control would misstate the
  // link's effect: it goes, and a leftover default link is listed with the others to be revoked.
  const myDefaultLink = canUseShareLinks
    ? visibleShareLinks.find(link => link.default && link.createdBy.id === currentUser?.id)
    : undefined
  // Only the owner and a link's creator can copy, rename or revoke it, so anyone else's links
  // aren't listed to a collaborator; they still explain how people joined.
  const advancedShareLinks = visibleShareLinks.filter(link => link !== myDefaultLink &&
    (isOwner || link.createdBy.id === currentUser?.id))
  const linkAccessLabel = gadgetId === undefined ? 'Can join' : 'Can use'
  // Someone who can't invite has no recipient to verify. While loading, show nothing rather than
  // reserve space for an answer we don't have yet.
  const showResourcesPill = canInvite && (requirementsFailed || (requirements?.length ?? 0) > 0)
  const showAdvancedButton = canUseShareLinks || advancedShareLinks.length > 0
  const shownSubpage = subpage === 'resources' && showResourcesPill ? 'resources'
    : subpage === 'advanced' && showAdvancedButton ? 'advanced'
    : null
  const removeTarget = confirmationTarget?.kind === 'remove' ? confirmationTarget : null
  const revokeTarget = confirmationTarget?.kind === 'revoke' ? confirmationTarget : null
  const defaultLinkRevoke = myDefaultLink && revokeTarget?.linkId === myDefaultLink.linkId
    ? revokeTarget : null

  // The edges granting what this dialog grants, ignoring someone's grants of anything else.
  const scopedEdges = (info: CollaboratorInfo): PermissionEdge[] => info.addedBy.filter(edge =>
    ((edge.role ?? 'build') === 'build' ? 'workspace' : edge.gadgetId) === (gadgetId ?? 'workspace'))

  // The server lets a non-owner remove only the access they granted directly; see removeCollaborator.
  const canRemove = (info: CollaboratorInfo): boolean => isOwner || scopedEdges(info).some(edge =>
    edge.type === 'user' && edge.sharer === currentUser?.id)
  const removableMembers = members.filter(canRemove)
  const otherMembers = members.filter(info => !canRemove(info))

  const sharerName = (profileId: string): string => {
    if (profileId === currentUser?.id) return 'you'
    if (ownerProfile && profileId === ownerProfile.id) return ownerProfile.name
    return collaborators.find(({ profile }) => profile.id === profileId)?.profile.name ?? profileId
  }

  // Whether `sourceId` (a sharer, or a link's creator) still confers what they granted. Revocation
  // is lazy (see the backend's sharing.ts): the graph keeps an edge from someone who has since lost
  // access, so it comes back if they do, but until then it grants nothing. A grant counts only
  // while its source is the owner or holds "build".
  const sourceConfers = (sourceId: string): boolean => sourceId === ownerProfile?.id ||
    collaborators.some(({ profile, access }) => profile.id === sourceId && access.role === 'build')

  // Why someone is here, from the edges that still grant what this dialog grants; undefined if
  // none do. A revoked link is absent from `shareLinks`, and once the workspace is
  // owner-invites-only only the owner's direct grants count.
  const describeAccess = (info: CollaboratorInfo): string | undefined => {
    const reasons = scopedEdges(info).flatMap(edge => {
      if (edge.type === 'user') {
        if (ownerInvitesOnly ? edge.sharer !== ownerProfile?.id : !sourceConfers(edge.sharer)) return []
        return [`Invited by ${sharerName(edge.sharer)}`]
      }
      const creator = shareLinks.find(item => item.linkId === edge.keyId)?.createdBy
      if (!creator || ownerInvitesOnly || !sourceConfers(creator.id)) return []
      return [creator.id === currentUser?.id ? 'Joined with your link' : `Joined with ${creator.name}’s link`]
    })
    return reasons.length > 0 ? [...new Set(reasons)].join(' · ') : undefined
  }
  // The viewer's own row says how they got in, as everyone else's does.
  const viewerRecord = collaborators.find(({ profile }) => profile.id === currentUser?.id)
  const viewerAccessDetail = viewerRecord && describeAccess(viewerRecord)

  // Where someone who already has access opens what this dialog grants. Access was granted
  // already, so this carries no secret and is safe to show and re-show — unlike a share link's URL.
  const accessUrl = destinationUrl(metadata.id, gadgetId)

  // The footer's link: the viewer's own link while it's on, else the plain URL, which opens only
  // for people who already have access.
  const copyDialogLink = async () => {
    if (myDefaultLink && canUseShareLinks) {
      await handleCopyShareLink(myDefaultLink)
    } else if (await copyToClipboard(accessUrl)) {
      toasts.add({ title: 'Link copied to clipboard.', variant: 'success' })
    } else {
      toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
    }
  }
  const footerCopiesMyLink = myDefaultLink !== undefined && canUseShareLinks

  const showLandedRow = (kind: 'person' | 'shareLink', ids: string[]) => {
    if (landedTimerRef.current !== null) window.clearTimeout(landedTimerRef.current)
    setLandedPersonIds(kind === 'person' ? new Set(ids) : NO_IDS)
    setLandedShareLinkId(kind === 'shareLink' ? ids[0] : null)
    landedTimerRef.current = window.setTimeout(() => {
      setLandedPersonIds(NO_IDS)
      setLandedShareLinkId(null)
      landedTimerRef.current = null
    }, 2200)
  }

  // Queue a person in the composer and clear the field for the next name. Focus stays in the
  // input so a run of names can be entered without reaching for the mouse.
  const stageRecipient = (recipient: StagedRecipient) => {
    const label = recipientLabel(recipient)
    setComposerNotice(staged.some(entry => entry.id === recipient.id)
      ? `${label} is already listed.`
      : `Added ${label}.`)
    setStaged(current => withRecipient(current, recipient))
    setAddUsername('')
    peopleInputRef.current?.focus({ preventScroll: true })
    setDirectoryDismissed(true)
  }

  const removeStaged = (recipient: StagedRecipient) => {
    setComposerNotice(`Removed ${recipientLabel(recipient)}.`)
    setStaged(current => current.filter(entry => entry.id !== recipient.id))
    peopleInputRef.current?.focus({ preventScroll: true })
  }

  const handleDirectoryKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (isImeComposing(event)) return
    if (event.key === 'Enter') {
      event.preventDefault()
      if (typedRecipient) stageRecipient(typedRecipient)
      else if (directoryQuery === '' && staged.length > 0) void handleInvite()
      return
    }
    if (event.key === 'Backspace' && addUsername === '' && staged.length > 0 && !adding) {
      event.preventDefault()
      removeStaged(staged[staged.length - 1])
      return
    }
    if (!directorySearching) return
    if (event.key === 'Escape' && directoryOpen) {
      // Closes only the popover; the dialog would otherwise take the same keypress.
      event.preventDefault()
      event.stopPropagation()
      setDirectoryDismissed(true)
      return
    }
    if (directoryOptionCount > 0 && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault()
      if (!directoryOpen) {
        setDirectoryDismissed(false)
        return
      }
      const direction = event.key === 'ArrowDown' ? 1 : -1
      setActiveDirectoryIndex(current =>
        (current + direction + directoryOptionCount) % directoryOptionCount)
    }
  }

  // Invite everyone staged, plus whatever the composer still holds. Each addCollaborator() call is
  // independently atomic and idempotent on the server, so they are all issued up front (pipelined
  // over the one connection) and the membership list is refetched once. Failures are not toasted:
  // the person's chip stays in the composer carrying the reason, so it can be fixed and resent.
  // The composer stays live meanwhile: more people can be staged (they wait for the next batch)
  // but none removed, since a call already issued cannot be cancelled.
  const handleInvite = async (extra: StagedRecipient | null = null) => {
    const recipients = extra ? withRecipient(staged, extra) : staged
    if (recipients.length === 0 || addingRef.current) return
    if (extra) stageRecipient(extra)

    addingRef.current = true
    setAdding(true)
    try {
      const settled = await Promise.allSettled(
        recipients.map(recipient => overseer.addCollaborator(recipient.id, grantFor(gadgetId), undefined)))
      const added: AiChatAuthorInfo[] = []
      const failed: StagedRecipient[] = []
      settled.forEach((outcome, index) => {
        const recipient = recipients[index]
        if (outcome.status === 'rejected') {
          const { reason } = outcome
          failed.push({
            ...recipient,
            error: reason instanceof Error ? reason.message : 'Failed to add collaborator.',
          })
        } else if (outcome.value === null) {
          failed.push({ ...recipient, error: 'No account found for that username or email.' })
        } else {
          added.push(outcome.value.profile)
        }
      })
      // Touch only the chips this batch sent: drop the added, keep the failed with their reason,
      // and leave anything staged since the batch started where it is.
      const batch = new Set(recipients.map(recipient => recipient.id))
      const failure = new Map(failed.map(recipient => [recipient.id, recipient]))
      setStaged(current => current.flatMap(recipient => {
        if (!batch.has(recipient.id)) return [recipient]
        const outcome = failure.get(recipient.id)
        return outcome ? [outcome] : []
      }))
      if (added.length > 0) {
        const names = added.map(profile => profile.name)
        await loadData()
        showLandedRow('person', added.map(profile => profile.id))
        toasts.add({
          title: `Added ${NAME_LIST.format(names)} as ${names.length === 1 ? 'a collaborator' : 'collaborators'}.`,
          variant: 'success',
        })
      }
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleCreateShareLink = async () => {
    if (creatingLinkRef.current) return
    creatingLinkRef.current = true
    setCreatingLink(true)
    try {
      const { key, linkId } = await overseer.createShareLink(
        grantFor(gadgetId), newLinkNote.trim() || undefined)
      const url = destinationUrl(metadata.id, gadgetId, key)
      setNewLinkNote('')
      setShowLinkComposer(false)
      // The new row's Copy reuses the key minted here, so its first copy needs no round trip.
      copiedUrlsRef.current.set(linkId, url)
      await loadData()
      showLandedRow('shareLink', [linkId])
    } catch (err: any) {
      // Keep the composer and its values open so the user can retry without re-entering them.
      toasts.add({ title: err.message || 'Failed to create share link.', variant: 'error' })
    } finally {
      creatingLinkRef.current = false
      setCreatingLink(false)
    }
  }

  // Turning "Anyone with your link" on. Turning it off is a revocation, confirmed in place.
  const handleEnableDefaultLink = async () => {
    setCreatingDefaultLink(true)
    try {
      const { key, linkId } = await overseer.createShareLink(
        grantFor(gadgetId), undefined, { default: true })
      // Kept so the first Copy needs no round trip and lands within the click's user activation.
      copiedUrlsRef.current.set(linkId, destinationUrl(metadata.id, gadgetId, key))
      await loadData()
    } catch (err: unknown) {
      toasts.add({
        title: err instanceof Error && err.message ? err.message : 'Failed to turn on link sharing.',
        variant: 'error',
      })
    } finally {
      setCreatingDefaultLink(false)
    }
  }

  // Copy a share link again. Secrets are never stored, so the previously-shown URL can't be
  // re-displayed. We mint a new secret for the same logical link and copy that.
  const handleCopyShareLink = async (link: ShareLinkInfo) => {
    const { linkId } = link
    if (copyingLinkRef.current) return
    copyingLinkRef.current = true
    setCopyingLinkId(linkId)
    try {
      // Re-use a URL already minted for this link during this session.
      let url = copiedUrlsRef.current.get(linkId)
      if (!url) {
        const { key } = await overseer.newShareLinkKey(linkId)
        url = destinationUrl(metadata.id, link.gadgetId, key)
        copiedUrlsRef.current.set(linkId, url)
      }
      const copied = await copyToClipboard(url)
      if (!copied) {
        toasts.add({ title: 'Could not copy share link.', variant: 'error' })
        return
      }
      setCopiedLinkId(linkId)
      showLandedRow('shareLink', [linkId])
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current)
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedLinkId(current => (current === linkId ? null : current))
        copiedTimerRef.current = null
      }, 2000)
      toasts.add({ title: 'Link copied to clipboard.', variant: 'success' })
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to copy share link.', variant: 'error' })
    } finally {
      copyingLinkRef.current = false
      setCopyingLinkId(null)
    }
  }

  const handleStartRemoveCollaborator = async (profileId: string) => {
    setConfirmationTarget({ kind: 'remove', profileId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRemoveCollaborator(profileId, gadgetId)
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'remove' && current.profileId === profileId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview collaborator removal.', variant: 'error' })
    }
  }

  const handleConfirmRemoveCollaborator = async () => {
    if (!removeTarget || removeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      const removed = await overseer.removeCollaborator(
        removeTarget.profileId, [...removeTarget.keepSet], gadgetId)
      setConfirmationTarget(null)
      toasts.add({
        title: removed.length > 0
          ? (gadgetId === undefined ? 'Collaborator removed.' : 'Removed their access to this gadget.')
          : 'Your direct grant was removed. This collaborator still has access through another source.',
        variant: 'success',
      })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to remove collaborator.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  const startRenameShareLink = (link: ShareLinkInfo) => {
    // Renaming and the destructive confirm are mutually exclusive in-place editors on the same row.
    setConfirmationTarget(null)
    setEditingShareLinkId(link.linkId)
    setEditingShareLinkNote(link.note ?? '')
  }

  const cancelRenameShareLink = () => {
    setEditingShareLinkId(null)
    setEditingShareLinkNote('')
  }

  const handleSaveShareLinkNote = async () => {
    if (!editingShareLinkId || savingShareLinkNoteRef.current) return
    const linkId = editingShareLinkId
    const note = editingShareLinkNote.trim()
    if (note === (shareLinks.find(link => link.linkId === linkId)?.note ?? '')) {
      cancelRenameShareLink()
      return
    }
    savingShareLinkNoteRef.current = true
    setSavingShareLinkNote(true)
    try {
      await overseer.updateShareLink(linkId, note || undefined)
      cancelRenameShareLink()
      await loadData()
      showLandedRow('shareLink', [linkId])
      toasts.add({ title: 'Share link renamed.', variant: 'success' })
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to rename share link.', variant: 'error' })
    } finally {
      savingShareLinkNoteRef.current = false
      setSavingShareLinkNote(false)
    }
  }

  const handleStartRevokeShareLink = async (linkId: string) => {
    cancelRenameShareLink()
    setConfirmationTarget({ kind: 'revoke', linkId, dependents: [], previewing: true, keepSet: new Set() })
    try {
      const dependents = await overseer.previewRevokeShareLink(linkId)
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId
        ? { ...current, dependents, previewing: false }
        : current)
    } catch (err: any) {
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId ? null : current)
      toasts.add({ title: err.message || 'Failed to preview share-link revocation.', variant: 'error' })
    }
  }

  const handleConfirmRevokeShareLink = async () => {
    if (!revokeTarget || revokeTarget.previewing || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      await overseer.revokeShareLink(revokeTarget.linkId, [...revokeTarget.keepSet])
      setConfirmationTarget(null)
      toasts.add({ title: 'Share link revoked.', variant: 'success' })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  // One collaborator's row: who they are, why they're here, and, where the viewer may remove them,
  // the removal flow with its choice of dependents to keep.
  const renderCollaborator = (info: CollaboratorInfo) => {
    const { profile } = info
    const removing = removeTarget?.profileId === profile.id ? removeTarget : null
    const downstreamDependents = removing
      ? removing.dependents.filter(dep => dep.profile.id !== profile.id)
      : []
    // A gadget dialog lists only the people given that gadget, who use it rather than belong.
    const accessLabel = gadgetId === undefined ? 'Member' : 'Can use'
    let trailing: ReactNode = <span className={ACCESS_LABEL}>{accessLabel}</span>
    if (removing) {
      trailing = (
        <InlineConfirm
          label="Remove"
          busy={removing.previewing || confirmationBusy}
          busyLabel={removing.previewing ? 'Checking…' : undefined}
          onConfirm={handleConfirmRemoveCollaborator}
          onCancel={() => setConfirmationTarget(null)}
        />
      )
    } else if (canRemove(info)) {
      trailing = (
        <DropdownMenu>
          <DropdownMenu.Trigger
            render={(
              <button type="button" aria-label={`${profile.name}: ${accessLabel}`} className={ACCESS_MENU_TRIGGER} disabled={confirmationBusy}>
                {accessLabel} <CaretDown size={13} />
              </button>
            )}
          />
          <DropdownMenu.Content container={menuPortalContainer} align="end">
            <DropdownMenu.Item
              variant="danger"
              icon={<Trash size={14} />}
              aria-label={`Remove ${profile.name}`}
              onClick={() => handleStartRemoveCollaborator(profile.id)}
            >
              Remove
            </DropdownMenu.Item>
          </DropdownMenu.Content>
        </DropdownMenu>
      )
    }
    return (
      <AccessRow
        key={profile.id}
        avatar={<PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={32} />}
        title={profile.name}
        detail={describeAccess(info) ?? 'Member'}
        trailing={trailing}
        highlighted={landedPersonIds.has(profile.id)}
      >
        {removing && downstreamDependents.length > 0 && (
          <div className="mt-2.5 share-expand-in">
            <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
              {downstreamDependents.length} other {downstreamDependents.length === 1 ? 'person loses' : 'people lose'} access through {profile.name}. Keep anyone?
            </p>
            <DependentKeepList
              dependents={downstreamDependents}
              keepSet={removing.keepSet}
              onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                current?.kind === 'remove' && current.profileId === profile.id
                  ? { ...current, keepSet }
                  : current
              )}
            />
          </div>
        )}
      </AccessRow>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 !outline-none"
        size="lg"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          {shownSubpage ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <WorkshopIconButton aria-label="Back to sharing" onClick={() => setSubpage(null)}>
                <CaretLeft size={16} />
              </WorkshopIconButton>
              <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
                {shownSubpage === 'resources' ? 'Protected resources' : 'Advanced'}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                {shownSubpage === 'resources'
                  ? 'What recipients must verify before they can open what you share.'
                  : 'Manage share links.'}
              </Dialog.Description>
            </div>
          ) : (
          <div className="min-w-0 pt-1">
            <Dialog.Title className="truncate text-[17px] leading-6 font-medium tracking-[-0.3px] text-kumo-default">
              {target.kind === 'gadget' ? 'Share' : 'Invite to'}{' '}
              <span className="text-kumo-subtle">“{target.kind === 'gadget' ? target.title : metadata.title}”</span>
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.15px] text-kumo-subtle">
              {target.kind === 'gadget'
                ? 'People you add can use this gadget without seeing anything else in the workspace.'
                : ownerInvitesOnly
                  ? 'People you add can create chats and edit gadgets.'
                  : 'People you add can create chats, edit gadgets, and invite other users.'}
            </Dialog.Description>
          </div>
          )}
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={18} />
              </WorkshopIconButton>
            )}
          />
        </div>

        {shownSubpage === 'resources' && (
          <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6">
            <p className="mb-4 text-[14px] leading-5 tracking-[-0.2px] text-kumo-subtle">
              A recipient must have their own access to these resources before they can open
              this {gadgetId === undefined ? 'workspace' : 'gadget'}.
            </p>
            <ProtectedResourceList
              requirements={requirements ?? []}
              failed={requirementsFailed}
              vendorBranding={vendorBranding}
            />
          </div>
        )}
        <div
          className={`chat-panel min-h-0 flex-1 overscroll-contain px-4 pb-6 sm:px-6 ${shownSubpage ? 'hidden' : ''} ${directoryOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
        >
          {(containsRestrictedData || ownerInvitesOnly) && (
            <div className="mb-3 flex items-start gap-2.5 rounded-2xl bg-kumo-warning-tint px-3 py-2.5">
              <div className="grid h-6 w-6 shrink-0 place-items-center text-kumo-warning">
                <ShieldWarning size={18} weight="duotone" />
              </div>
              {ownerInvitesOnly ? (
                <p className="text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-default">
                  This workspace has read data from a connection that doesn’t allow share links, so
                  only the owner can add people. People the owner invites are asked to verify their
                  own access to the connections it uses — some may be unable to
                  open it. Anything the workspace has already saved is visible to everyone who can.
                </p>
              ) : (
                <p className="text-[12px] leading-[18px] tracking-[-0.1px] text-kumo-default">
                  This workspace has read sensitive data. People you invite are asked to verify their
                  own access to the connections it uses — some may be unable to
                  open it. Anything the workspace has already saved is visible to everyone who can.
                </p>
              )}
            </div>
          )}
          {canInvite && (
          <div className={`sticky top-0 z-10 bg-kumo-base pb-3 transition-shadow duration-200 ${scrolled ? 'themed-bottom-shadow border-b border-kumo-line/60' : ''}`}>
          <div
            ref={directoryAnchorRef}
            data-testid="people-composer"
            className="grid min-h-12 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-elevated p-1.5 pl-4 transition-[border-color,box-shadow] focus-within:border-kumo-fill sm:flex"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {staged.map(recipient => (
                <ComposerChip
                  key={recipient.id}
                  label={recipient.name}
                  detail={recipient.name !== recipient.id ? recipient.id : undefined}
                  title={recipient.error ?? (recipient.name !== recipient.id ? recipient.id : undefined)}
                  error={Boolean(recipient.error)}
                  removeLabel={`Remove ${recipientLabel(recipient)}`}
                  disabled={adding}
                  onRemove={() => removeStaged(recipient)}
                />
              ))}
              <input
                ref={peopleInputRef}
                type="search"
                role={userSearchEnabled ? 'combobox' : undefined}
                placeholder={userSearchEnabled ? 'Add emails or names…' : 'Username or email'}
                aria-label={userSearchEnabled ? 'Search people' : 'Username or email'}
                aria-autocomplete={userSearchEnabled ? 'list' : undefined}
                aria-expanded={userSearchEnabled ? directoryOpen : undefined}
                aria-controls={directoryOpen ? directoryListboxId : undefined}
                aria-activedescendant={activeDirectoryOptionId}
                value={addUsername}
                onChange={(event) => {
                  setAddUsername(event.target.value)
                  setDirectoryDismissed(false)
                }}
                onFocus={() => setDirectoryDismissed(false)}
                onBlur={() => setDirectoryDismissed(true)}
                onKeyDown={handleDirectoryKeyDown}
                name="gadget-share-people-search"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                data-keeper-ignore="true"
                data-1p-ignore="true"
                data-lpignore="true"
                data-bwignore="true"
                data-form-type="other"
                className="h-9 min-w-0 grow basis-32 appearance-none border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive disabled:cursor-not-allowed [&::-webkit-search-cancel-button]:hidden"
              />
            </div>
            <WorkshopButton
              className="col-span-2 w-full !h-9 !rounded-xl !bg-kumo-base shadow-xs sm:col-span-1 sm:w-auto sm:min-w-[68px]"
              onMouseDown={(event) => {
                // Keep the visible result highlighted until the click handler chooses it.
                if (directoryOpen) event.preventDefault()
              }}
              onClick={() => void handleInvite(typedRecipient)}
              disabled={!canSubmitInvite || adding}
            >
              {adding ? 'Inviting…' : inviteCount > 1 ? `Invite ${inviteCount} people` : 'Invite'}
            </WorkshopButton>
            {directoryOpen && directoryPortalContainer && createPortal(
              <div
                ref={directoryListboxRef}
                id={directoryListboxId}
                role="listbox"
                aria-label="Matching people"
                aria-busy={directory.status === 'loading'}
                // Pressing anywhere in the popover (an option, its padding, the scrollbar) must not
                // blur the combobox, which would dismiss the popover before the click lands.
                onMouseDown={(event) => event.preventDefault()}
                className="chat-panel themed-floating-shadow-lg pointer-events-auto absolute overscroll-contain overflow-y-auto rounded-xl border border-kumo-line/70 bg-kumo-base p-2"
              >
                {directory.status === 'loading' ? (
                  <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">Searching…</p>
                ) : directory.status === 'failed' ? (
                  <p role="status" className="px-3 py-2 text-[12px] text-kumo-danger">
                    User search is temporarily unavailable.
                  </p>
                ) : directory.results.length === 0 ? (
                  <p role="status" className="px-3 py-2 text-[12px] text-kumo-subtle">No users found.</p>
                ) : (
                  <>
                    {directory.results.map((user, index) => (
                      <button
                        key={user.id}
                        ref={index === activeDirectoryIndex ? activeDirectoryOptionRef : undefined}
                        id={`${directoryListboxId}-option-${index}`}
                        type="button"
                        role="option"
                        aria-selected={index === activeDirectoryIndex}
                        onMouseEnter={() => setActiveDirectoryIndex(index)}
                        onClick={() => stageRecipient({ id: user.id, name: user.name })}
                        className={`flex w-full items-center gap-3 rounded-xl px-3 py-2 text-left ${
                          index === activeDirectoryIndex ? 'bg-kumo-tint' : 'hover:bg-kumo-tint/70'
                        }`}
                      >
                        <PersonAvatar api={authenticatedApi} userId={user.id} name={user.name} size={32} />
                        <span className="min-w-0">
                          <span className="block truncate text-[13px] font-medium text-kumo-default">
                            {user.name}
                          </span>
                          <span className="block truncate font-mono text-[11px] text-kumo-subtle">
                            {user.id}
                          </span>
                        </span>
                      </button>
                    ))}
                    <button
                      ref={activeDirectoryIndex === directory.results.length
                        ? activeDirectoryOptionRef
                        : undefined}
                      id={`${directoryListboxId}-option-${directory.results.length}`}
                      type="button"
                      role="option"
                      aria-selected={activeDirectoryIndex === directory.results.length}
                      onMouseEnter={() => setActiveDirectoryIndex(directory.results.length)}
                      onClick={() => stageRecipient({ id: directoryQuery, name: directoryQuery })}
                      className={`mt-1 flex w-full items-center gap-3 rounded-xl border-t border-kumo-line/60 px-3 py-2 text-left ${
                        activeDirectoryIndex === directory.results.length
                          ? 'bg-kumo-tint'
                          : 'hover:bg-kumo-tint/70'
                      }`}
                    >
                      <UserPlus size={15} className="shrink-0 text-kumo-subtle" />
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-medium text-kumo-default">
                          Add &ldquo;{directoryQuery}&rdquo; exactly
                        </span>
                        <span className="block text-[11px] text-kumo-subtle">
                          Use the text as a username or email
                        </span>
                      </span>
                    </button>
                  </>
                )}
              </div>,
              directoryPortalContainer,
            )}
          </div>
          <p role="status" aria-live="polite" className="sr-only">{composerNotice}</p>
          {staged.some(recipient => recipient.error) && (
            <p role="alert" className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-danger">
              {staged.filter(recipient => recipient.error).map(recipient => (
                <span key={recipient.id} className="block break-words">
                  {recipientLabel(recipient)}: {recipient.error}
                </span>
              ))}
            </p>
          )}

          </div>
          )}

          <section aria-labelledby="people-heading" className="mt-3">
            <h3 id="people-heading" className="sr-only">People with access</h3>
            {gadgetId !== undefined ? (
              <AccessRow
                avatar={<div className={ROW_ICON}><UsersThree size={15} /></div>}
                title={<>Members of this workspace <span className="text-kumo-subtle">(You)</span></>}
                trailing={<span className={ACCESS_LABEL}>Can edit</span>}
              />
            ) : currentUser && (
              <AccessRow
                avatar={<PersonAvatar api={authenticatedApi} userId={currentUser.id} name={currentUser.name} size={32} />}
                title={<>{currentUser.name} <span className="text-kumo-subtle">(You)</span></>}
                detail={isOwner ? 'Created this workspace' : viewerAccessDetail}
                trailing={<span className={ACCESS_LABEL}>{isOwner ? 'Owner' : 'Member'}</span>}
              />
            )}
            {currentUser && canUseShareLinks && (
              <AccessRow
                avatar={<div className={ROW_ICON}><Link size={15} /></div>}
                title="Anyone with your link"
                trailing={defaultLinkRevoke ? (
                  <InlineConfirm
                    label="Turn off"
                    busy={defaultLinkRevoke.previewing || confirmationBusy}
                    busyLabel={defaultLinkRevoke.previewing ? 'Checking…' : undefined}
                    onConfirm={handleConfirmRevokeShareLink}
                    onCancel={() => setConfirmationTarget(null)}
                  />
                ) : (
                  <DropdownMenu>
                    <DropdownMenu.Trigger
                      render={(
                        <button
                          type="button"
                          aria-label={`Anyone with your link: ${myDefaultLink ? linkAccessLabel : 'Requires invite'}`}
                          className={ACCESS_MENU_TRIGGER}
                          disabled={creatingDefaultLink || confirmationBusy}
                        >
                          {myDefaultLink ? linkAccessLabel : 'Requires invite'} <CaretDown size={13} />
                        </button>
                      )}
                    />
                    <DropdownMenu.Content container={menuPortalContainer} align="end">
                      <DropdownMenu.RadioGroup
                        value={myDefaultLink ? 'access' : 'none'}
                        onValueChange={(value: 'access' | 'none') => {
                          if (value === 'access' && !myDefaultLink) void handleEnableDefaultLink()
                          if (value === 'none' && myDefaultLink) void handleStartRevokeShareLink(myDefaultLink.linkId)
                        }}
                      >
                        <DropdownMenu.RadioItem value="access" closeOnClick>
                          {linkAccessLabel}
                          <DropdownMenu.RadioItemIndicator />
                        </DropdownMenu.RadioItem>
                        <DropdownMenu.RadioItem value="none" closeOnClick>
                          Requires invite
                          <DropdownMenu.RadioItemIndicator />
                        </DropdownMenu.RadioItem>
                      </DropdownMenu.RadioGroup>
                    </DropdownMenu.Content>
                  </DropdownMenu>
                )}
              >
                {defaultLinkRevoke && defaultLinkRevoke.dependents.length > 0 && (
                  <div className="mt-2.5 share-expand-in">
                    <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                      {defaultLinkRevoke.dependents.length} {defaultLinkRevoke.dependents.length === 1 ? 'person loses' : 'people lose'} access through your link. Keep anyone?
                    </p>
                    <DependentKeepList
                      dependents={defaultLinkRevoke.dependents}
                      keepSet={defaultLinkRevoke.keepSet}
                      onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                        current?.kind === 'revoke' && current.linkId === defaultLinkRevoke.linkId
                          ? { ...current, keepSet }
                          : current
                      )}
                    />
                  </div>
                )}
              </AccessRow>
            )}
            {/* In the link row's place, sized as it is (an AccessRow: 8px padding around a 32px
                icon), so the list below doesn't shift when the restriction arrives mid-session. */}
            {currentUser && !canUseShareLinks && (
              <div role="note" aria-label="Share links are off" className="flex items-center gap-3 rounded-xl bg-kumo-warning-tint px-2 py-2">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-kumo-warning">
                  <LockSimple size={15} weight="bold" />
                </div>
                <p className="min-w-0 flex-1 truncate text-[14px] leading-5 tracking-[-0.25px] text-kumo-default">
                  Share links are off{' '}
                  <span className="text-kumo-subtle">
                    · {isOwner ? 'add each person directly' : 'only the owner can add people'}
                  </span>
                </p>
              </div>
            )}
            {/* The gadget dialog lists only the people given the gadget, so it shows no owner. */}
            {(removableMembers.length > 0 || otherMembers.length > 0 || (!isOwner && gadgetId === undefined)) && (
              <DottedDivider />
            )}
            {removableMembers.map(renderCollaborator)}
            {removableMembers.length > 0 && (otherMembers.length > 0 || (!isOwner && gadgetId === undefined)) && (
              <DottedDivider />
            )}
            {!isOwner && gadgetId === undefined && ownerProfile && (
              <AccessRow
                avatar={<PersonAvatar api={authenticatedApi} userId={ownerProfile.id} name={ownerProfile.name} size={32} />}
                title={ownerProfile.name}
                detail="Created this workspace"
                trailing={<span className={ACCESS_LABEL}>Owner</span>}
              />
            )}
            {otherMembers.map(renderCollaborator)}
          </section>
        </div>

        {shownSubpage === 'advanced' && (
        <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6">
          {canUseShareLinks && (
          <div className="mt-2">
            {showLinkComposer ? (
                <div className="themed-compact-shadow flex h-12 items-center gap-2 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      <Link size={15} />
                    </div>
                    <input
                      ref={linkNameRef}
                      value={newLinkNote}
                      onChange={(e) => setNewLinkNote(e.target.value)}
                      onKeyDown={(e) => { if (!isImeComposing(e) && e.key === 'Enter') handleCreateShareLink() }}
                      placeholder="Name this link (optional)…"
                      aria-label="Share link name (optional)"
                      className="h-9 min-w-0 flex-1 border-0 bg-transparent p-0 text-[14px] leading-5 tracking-[-0.25px] text-kumo-default outline-none placeholder:text-kumo-inactive"
                      disabled={creatingLink}
                    />
                    <WorkshopButton tone="primary" className="shrink-0 !rounded-xl" onClick={handleCreateShareLink} disabled={creatingLink}>
                      {creatingLink ? 'Creating…' : 'Create link'}
                    </WorkshopButton>
                    <WorkshopIconButton aria-label="Cancel creating link" onClick={() => setShowLinkComposer(false)}>
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowLinkComposer(true)}
                className="themed-compact-shadow flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-elevated/60 hover:text-kumo-default active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Link size={14} /> Create a custom share link
              </button>
            )}
          </div>
          )}
          {advancedShareLinks.length > 0 && (
          <section aria-labelledby="links-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="links-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                Custom share links
              </h3>
            </div>

              <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
                {advancedShareLinks.map((sk, index) => {
                  const isRevoking = revokeTarget?.linkId === sk.linkId
                  const isRenaming = editingShareLinkId === sk.linkId
                  // Default links are named for who made them, not by a note.
                  const name = !sk.default ? sk.note
                    : sk.createdBy.id === currentUser?.id ? 'Your link' : `${sk.createdBy.name}’s link`
                  return (
                    <div key={sk.linkId} className={`group ${index > 0 ? 'border-t border-kumo-line/70' : ''} ${landedShareLinkId === sk.linkId ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
                      <div className="flex items-center gap-3">
                        <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60">
                          <Link size={14} />
                        </div>
                        <div className="min-w-0 flex-1">
                          {isRenaming ? (
                            <input
                              ref={renameInputRef}
                              value={editingShareLinkNote}
                              onChange={(e) => setEditingShareLinkNote(e.target.value)}
                              onKeyDown={(e) => {
                                if (isImeComposing(e)) return
                                if (e.key === 'Enter') handleSaveShareLinkNote()
                                if (e.key === 'Escape') cancelRenameShareLink()
                              }}
                              placeholder="Name this link…"
                              aria-label="Share link name"
                              className="block w-full border-0 bg-transparent p-0 text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default outline-none shadow-[inset_0_-1px_0_0_var(--color-kumo-line)] transition-shadow placeholder:font-normal placeholder:text-kumo-inactive focus:shadow-[inset_0_-1px_0_0_var(--color-kumo-fill)]"
                              disabled={savingShareLinkNote}
                            />
                          ) : (
                            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{name || 'Untitled link'}</p>
                          )}
                          <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">Created by {sk.createdBy.name} · {formatRelativeTime(sk.created)}</p>
                        </div>
                        {isRenaming ? (
                          <InlineConfirm
                            label="Save"
                            tone="brand"
                            busy={savingShareLinkNote}
                            onConfirm={handleSaveShareLinkNote}
                            onCancel={cancelRenameShareLink}
                          />
                        ) : isRevoking ? (
                          <InlineConfirm
                            label="Revoke"
                            busy={revokeTarget.previewing || confirmationBusy}
                            busyLabel={revokeTarget.previewing ? 'Checking…' : undefined}
                            onConfirm={handleConfirmRevokeShareLink}
                            onCancel={() => setConfirmationTarget(null)}
                          />
                        ) : (
                          <>
                            {sk.gadgets && (
                              <Tooltip
                                open={open && gadgetTooltip?.linkId === sk.linkId}
                                onOpenChange={(nextOpen, details) => {
                                  // The button owns tap toggling; Kumo otherwise closes on pointerdown.
                                  if (details.reason === 'trigger-press') return
                                  setGadgetTooltip(current => {
                                    // Hybrid devices synthesize mouseleave after a tap.
                                    if (details.reason === 'trigger-hover' && current?.pinned) return current
                                    if (nextOpen) return { linkId: sk.linkId, pinned: false }
                                    return current?.linkId === sk.linkId ? null : current
                                  })
                                }}
                                content={
                                  <div role="tooltip" id={`${gadgetTooltipId}-${sk.linkId}`} data-share-link-gadgets>
                                    <ul className="m-0 max-h-[min(20rem,calc(var(--available-height)_-_1rem))] max-w-xs list-none overflow-y-auto overscroll-contain p-0">
                                      {sk.gadgets.map(gadget => <li key={gadget.id} className="truncate">{gadget.title}</li>)}
                                    </ul>
                                  </div>
                                }
                                asChild
                              >
                                <button
                                  type="button"
                                  aria-describedby={gadgetTooltip?.linkId === sk.linkId ? `${gadgetTooltipId}-${sk.linkId}` : undefined}
                                  onClick={() => setGadgetTooltip(current => current?.linkId === sk.linkId
                                    ? null : { linkId: sk.linkId, pinned: true })}
                                  className="cursor-pointer rounded-md px-2 text-[12px] text-kumo-subtle underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-kumo-ring"
                                >
                                  {sk.gadgets.length} {sk.gadgets.length === 1 ? 'gadget' : 'gadgets'} · Cannot edit
                                </button>
                              </Tooltip>
                            )}
                            {!sk.default && (
                              <WorkshopIconButton
                                className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                                onClick={() => startRenameShareLink(sk)}
                                aria-label={`Rename ${name || 'share link'}`}
                                disabled={confirmationBusy}
                              >
                                <PencilSimple size={13} />
                              </WorkshopIconButton>
                            )}
                            {canUseShareLinks && (
                              <WorkshopIconButton
                                className="!h-7 !w-7"
                                onClick={() => handleCopyShareLink(sk)}
                                aria-label={`Copy ${name || 'share link'}`}
                                disabled={confirmationBusy || copyingLinkId === sk.linkId}
                              >
                                {copiedLinkId === sk.linkId ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                              </WorkshopIconButton>
                            )}
                            <WorkshopIconButton
                              danger
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => handleStartRevokeShareLink(sk.linkId)}
                              aria-label={`Revoke ${name || 'share link'}`}
                              disabled={confirmationBusy}
                            >
                              <Trash size={13} />
                            </WorkshopIconButton>
                          </>
                        )}
                      </div>
                      {isRevoking && revokeTarget.dependents.length > 0 && (
                        <div className="mt-2.5 share-expand-in">
                          <p className="mb-1.5 text-[12px] leading-4 text-kumo-subtle">
                            {revokeTarget.dependents.length} {revokeTarget.dependents.length === 1 ? 'person loses' : 'people lose'} access through this link. Keep anyone?
                          </p>
                          <DependentKeepList
                            dependents={revokeTarget.dependents}
                            keepSet={revokeTarget.keepSet}
                            onKeepSetChange={(keepSet) => setConfirmationTarget(current =>
                              current?.kind === 'revoke' && current.linkId === revokeTarget.linkId
                                ? { ...current, keepSet }
                                : current
                            )}
                          />
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
          </section>
          )}
        </div>
        )}
        <div className={`${shownSubpage ? 'hidden' : 'flex'} shrink-0 items-center justify-between gap-3 border-t border-kumo-line/70 px-4 py-3 sm:px-6`}>
          {showResourcesPill ? (
            <button
              type="button"
              className="inline-flex h-8 min-w-0 cursor-pointer items-center gap-1.5 rounded-full bg-kumo-info-tint px-3 text-[13px] leading-4 font-medium tracking-[-0.15px] text-kumo-info transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-info"
              onClick={() => setSubpage('resources')}
            >
              <LockSimple size={14} weight="bold" />
              <span className="truncate">Protected resources</span>
              {!requirementsFailed && <span className="opacity-70">({requirements?.length})</span>}
              <CaretRight size={12} weight="bold" className="opacity-70" />
            </button>
          ) : <span />}
          <div className="flex shrink-0 items-center gap-2">
          {showAdvancedButton && (
            <WorkshopButton className="!h-9 !rounded-xl !border-0 !bg-kumo-tint enabled:hover:!bg-kumo-elevated" onClick={() => setSubpage('advanced')}>
              Advanced settings
            </WorkshopButton>
          )}
          <WorkshopButton
            tone="primary"
            className="gap-1.5 !rounded-xl"
            onClick={() => void copyDialogLink()}
            disabled={(!footerCopiesMyLink && !othersHaveAccess) ||
              (myDefaultLink !== undefined && copyingLinkId === myDefaultLink.linkId)}
          >
            {footerCopiesMyLink && copiedLinkId === myDefaultLink?.linkId
              ? <Check size={14} weight="bold" />
              : <Link size={14} />}
            {footerCopiesMyLink && copiedLinkId === myDefaultLink?.linkId ? 'Copied' : 'Copy link'}
          </WorkshopButton>
          </div>
        </div>
        <div ref={setDirectoryPortalContainer} className="pointer-events-none absolute inset-0 z-30" />
        {/* Zero-size so it takes no pointer events itself; the menus it holds overflow it. */}
        <div ref={setMenuPortalContainer} className="absolute left-0 top-0 z-40" />
      </Dialog>
    </Dialog.Root>
  )
}
