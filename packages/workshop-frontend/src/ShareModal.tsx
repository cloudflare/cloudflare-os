import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useId, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Checkbox, Dialog, useKumoToastManager } from '@cloudflare/kumo'
import { Check, Copy, Link, PencilSimple, ShieldCheck, ShieldWarning, Trash, UserPlus, UsersThree, X } from '@phosphor-icons/react'
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
import { copyToClipboard } from './clipboard'
import { isImeComposing } from './keyboardEvent'
import { useServerConfig } from './ServerConfigContext'
import { useUserDirectorySearch } from './features/user-directory/useUserDirectorySearch'

/**
 * What a share dialog hands out: the workspace, whose members edit every gadget and use chat
 * ("build"), or one gadget's deployed UI.
 */
export type ShareTarget =
  | { kind: 'workspace' }
  | { kind: 'gadget'; gadgetId: WorkpieceId; title: string }

function grantFor(gadgetId: WorkpieceId | undefined): CollaboratorGrant {
  return gadgetId === undefined ? 'build' : { gadgetId }
}

// What one permission edge grants, in the terms the dialogs list people under: the workspace, one
// gadget, or every gadget without editing -- a "use" grant from before gadgets were shared one at
// a time, which can no longer be made but still holds.
type EdgeScope = 'workspace' | 'legacy' | WorkpieceId

function edgeScope(edge: PermissionEdge): EdgeScope {
  if ((edge.role ?? 'build') === 'build') return 'workspace'
  return edge.gadgetId ?? 'legacy'
}

const LEGACY_ACCESS_LABEL = 'All gadgets · Cannot edit'

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

