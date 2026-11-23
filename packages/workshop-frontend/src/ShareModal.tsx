import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef, useId, type KeyboardEvent, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'
import { useNavigate } from '@tanstack/react-router'
import { Checkbox, Dialog, DropdownMenu, Tooltip, useKumoToastManager } from '@cloudflare/kumo'
import { CaretDown, CaretLeft, CaretRight, Check, Copy, Eye, Link, LockSimple, PencilSimple, ShieldWarning, Trash, UserPlus, UsersThree, X } from '@phosphor-icons/react'
import { RpcStub } from 'capnweb'
import {
  Overseer,
  AuthenticatedApi,
  CollaboratorAccess,
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
import { ShareSnapshotPreview } from './ShareSnapshotPreview'
import { getStoredSelectedModel } from './modelSelection'
import { logRpcFailure } from './rpcErrors'

/**
 * What a share dialog hands out: the workspace, whose members edit every gadget and use chat
 * ("build"), or one gadget's deployed UI.
 */
export type ShareTarget =
  | { kind: 'workspace' }
  | { kind: 'gadget'; gadgetId: WorkpieceId; title: string }

// What a gadget's dialog hands out: the gadget itself ("use"), which recipients open live once they
// verify their own access to its connections, or only a view of its static snapshot ("view"; see
// CollaboratorGrant), which verifies nothing. The workspace's dialog hands out only the workspace.
type GadgetAccess = 'use' | 'view'
const ACCESS_LABELS: Record<GadgetAccess, string> = { use: 'Can use', view: 'Can view' }

function grantFor(gadgetId: WorkpieceId | undefined, access: GadgetAccess): CollaboratorGrant {
  if (gadgetId === undefined) return 'workspace'
  return access === 'view' ? { gadgetId, mode: 'view' } : { gadgetId }
}

// Whether someone may only view `gadgetId`. False for a build collaborator, who holds every gadget
// in full.
function holdsOnlyView(access: CollaboratorAccess, gadgetId: WorkpieceId): boolean {
  return access.role === 'use' && access.viewOnly?.includes(gadgetId) === true
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

// The first message of the chat the snapshot page's "Ask agent to fix" starts, for Gadget `title`.
// Its terms follow the agent's system prompt (packages/workshop-backend/src/agent.ts), which
// explains Gadgets, server.js, client.js, storage and bindings; it says nothing of snapshots.
const snapshotFixPrompt = (title: string) => `The Gadget ${JSON.stringify(title)} doesn't work well as a snapshot. Adapt it so that it does.

A snapshot is how people the user shares a Gadget with can view it without access to its bindings. It runs the Gadget's current server.js and client.js, but as a separate copy of the Gadget's Durable Object:

* The copy starts with a copy of everything the Gadget has saved in its private storage (the Durable Objects KV and SQLite storage APIs), read through those same APIs.
* The copy has no bindings: its \`this.env\` is empty and it cannot make network requests. RPC stubs the Gadget stored, including persistent stubs, fail to load.
* So the snapshot shows only what the Gadget saved. Anything the Gadget fetches through a binding when the UI asks for it is missing from the snapshot. Save data read through bindings to storage when it is read, so the snapshot can show it.
* The copy may write to its storage, but those writes are discarded when the snapshot is refreshed with a new copy of the Gadget's storage. A snapshot is refreshed every time the viewer opens it, and whenever they choose to refresh it. Never rely on a snapshot keeping anything it writes.
* Viewers can also download the snapshot through the Gadget's export formats. These exports run against the snapshot's copy too: a browser-mode export renders client.js against it, and \`ExportHandler\` in server.js runs in the copy, with an empty \`this.env\`.

client.js can tell it is running as a snapshot, including in a browser-mode export, from \`globalThis.gadgetRenderMode === "snapshot"\`; when it is not a snapshot, \`gadgetRenderMode\` is not defined. In a snapshot, present a read-only version of the UI, so viewers do not make changes that are silently lost on refresh. Make sure that every method client.js calls, and every export format \`getExportFormats()\` lists, still works, or fails with a clear message, when the bindings are missing.`

function withRecipient(list: StagedRecipient[], recipient: StagedRecipient): StagedRecipient[] {
  return list.some(entry => entry.id === recipient.id) ? list : [...list, recipient]
}

// "Name (id)" when they differ, so two accounts with one display name stay tellable apart.
function recipientLabel({ id, name }: StagedRecipient): string {
  return name === id ? name : `${name} (${id})`
}

// A revocation with `replaceWith` set switches "Anyone with your link" to that access: the new
// default link is created, then the old one revoked.
type ConfirmationTarget =
  | { kind: 'remove'; profileId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string> }
  | { kind: 'revoke'; linkId: string; dependents: AffectedCollaborator[]; previewing: boolean; keepSet: Set<string>; replaceWith?: GadgetAccess }

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
  const serverConfig = useServerConfig()
  const userSearchEnabled = serverConfig?.userSearchEnabled ?? false
  // While the deployment forbids view-only sharing, a gadget is shared only for use, its snapshot
  // can't be previewed, and views already shared are only listed, to be upgraded or removed.
  const snapshotSharingEnabled = serverConfig?.snapshotSharingEnabled !== false
  const offeredAccess: readonly GadgetAccess[] = snapshotSharingEnabled ? ['use', 'view'] : ['use']
  const isOwner = !metadata.owner
  const gadgetId = target.kind === 'gadget' ? target.gadgetId : undefined
  const containsRestrictedData = metadata.containsRestrictedData === true
  // The server refuses share links and non-owner invites once this is set; hide those controls.
  const ownerInvitesOnly = metadata.ownerInvitesOnly === true
  const canInvite = !ownerInvitesOnly || isOwner
  const canUseShareLinks = !ownerInvitesOnly
  const directoryQuery = addUsername.trim()
  // What the composer and the custom-link composer give, in a gadget's dialog. A "Can view" picked
  // before the deployment forbade views is kept, and sends nothing until "Can use" is picked, so
  // a change of policy never turns a view share into a live one.
  const [inviteAccess, setInviteAccess] = useState<GadgetAccess>('use')
  const [newLinkAccess, setNewLinkAccess] = useState<GadgetAccess>('use')
  const inviteAccessForbidden = inviteAccess === 'view' && !snapshotSharingEnabled
  const newLinkAccessForbidden = newLinkAccess === 'view' && !snapshotSharingEnabled
  // Everyone who already holds what this dialog grants -- the caller, the owner (absent from
  // listCollaborators() when the caller is a collaborator), and collaborators with the workspace or
  // with this gadget -- plus everyone already staged. Anyone else can still be given it, such as a
  // gadget's recipient being invited to the whole workspace, or someone who can only view a gadget
  // being given its full use.
  const directoryExcludeIds = useMemo(() => [
    ...(currentUser ? [currentUser.id] : []),
    ...(metadata.owner ? [metadata.owner.id] : []),
    ...collaborators
      .filter(({ access }) => access.role === 'build' ||
        (gadgetId !== undefined && access.gadgetIds.includes(gadgetId) &&
          !(inviteAccess === 'use' && holdsOnlyView(access, gadgetId))))
      .map(({ profile }) => profile.id),
    ...staged.map(recipient => recipient.id),
  ], [collaborators, currentUser, gadgetId, inviteAccess, metadata.owner, staged])
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
  const canSubmitInvite = inviteCount > 0 && (directoryQuery === '' || typedRecipient !== null) &&
    !inviteAccessForbidden
  const [adding, setAdding] = useState(false)
  const [newLinkNote, setNewLinkNote] = useState('')
  const [requirements, setRequirements] = useState<ObserverBindingNeed[] | null>(null)
  const [requirementsFailed, setRequirementsFailed] = useState(false)
  // A page of the dialog that stands in for the sharing view until its back button.
  const [subpage, setSubpage] = useState<'resources' | 'advanced' | 'snapshot' | null>(null)
  const [previewFullscreenRequested, setPreviewFullscreen] = useState(false)
  const [askingAgent, setAskingAgent] = useState(false)
  const navigate = useNavigate()
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
  // A page replaces the view holding the button that opened it, and leaving it unmounts Back, so
  // focus is handed across explicitly rather than left to fall back to the dialog.
  const backButtonRef = useRef<HTMLButtonElement>(null)
  const advancedButtonRef = useRef<HTMLButtonElement>(null)
  const resourcesButtonRef = useRef<HTMLButtonElement>(null)
  const snapshotButtonRef = useRef<HTMLButtonElement>(null)
  const openSubpage = (page: NonNullable<typeof subpage>) => {
    flushSync(() => setSubpage(page))
    backButtonRef.current?.focus()
  }
  const closeSubpage = () => {
    const opener = subpage === 'resources' ? resourcesButtonRef
      : subpage === 'snapshot' ? snapshotButtonRef
      : advancedButtonRef
    flushSync(() => setSubpage(null))
    opener.current?.focus()
  }
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
      overseer.listObserverRequirements(grantFor(gadgetId, 'use'))
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
        setNewLinkAccess('use')
        setInviteAccess('use')
        setShowLinkComposer(false)
        setSubpage(null)
        setPreviewFullscreen(false)
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
    (access.role === 'build' || (gadgetId !== undefined && access.gadgetIds.includes(gadgetId) &&
      (snapshotSharingEnabled || !holdsOnlyView(access, gadgetId)))))
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
  const myLinkAccess: GadgetAccess | undefined = myDefaultLink && (myDefaultLink.mode ?? 'use')
  const myLinkLabel = myLinkAccess === undefined ? 'Requires invite'
    : gadgetId === undefined ? 'Can join' : ACCESS_LABELS[myLinkAccess]
  // Someone who can't invite has no recipient to verify. While loading, show nothing rather than
  // reserve space for an answer we don't have yet.
  const showResourcesPill = canInvite && (requirementsFailed || (requirements?.length ?? 0) > 0)
  const showAdvancedButton = canUseShareLinks || advancedShareLinks.length > 0
  // A gadget's snapshot matters once anyone may open it: only people who can view the gadget do,
  // since people who can use it open it live or not at all. Nobody can while views are forbidden.
  const showSnapshotCard = snapshotSharingEnabled && gadgetId !== undefined && open &&
    (inviteAccess === 'view' ||
      members.some(({ access }) => holdsOnlyView(access, gadgetId)) ||
      visibleShareLinks.some(link => link.mode === 'view'))
  const shownSubpage = subpage === 'resources' && showResourcesPill ? 'resources'
    : subpage === 'advanced' && showAdvancedButton ? 'advanced'
    : subpage === 'snapshot' && showSnapshotCard ? 'snapshot'
    : null
  // Derived, so leaving the snapshot page can't leave the dialog set up for full screen.
  const previewFullscreen = previewFullscreenRequested && shownSubpage === 'snapshot'
  // What the full-screen preview covers, kept out of the dialog's focus order and accessibility tree.
  const coveredByPreview = previewFullscreen ? true : undefined
  const ownerData = isOwner ? 'your' : `${metadata.owner?.name ?? 'the owner'}’s`
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
      const link = shareLinks.find(item => item.linkId === edge.keyId)
      const creator = link?.createdBy
      if (!link || !creator || ownerInvitesOnly || !sourceConfers(creator.id)) return []
      if (creator.id !== currentUser?.id) return [`Joined with ${creator.name}’s link`]
      return [link.default ? 'Joined with your link' : 'Joined with your custom share link']
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
  // for people who already have access. A view link mints no new URL while views are forbidden: a
  // recipient could join through it but open nothing.
  const footerCopiesMyLink = myDefaultLink !== undefined && canUseShareLinks &&
    (snapshotSharingEnabled || myDefaultLink.mode !== 'view')
  const copyDialogLink = async () => {
    if (footerCopiesMyLink) {
      await handleCopyShareLink(myDefaultLink)
    } else if (await copyToClipboard(accessUrl)) {
      toasts.add({ title: 'Link copied to clipboard.', variant: 'success' })
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
    if (recipients.length === 0 || addingRef.current || inviteAccessForbidden) return
    if (extra) stageRecipient(extra)

    addingRef.current = true
    setAdding(true)
    try {
      const settled = await Promise.allSettled(
        recipients.map(recipient => overseer.addCollaborator(recipient.id, grantFor(gadgetId, inviteAccess), undefined)))
      const added: AiChatAuthorInfo[] = []
      // Given the snapshot but already holding the full gadget, which a share never narrows.
      const keptFull: string[] = []
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
          if (gadgetId !== undefined && inviteAccess === 'view' &&
              !holdsOnlyView(outcome.value.access, gadgetId)) {
            keptFull.push(outcome.value.profile.name)
          }
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
        if (keptFull.length > 0) {
          toasts.add({
            title: `${NAME_LIST.format(keptFull)} can still use this gadget: a share never reduces anyone’s access.`,
            variant: 'info',
          })
        }
      }
    } finally {
      addingRef.current = false
      setAdding(false)
    }
  }

  const handleCreateShareLink = async () => {
    if (creatingLinkRef.current || newLinkAccessForbidden) return
    creatingLinkRef.current = true
    setCreatingLink(true)
    try {
      const { key, linkId } = await overseer.createShareLink(
        grantFor(gadgetId, newLinkAccess), newLinkNote.trim() || undefined)
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

  // Creates the viewer's default link for what this dialog grants, giving `access` in a gadget's.
  const createDefaultLink = async (access: GadgetAccess) => {
    const { key, linkId } = await overseer.createShareLink(
      grantFor(gadgetId, access), undefined, { default: true })
    // Kept so the first Copy needs no round trip and lands within the click's user activation.
    copiedUrlsRef.current.set(linkId, destinationUrl(metadata.id, gadgetId, key))
  }

  // Turning "Anyone with your link" on. Turning it off, or changing what it gives, is a revocation,
  // confirmed in place.
  const handleEnableDefaultLink = async (access: GadgetAccess) => {
    setCreatingDefaultLink(true)
    try {
      await createDefaultLink(access)
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

  // Changes what someone holds of this gadget. A share never narrows anyone's access, so going down
  // to the snapshot removes the viewer's grants of the gadget and shares the snapshot in one call,
  // which the restart that narrowing schedules can't split: they keep the full gadget if someone
  // else gave it to them. Nobody given a gadget can share it on, so the removal never strands
  // anyone downstream.
  const handleChangeAccess = async (profile: AiChatAuthorInfo, access: GadgetAccess) => {
    if (gadgetId === undefined || confirmationBusy) return
    setConfirmationBusy(true)
    try {
      let held: GadgetAccess
      if (access === 'view') {
        const narrowed = await overseer.removeCollaborator(profile.id, [], gadgetId, true)
        held = narrowed.some(entry => entry.profile.id === profile.id) ? 'view' : 'use'
      } else {
        const info = await overseer.addCollaborator(profile.id, grantFor(gadgetId, access), undefined)
        held = info && holdsOnlyView(info.access, gadgetId) ? 'view' : 'use'
      }
      toasts.add(held === access
        ? { title: `${profile.name} ${ACCESS_LABELS[access].toLowerCase()} this gadget.`, variant: 'success' }
        : { title: `${profile.name} can still use this gadget through someone else’s share.`, variant: 'info' })
      showLandedRow('person', [profile.id])
    } catch (err: unknown) {
      toasts.add({
        title: err instanceof Error && err.message ? err.message : 'Failed to change their access.',
        variant: 'error',
      })
    } finally {
      await loadData()
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

  const handleStartRevokeShareLink = async (linkId: string, replaceWith?: GadgetAccess) => {
    cancelRenameShareLink()
    setConfirmationTarget({ kind: 'revoke', linkId, dependents: [], previewing: true, keepSet: new Set(), replaceWith })
    try {
      const dependents = await overseer.previewRevokeShareLink(linkId)
      const previewed = { kind: 'revoke', linkId, dependents, previewing: false, keepSet: new Set<string>(), replaceWith } as const
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId ? previewed : current)
      // Changing what the link gives asks first only if that costs someone their access.
      if (replaceWith && dependents.length === 0) await revokeShareLink(previewed)
    } catch (err: unknown) {
      setConfirmationTarget(current => current?.kind === 'revoke' && current.linkId === linkId ? null : current)
      toasts.add({
        title: err instanceof Error && err.message ? err.message : 'Failed to preview share-link revocation.',
        variant: 'error',
      })
    }
  }

  const revokeShareLink = async (target: Extract<ConfirmationTarget, { kind: 'revoke' }>) => {
    setConfirmationBusy(true)
    try {
      // The new link first, so a failure can leave two links but never none.
      if (target.replaceWith) await createDefaultLink(target.replaceWith)
      await overseer.revokeShareLink(target.linkId, [...target.keepSet])
      setConfirmationTarget(null)
      toasts.add({ title: target.replaceWith ? 'Link access changed.' : 'Share link revoked.', variant: 'success' })
    } catch (err: unknown) {
      toasts.add({
        title: err instanceof Error && err.message ? err.message : 'Failed to revoke share link.',
        variant: 'error',
      })
    } finally {
      await loadData()
      setConfirmationBusy(false)
    }
  }

  const handleConfirmRevokeShareLink = async () => {
    if (!revokeTarget || revokeTarget.previewing || confirmationBusy) return
    await revokeShareLink(revokeTarget)
  }

  // Starts a chat whose first message asks the agent to make the gadget work for people who have
  // none of its connections, as its snapshot does, then opens that chat.
  const askAgentToFix = async () => {
    if (target.kind !== 'gadget') return
    setAskingAgent(true)
    try {
      const models = await overseer.listModels()
      // The fix needs an agent, so a saved "No agent" choice falls back to the first model.
      const modelId = getStoredSelectedModel(currentUser?.id, models) ?? models[0]?.id
      if (modelId === undefined) {
        toasts.add({ title: 'No AI models are available to fix the gadget.', variant: 'error' })
        return
      }
      const chatId = await overseer.newChat(snapshotFixPrompt(target.title), modelId)
      onClose()
      navigate({
        to: '/workspace/$id',
        params: { id: metadata.id },
        search: { chat: chatId, showChat: true, w: target.gadgetId },
      })
    } catch (err) {
      logRpcFailure('Failed to start a chat to fix the gadget:', err)
      toasts.add({ title: 'Couldn’t start a chat with the agent.', variant: 'error' })
    } finally {
      setAskingAgent(false)
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
    // A gadget dialog lists only the people given that gadget, who use or view it rather than belong.
    const held: GadgetAccess | undefined = gadgetId === undefined ? undefined
      : holdsOnlyView(info.access, gadgetId) ? 'view' : 'use'
    const accessLabel = held === undefined ? 'Member' : ACCESS_LABELS[held]
    const removable = canRemove(info)
    // Anyone who can share can give the full gadget, but narrowing removes their grant first.
    const changeable = held !== undefined && canInvite &&
      (held === 'view' || (removable && snapshotSharingEnabled))
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
    } else if (removable || changeable) {
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
            {changeable && (
              <DropdownMenu.RadioGroup
                value={held}
                onValueChange={(value: GadgetAccess) => {
                  if (value !== held) void handleChangeAccess(profile, value)
                }}
              >
                {offeredAccess.map(access => (
                  <DropdownMenu.RadioItem key={access} value={access} disabled={access === 'view' && !removable} closeOnClick>
                    {ACCESS_LABELS[access]}
                    <DropdownMenu.RadioItemIndicator />
                  </DropdownMenu.RadioItem>
                ))}
              </DropdownMenu.RadioGroup>
            )}
            {changeable && removable && <DropdownMenu.Separator />}
            {removable && (
              <DropdownMenu.Item
                variant="danger"
                icon={<Trash size={14} />}
                aria-label={`Remove ${profile.name}`}
                onClick={() => handleStartRemoveCollaborator(profile.id)}
              >
                Remove
              </DropdownMenu.Item>
            )}
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
        <div inert={coveredByPreview} className="flex shrink-0 items-start justify-between gap-4 overflow-hidden px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          {shownSubpage ? (
            <div className="flex min-w-0 items-center gap-1.5">
              <WorkshopIconButton ref={backButtonRef} aria-label="Back to sharing" onClick={closeSubpage}>
                <CaretLeft size={16} />
              </WorkshopIconButton>
              <Dialog.Title className="truncate text-[18px] leading-6 font-medium tracking-[-0.4px] text-kumo-default">
                {shownSubpage === 'resources' ? 'Protected resources' : shownSubpage === 'snapshot' ? 'Snapshot' : 'Advanced'}
              </Dialog.Title>
              <Dialog.Description className="sr-only">
                {shownSubpage === 'resources'
                  ? 'What recipients must verify before they can open what you share.'
                  : shownSubpage === 'snapshot'
                    ? 'What people who can only view this gadget see.'
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
                ? `People you add can ${snapshotSharingEnabled ? 'use or view' : 'use'} this gadget without seeing anything else in the workspace.`
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
              People you add must verify access to these resources before they can use
              this {gadgetId === undefined ? 'workspace' : 'gadget'}.
            </p>
            <ProtectedResourceList
              requirements={requirements ?? []}
              failed={requirementsFailed}
              vendorBranding={vendorBranding}
            />
          </div>
        )}
        {shownSubpage === 'snapshot' && gadgetId !== undefined && (
          <div className="chat-panel min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pb-6 sm:px-6">
            <p inert={coveredByPreview} className="mb-4 text-[14px] leading-5 tracking-[-0.2px] text-kumo-subtle">
              Viewers open a read-only snapshot of this gadget with {ownerData} stored data. Snapshots come
              with no connections and any writes stay in the viewer’s own copy.
            </p>
            <div className="overflow-hidden rounded-2xl border border-kumo-line/80 bg-kumo-base">
              <ShareSnapshotPreview
                overseer={overseer}
                gadgetId={gadgetId}
                gadgetTitle={target.kind === 'gadget' ? target.title : metadata.title}
                workspaceTitle={metadata.title}
                ownerName={ownerProfile?.name}
                fullscreen={previewFullscreen}
                onFullscreenChange={setPreviewFullscreen}
              />
            </div>
            <div inert={coveredByPreview} className="mt-3 flex items-center justify-end gap-3 px-1">
              <p className="text-[13px] leading-[18px] tracking-[-0.15px] text-kumo-subtle">Snapshot broken?</p>
              <WorkshopButton
                tone="primary"
                className="!h-8 !rounded-xl"
                disabled={askingAgent}
                onClick={() => void askAgentToFix()}
              >
                Ask agent to fix
              </WorkshopButton>
            </div>
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
            {gadgetId !== undefined && (snapshotSharingEnabled || inviteAccess === 'view') && (
              <DropdownMenu>
                <DropdownMenu.Trigger
                  render={(
                    <button type="button" aria-label={`Invite access: ${ACCESS_LABELS[inviteAccess]}`} className={ACCESS_MENU_TRIGGER} disabled={adding}>
                      {ACCESS_LABELS[inviteAccess]} <CaretDown size={13} />
                    </button>
                  )}
                />
                <DropdownMenu.Content container={menuPortalContainer} align="end">
                  <DropdownMenu.RadioGroup value={inviteAccess} onValueChange={(value: GadgetAccess) => setInviteAccess(value)}>
                    {offeredAccess.map(access => (
                      <DropdownMenu.RadioItem key={access} value={access} closeOnClick>
                        {ACCESS_LABELS[access]}
                        <DropdownMenu.RadioItemIndicator />
                      </DropdownMenu.RadioItem>
                    ))}
                  </DropdownMenu.RadioGroup>
                </DropdownMenu.Content>
              </DropdownMenu>
            )}
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
          {inviteAccessForbidden && (
            <p role="alert" className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-danger">
              View-only sharing is turned off on this deployment. Choose Can use to give live access.
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
                    label={defaultLinkRevoke.replaceWith ? 'Change' : 'Turn off'}
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
                          aria-label={`Anyone with your link: ${myLinkLabel}`}
                          className={ACCESS_MENU_TRIGGER}
                          disabled={creatingDefaultLink || confirmationBusy}
                        >
                          {myLinkLabel} <CaretDown size={13} />
                        </button>
                      )}
                    />
                    <DropdownMenu.Content container={menuPortalContainer} align="end" className="whitespace-nowrap">
                      <DropdownMenu.RadioGroup
                        value={myLinkAccess ?? 'none'}
                        onValueChange={(value: GadgetAccess | 'none') => {
                          if (value === myLinkAccess || (value === 'none' && !myDefaultLink)) return
                          if (!myDefaultLink) void handleEnableDefaultLink(value as GadgetAccess)
                          else void handleStartRevokeShareLink(myDefaultLink.linkId, value === 'none' ? undefined : value)
                        }}
                      >
                        {gadgetId === undefined ? (
                          <DropdownMenu.RadioItem value="use" closeOnClick>
                            Can join
                            <DropdownMenu.RadioItemIndicator />
                          </DropdownMenu.RadioItem>
                        ) : offeredAccess.map(access => (
                          <DropdownMenu.RadioItem key={access} value={access} closeOnClick>
                            {ACCESS_LABELS[access]}
                            <DropdownMenu.RadioItemIndicator />
                          </DropdownMenu.RadioItem>
                        ))}
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

          {showSnapshotCard && (
            <button
              ref={snapshotButtonRef}
              type="button"
              onClick={() => openSubpage('snapshot')}
              className="mt-3 flex w-full cursor-pointer items-center gap-3 rounded-2xl border border-kumo-line/80 bg-kumo-base px-2 py-2 text-left transition-colors duration-150 hover:bg-kumo-elevated/50"
            >
              <div className={ROW_ICON}><Eye size={15} /></div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[14px] leading-5 tracking-[-0.25px] text-kumo-default">Viewers can see a snapshot</p>
                <p className="text-[12px] leading-4 tracking-[-0.15px] text-kumo-subtle">
                  A read-only copy with no connections that does not require verification
                </p>
              </div>
              <CaretRight size={12} weight="bold" className="mr-1 shrink-0 text-kumo-subtle" />
            </button>
          )}
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
                    {gadgetId !== undefined && (snapshotSharingEnabled || newLinkAccess === 'view') && (
                      <DropdownMenu>
                        <DropdownMenu.Trigger
                          render={(
                            <button type="button" aria-label={`Link access: ${ACCESS_LABELS[newLinkAccess]}`} className={ACCESS_MENU_TRIGGER} disabled={creatingLink}>
                              {ACCESS_LABELS[newLinkAccess]} <CaretDown size={13} />
                            </button>
                          )}
                        />
                        <DropdownMenu.Content container={menuPortalContainer} align="end">
                          <DropdownMenu.RadioGroup value={newLinkAccess} onValueChange={(value: GadgetAccess) => setNewLinkAccess(value)}>
                            {offeredAccess.map(access => (
                              <DropdownMenu.RadioItem key={access} value={access} closeOnClick>
                                {ACCESS_LABELS[access]}
                                <DropdownMenu.RadioItemIndicator />
                              </DropdownMenu.RadioItem>
                            ))}
                          </DropdownMenu.RadioGroup>
                        </DropdownMenu.Content>
                      </DropdownMenu>
                    )}
                    <WorkshopButton tone="primary" className="shrink-0 !rounded-xl" onClick={handleCreateShareLink} disabled={creatingLink || newLinkAccessForbidden}>
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
            {showLinkComposer && newLinkAccessForbidden && (
              <p role="alert" className="mt-1.5 px-1 text-[12px] leading-4 text-kumo-danger">
                View-only sharing is turned off on this deployment. Choose Can use to give live access.
              </p>
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
                  // A named link by its note, the viewer's own default link as theirs, and any
                  // other link -- an unnamed one, or someone else's default -- by who made it.
                  const name = !sk.default && sk.note ? sk.note
                    : sk.default && sk.createdBy.id === currentUser?.id ? 'Your link' : `${sk.createdBy.name}’s link`
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
                            <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">{name}</p>
                          )}
                          <p className="truncate text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">Created by {sk.createdBy.name} · {formatRelativeTime(sk.created)}{sk.gadgetId !== undefined ? ` · ${ACCESS_LABELS[sk.mode ?? 'use']}` : ''}</p>
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
                                aria-label={`Rename ${name}`}
                                disabled={confirmationBusy}
                              >
                                <PencilSimple size={13} />
                              </WorkshopIconButton>
                            )}
                            {canUseShareLinks && (
                              <WorkshopIconButton
                                className="!h-7 !w-7"
                                onClick={() => handleCopyShareLink(sk)}
                                aria-label={`Copy ${name}`}
                                disabled={confirmationBusy || copyingLinkId === sk.linkId ||
                                  (!snapshotSharingEnabled && sk.mode === 'view')}
                              >
                                {copiedLinkId === sk.linkId ? <Check size={13} weight="bold" /> : <Copy size={13} />}
                              </WorkshopIconButton>
                            )}
                            <WorkshopIconButton
                              danger
                              className="!h-7 !w-7 opacity-35 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
                              onClick={() => handleStartRevokeShareLink(sk.linkId)}
                              aria-label={`Revoke ${name}`}
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
        <div className={`${shownSubpage ? 'hidden' : 'flex'} shrink-0 flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-kumo-line/70 px-4 py-3 sm:px-6`}>
          {showResourcesPill ? (
            <button
              ref={resourcesButtonRef}
              type="button"
              className="inline-flex h-8 max-w-full cursor-pointer items-center gap-1.5 rounded-full bg-kumo-info-tint px-3 text-[13px] leading-4 font-medium tracking-[-0.15px] text-kumo-info transition-opacity hover:opacity-85 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-kumo-info"
              onClick={() => openSubpage('resources')}
            >
              <LockSimple size={14} weight="bold" className="shrink-0" />
              <span className="truncate">Protected resources</span>
              {!requirementsFailed && <span className="shrink-0 opacity-70">({requirements?.length})</span>}
              <CaretRight size={12} weight="bold" className="shrink-0 opacity-70" />
            </button>
          ) : <span />}
          {/* Wraps below the pill, and then onto two lines, rather than squeezing it. */}
          <div className="ml-auto flex flex-wrap items-center justify-end gap-2">
          {showAdvancedButton && (
            <WorkshopButton ref={advancedButtonRef} className="!h-9 !rounded-xl !border-0 !bg-kumo-tint enabled:hover:!bg-kumo-elevated" onClick={() => openSubpage('advanced')}>
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