// What a recipient is asked to do before what they were given will open for them. Recipients
// don't inherit the owner's connections: they must point their own account at each connection in
// scope, so sharers should know that cost before they invite anyone.
function RecipientVerification({
  requirements,
  failed,
}: {
  requirements: ObserverBindingNeed[] | null
  failed: boolean
}) {
  let body: ReactNode
  if (failed) {
    body = (
      <p className="px-1 text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
        Couldn’t check which connections recipients will be asked to verify.
      </p>
    )
  } else if (requirements === null || requirements.length === 0) {
    // Still loading: stay silent rather than reserving space for an answer we don't have yet.
    return null
  } else {
    body = (
      <div className="rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5">
        <p className="text-[12px] leading-[16px] tracking-[-0.15px] text-kumo-subtle">
          Recipients must prove their own account can reach:
        </p>
        <ul className="mt-1.5 max-h-32 space-y-1 overflow-y-auto">
          {requirements.map(requirement => (
            <li key={requirement.gatekeeperId} className="min-w-0">
              <p className="truncate text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-default">
                {requirement.resourceTitle}
              </p>
              {requirement.resourceUrl && (
                <p className="truncate font-mono text-[11px] leading-4 text-kumo-inactive">
                  {requirement.resourceUrl}
                </p>
              )}
            </li>
          ))}
        </ul>
      </div>
    )
  }

  return (
    <section aria-labelledby="recipient-verification-heading" className="mt-4">
      <div className="mb-2 flex items-center gap-1.5 px-1">
        <ShieldCheck size={13} className="text-kumo-inactive" />
        <h3 id="recipient-verification-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
          Recipient verification
        </h3>
      </div>
      {body}
    </section>
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
      .filter(({ access }) => access.role === 'build' || (gadgetId !== undefined &&
        (access.gadgetIds === 'all' || access.gadgetIds.includes(gadgetId))))
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
  const [newShareLink, setNewShareLink] = useState<string | null>(null)
  const [newShareLinkId, setNewShareLinkId] = useState<string | null>(null)
  const [newShareLinkCopied, setNewShareLinkCopied] = useState(false)
  const [invitedNames, setInvitedNames] = useState<string[]>([])
  const [invitedLinkCopied, setInvitedLinkCopied] = useState(false)
  const [requirements, setRequirements] = useState<ObserverBindingNeed[] | null>(null)
  const [requirementsFailed, setRequirementsFailed] = useState(false)
  const [creatingLink, setCreatingLink] = useState(false)
  const [showLinkComposer, setShowLinkComposer] = useState(false)
  const [confirmationTarget, setConfirmationTarget] = useState<ConfirmationTarget | null>(null)
  const [confirmationBusy, setConfirmationBusy] = useState(false)
  const creatingLinkRef = useRef(false)
  const addingRef = useRef(false)
  const landedTimerRef = useRef<number | null>(null)
  const [directoryPortalContainer, setDirectoryPortalContainer] =
    useState<HTMLDivElement | null>(null)
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
    if (showLinkComposer && !newShareLink) {
      linkNameRef.current?.focus({ preventScroll: true })
    }
  }, [showLinkComposer, newShareLink])

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
        setNewShareLink(null)
        // A fresh open starts the composer over, except for people whose invite is still in flight
        // or has failed: their chip is the only record of the outcome.
        const inFlight = addingRef.current
        setStaged(current => inFlight ? current : current.filter(recipient => recipient.error))
        setNewShareLinkId(null)
        setNewShareLinkCopied(false)
        setInvitedNames([])
        setInvitedLinkCopied(false)
        setNewLinkNote('')
        setShowLinkComposer(false)
        setConfirmationTarget(null)
        setEditingShareLinkId(null)
        setEditingShareLinkNote('')
        setCopiedLinkId(null)
        setCopyingLinkId(null)
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
  // gadget, since every member holds it anyway. Legacy access covers every gadget, so both list it.
  const members = collaborators.filter(({ access }) => gadgetId === undefined
    ? access.role === 'build'
    : access.role === 'use' && access.gadgetIds !== 'all' && access.gadgetIds.includes(gadgetId))
  const legacyCollaborators = collaborators.filter(({ access }) =>
    access.role === 'use' && access.gadgetIds === 'all')
  const sortedShareLinks = useMemo(
    () => [...shareLinks].toSorted((a, b) => b.created.getTime() - a.created.getTime()),
    [shareLinks],
  )
  // Links to one gadget name it; a link naming none grants the workspace (or, legacy, every gadget).
  const visibleShareLinks = sortedShareLinks.filter(link => link.gadgetId === gadgetId)
  // Someone who can't invite has no recipient to verify.
  const recipientVerification = canInvite && (requirementsFailed || requirements !== null)
    ? <RecipientVerification requirements={requirements} failed={requirementsFailed} />
    : null
  const removeTarget = confirmationTarget?.kind === 'remove' ? confirmationTarget : null
  const revokeTarget = confirmationTarget?.kind === 'revoke' ? confirmationTarget : null

  // How someone got the access a row lists, ignoring their grants of anything else.
  const describeAccess = (info: CollaboratorInfo, scope: EdgeScope): string => {
    const edges = info.addedBy.filter(edge => edgeScope(edge) === scope)
    if (edges.length > 1) return `Access from ${edges.length} sources`
    const edge = edges[0]
    if (!edge) return 'Collaborator'
    if (edge.type === 'user') return `Added directly by ${edge.sharer}`
    const key = shareLinks.find(item => item.linkId === edge.keyId)
    return key?.note ? `Joined through “${key.note}”` : 'Joined through a share link'
  }

  const copyNewLink = async () => {
    if (!newShareLink) return
    const copied = await copyToClipboard(newShareLink)
    if (copied) {
      setNewShareLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy share link.', variant: 'error' })
    }
  }

  // Where an invited collaborator opens what they were given. Adding them already granted access,
  // so this carries no secret and is safe to show and re-show — unlike a share link's URL.
  const invitedUrl = destinationUrl(metadata.id, gadgetId)

  const copyInvitedUrl = async () => {
    if (await copyToClipboard(invitedUrl)) {
      setInvitedLinkCopied(true)
    } else {
      toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
    }
  }

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
        setInvitedNames(names)
        setInvitedLinkCopied(false)
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
      setNewShareLink(url)
      setNewShareLinkCopied(false)
      setNewLinkNote('')
      setNewShareLinkId(linkId)
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
      if (revokeTarget.linkId === newShareLinkId) {
        setNewShareLink(null)
        setNewShareLinkId(null)
        setNewShareLinkCopied(false)
        setShowLinkComposer(false)
      }
      toasts.add({ title: 'Share link revoked.', variant: 'success' })
      await loadData()
    } catch (err: any) {
      toasts.add({ title: err.message || 'Failed to revoke share link.', variant: 'error' })
    } finally {
      setConfirmationBusy(false)
    }
  }

  // One collaborator's row: who they are, how they got the access this dialog lists, and, where
  // they can be removed from here, the removal flow with its choice of dependents to keep.
  const renderCollaborator = (info: CollaboratorInfo, scope: EdgeScope, label: string, removable: boolean) => {
    const { profile } = info
    const removing = removeTarget?.profileId === profile.id ? removeTarget : null
    const downstreamDependents = removing
      ? removing.dependents.filter(dep => dep.profile.id !== profile.id)
      : []
    return (
      <div key={profile.id} className={`group ${landedPersonIds.has(profile.id) ? 'share-row-land' : 'transition-colors duration-150 hover:bg-kumo-elevated/50'} px-3 py-2.5`}>
        <div className="flex items-center gap-3">
          <PersonAvatar api={authenticatedApi} userId={profile.id} name={profile.name} size={32} />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
              {profile.name}{profile.id === currentUser?.id ? ' (you)' : ''}
            </p>
            <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
              {describeAccess(info, scope)}
            </p>
          </div>
          {removing ? (
            <InlineConfirm
              label="Remove"
              busy={removing.previewing || confirmationBusy}
              busyLabel={removing.previewing ? 'Checking…' : undefined}
              onConfirm={handleConfirmRemoveCollaborator}
              onCancel={() => setConfirmationTarget(null)}
            />
          ) : (
            <>
              <span className="px-2 text-[12px] text-kumo-subtle">{label}</span>
              {removable && (
                <WorkshopIconButton
                  danger
                  className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                  onClick={() => handleStartRemoveCollaborator(profile.id)}
                  aria-label={`Remove ${profile.name}`}
                  disabled={confirmationBusy}
                >
                  <Trash size={13} />
                </WorkshopIconButton>
              )}
            </>
          )}
        </div>
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
      </div>
    )
  }

  return (
    <Dialog.Root open={open} onOpenChange={(o) => { if (!o) onClose() }}>
      <Dialog
        className="responsive-dialog !z-[1000] !top-[clamp(24px,10vh,80px)] !flex !max-h-[calc(100vh-clamp(24px,10vh,80px)-24px)] !w-[min(640px,calc(100vw-32px))] !-translate-y-0 flex-col overflow-hidden bg-kumo-base p-0 !outline-none"
        size="lg"
      >
        <div className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="min-w-0">
            <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
              {target.kind === 'gadget' ? `Share “${target.title}”` : `Invite to “${metadata.title}”`}
            </Dialog.Title>
            <Dialog.Description className="mt-1 text-[13px] leading-[18px] tracking-[-0.25px] text-kumo-subtle">
              {canUseShareLinks
                ? 'Invite people or share a link.'
                : canInvite ? 'Invite people.' : 'Manage access.'}
            </Dialog.Description>
          </div>
          <Dialog.Close
            render={(props) => (
              <WorkshopIconButton {...props} aria-label="Close">
                <X size={18} />
              </WorkshopIconButton>
            )}
          />
        </div>

        <div
          className={`chat-panel min-h-0 flex-1 overscroll-contain px-4 pb-6 sm:px-6 ${directoryOpen ? 'overflow-hidden' : 'overflow-y-auto'}`}
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
            className="themed-compact-shadow grid min-h-12 grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2 rounded-2xl border border-kumo-line/80 bg-kumo-base p-1.5 pl-3 transition-[border-color,box-shadow] focus-within:border-kumo-fill sm:flex"
            data-keeper-ignore="true"
            data-1p-ignore="true"
            data-lpignore="true"
            data-bwignore="true"
          >
            <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
              <UserPlus size={15} weight="duotone" />
            </div>
            <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
              {staged.map(recipient => (
                <span
                  key={recipient.id}
                  title={recipient.error ?? (recipient.name !== recipient.id ? recipient.id : undefined)}
                  className={`inline-flex max-w-full items-center gap-1 rounded-full border py-[3px] pl-2.5 pr-1 text-[11px] leading-4 font-medium tracking-[-0.1px] ${
                    recipient.error
                      ? 'border-kumo-danger bg-kumo-danger-tint/40 text-kumo-danger'
                      : 'border-kumo-line bg-kumo-tint/70 text-kumo-default'
                  }`}
                >
                  <span className="truncate">{recipient.name}</span>
                  {recipient.name !== recipient.id && (
                    <span className="truncate font-mono text-[10px] text-kumo-subtle">{recipient.id}</span>
                  )}
                  <button
                    type="button"
                    aria-label={`Remove ${recipientLabel(recipient)}`}
                    onClick={() => removeStaged(recipient)}
                    disabled={adding}
                    className="grid h-4 w-4 shrink-0 cursor-pointer place-items-center rounded-full opacity-60 transition-opacity hover:opacity-100 focus-visible:opacity-100 disabled:cursor-not-allowed"
                  >
                    <X size={10} weight="bold" />
                  </button>
                </span>
              ))}
              <input
                ref={peopleInputRef}
                type="search"
                role={userSearchEnabled ? 'combobox' : undefined}
                placeholder={userSearchEnabled ? 'Search by name or email' : 'Username or email'}
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
              tone="primary"
              className="col-span-3 w-full !rounded-xl sm:col-span-1 sm:w-auto sm:min-w-[68px]"
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

          {invitedNames.length > 0 && (
            <div className="themed-compact-shadow mt-2 flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                {invitedLinkCopied ? <Check size={15} weight="bold" /> : <UserPlus size={15} weight="duotone" />}
              </div>
              <div className="min-w-[160px] flex-1">
                <div className="flex items-baseline gap-1.5">
                  <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                    Added {NAME_LIST.format(invitedNames)}
                  </p>
                  <span className="text-[11px] leading-4 text-kumo-inactive">
                    {invitedLinkCopied ? 'Link copied to your clipboard' : 'Send them this link to open it'}
                  </span>
                </div>
                <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{invitedUrl}</p>
              </div>
              <WorkshopButton tone="primary" onClick={copyInvitedUrl} className="gap-1.5 !rounded-xl">
                {invitedLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                {invitedLinkCopied ? 'Copied' : 'Copy link'}
              </WorkshopButton>
              <WorkshopIconButton
                aria-label="Dismiss added collaborator"
                onClick={() => { setInvitedNames([]); setInvitedLinkCopied(false) }}
              >
                <X size={14} />
              </WorkshopIconButton>
            </div>
          )}

          {canUseShareLinks && (
          <div className="mt-2">
            {(showLinkComposer || newShareLink) ? (
              newShareLink ? (
                <div className="themed-compact-shadow flex flex-wrap items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 py-2.5 share-fade-in">
                    <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-kumo-tint text-kumo-subtle">
                      {newShareLinkCopied ? <Check size={15} weight="bold" /> : <Link size={15} />}
                    </div>
                    <div className="min-w-[160px] flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <p className="text-[13px] leading-[18px] font-medium text-kumo-default">
                          {newShareLinkCopied ? 'Link copied' : 'Link ready'}
                        </p>
                        <span className="text-[11px] leading-4 text-kumo-inactive">
                          You can copy it again anytime from Share links
                        </span>
                      </div>
                      <p className="truncate font-mono text-[11px] leading-4 text-kumo-subtle">{newShareLink}</p>
                    </div>
                    <WorkshopButton tone="primary" onClick={copyNewLink} className="w-[78px] gap-1.5 !rounded-xl">
                      {newShareLinkCopied ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                      {newShareLinkCopied ? 'Copied' : 'Copy'}
                    </WorkshopButton>
                    <WorkshopIconButton
                      aria-label="Dismiss created link"
                      onClick={() => { setNewShareLink(null); setNewShareLinkId(null); setNewShareLinkCopied(false); setShowLinkComposer(false) }}
                    >
                      <X size={14} />
                    </WorkshopIconButton>
                </div>
              ) : (
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
              )
            ) : (
              <button
                type="button"
                onClick={() => setShowLinkComposer(true)}
                className="themed-compact-shadow flex h-12 w-full cursor-pointer items-center justify-center gap-1.5 rounded-2xl border border-kumo-line/80 bg-kumo-base px-3 text-[13px] font-medium text-kumo-subtle transition-[background-color,color,transform] duration-150 ease-out hover:bg-kumo-elevated/60 hover:text-kumo-default active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Link size={14} /> Create a share link
              </button>
            )}
          </div>
          )}
          </div>
          )}

          {recipientVerification}

          <section aria-labelledby="people-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="people-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                People with access
              </h3>
            </div>
            <div className="divide-y divide-kumo-line/70 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
              {ownerProfile && (
                <div className="px-3 py-2.5 transition-colors duration-150 hover:bg-kumo-elevated/50">
                  <div className="flex items-center gap-3">
                    <PersonAvatar api={authenticatedApi} userId={ownerProfile.id} name={ownerProfile.name} size={32} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
                        {ownerProfile.name}{ownerProfile.id === currentUser?.id ? ' (you)' : ''}
                      </p>
                      <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
                        {ownerProfile.id}
                      </p>
                    </div>
                    <span className="px-2 text-[12px] text-kumo-subtle">Owner</span>
                  </div>
                </div>
              )}
              {gadgetId !== undefined && (
                <div className="flex items-center gap-3 px-3 py-2.5">
                  <div className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br from-kumo-tint to-kumo-elevated text-kumo-subtle ring-1 ring-inset ring-kumo-line/60">
                    <UsersThree size={15} />
                  </div>
                  <p className="min-w-0 flex-1 truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
                    People in this workspace
                  </p>
                  <span className="px-2 text-[12px] text-kumo-subtle">Can edit</span>
                </div>
              )}
              {members.map(info => renderCollaborator(info, gadgetId ?? 'workspace', 'Member', true))}
            </div>
          </section>

          {legacyCollaborators.length > 0 && (
          <section aria-labelledby="legacy-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="legacy-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                Legacy access
              </h3>
            </div>
            <div className="divide-y divide-kumo-line/70 overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
              {/* Removal takes all of someone's legacy access, so only the workspace dialog offers it. */}
              {legacyCollaborators.map(info =>
                renderCollaborator(info, 'legacy', LEGACY_ACCESS_LABEL, gadgetId === undefined))}
            </div>
          </section>
          )}

          {visibleShareLinks.length > 0 && (
          <section aria-labelledby="links-heading" className="mt-4">
            <div className="mb-2 px-1">
              <h3 id="links-heading" className="text-[12px] leading-4 font-medium tracking-[-0.15px] text-kumo-subtle">
                Share links
              </h3>
            </div>

              <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
                {visibleShareLinks.map((sk, index) => {
                  const isRevoking = revokeTarget?.linkId === sk.linkId
                  const isRenaming = editingShareLinkId === sk.linkId
                  // A legacy link grants every gadget, which links no longer may, so it can't be copied.
                  const isLegacyLink = sk.role === 'use' && sk.gadgetId === undefined
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
                            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{sk.note || 'Untitled link'}</p>
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
                            {isLegacyLink && (
                              <span className="px-2 text-[12px] text-kumo-subtle">{LEGACY_ACCESS_LABEL}</span>
                            )}
                            {canUseShareLinks && !isLegacyLink && (
                              <WorkshopIconButton
                                className="!h-7 !w-7"
                                onClick={() => handleCopyShareLink(sk)}
                                aria-label={`Copy ${sk.note || 'share link'}`}
                                disabled={confirmationBusy || copyingLinkId === sk.linkId}
                              >
                                {copiedLinkId === sk.linkId ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                              </WorkshopIconButton>
                            )}
                            <WorkshopIconButton
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => startRenameShareLink(sk)}
                              aria-label={`Rename ${sk.note || 'share link'}`}
                              disabled={confirmationBusy}
                            >
                              <PencilSimple size={13} />
                            </WorkshopIconButton>
                            <WorkshopIconButton
                              danger
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => handleStartRevokeShareLink(sk.linkId)}
                              aria-label={`Revoke ${sk.note || 'share link'}`}
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
        <div ref={setDirectoryPortalContainer} className="pointer-events-none absolute inset-0 z-30" />
      </Dialog>
    </Dialog.Root>
  )
}
