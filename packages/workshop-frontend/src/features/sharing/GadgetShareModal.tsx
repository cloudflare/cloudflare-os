import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, Overseer, WorkpieceId, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import { CheckIcon, LinkIcon, UsersIcon } from '../../components/icons/designIcons'
import { copyToClipboard } from '../../clipboard'
import { useServerConfig, useSiteName } from '../../ServerConfigContext'
import { ACCESS_LABEL, CollaboratorList, ShareRow } from './CollaboratorList'
import { ShareDialogBody, ShareDialogFrame, sharePrimaryButtonClass } from './ShareDialogFrame'
import { GeneralAccessRow } from './GeneralAccessRow'
import { InviteComposer, type InviteFeedback } from './InviteComposer'
import { ProtectedResourcesButton } from './ProtectedResourcesButton'
import { ProtectedResourcesList } from './ProtectedResourcesList'
import { RemovalConfirmation } from './RemovalConfirmation'
import { RestrictedDataNotice } from './RestrictedDataNotice'
import { useCollaboratorRemoval } from './useCollaboratorRemoval'
import { gadgetUrl, useGeneralAccess } from './useGeneralAccess'
import { useObserverRequirements } from './useObserverRequirements'
import { SharedViewButton } from '../shared-view/SharedViewButton'
import { WhatPeopleSee } from '../shared-view/WhatPeopleSee'
import { usePresentUserIds } from '../shared-view/usePresentUserIds'
import { ownerFirstName } from '../shared-view/viewTime'

// Access to a gadget that comes with something wider, which a grant of the gadget would not change.
const accessBeyondGadget = ({ profile, access }: CollaboratorInfo): string | null => {
  if (access.role === 'build') return `${profile.name} is a member of this workspace, so they can already edit this gadget.`
  if (access.gadgetIds === 'all') return `${profile.name} can already use every gadget in this workspace.`
  return null
}

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: WorkspaceMetadata
  gadget: {
    id: WorkpieceId
    title: string
    /** The commit the gadget is at; what "What people see" checks for a screen. */
    commitId?: string
    /** When the owner's view was taken, if one has been. */
    viewTakenAt?: Date
    /** When a refresh last failed to replace the view. */
    viewUpdateFailedAt?: Date
  }
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const GadgetShareModal = ({ open, onClose, overseer, metadata, gadget, currentUser, authenticatedApi }: Props) => {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const siteName = useSiteName()
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membership, setMembership] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [feedback, setFeedback] = useState<InviteFeedback | null>(null)
  const [copied, setCopied] = useState(false)
  const [showResources, setShowResources] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const resourcesRef = useRef<HTMLButtonElement>(null)
  const cancelRemovalRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const triggerRefs = useRef(new Map<string, HTMLButtonElement>())
  const previousRemoval = useRef<string | null>(null)
  const restoreResourcesFocus = useRef(false)
  const addingRef = useRef(false)
  const requestId = useRef(0)
  const isOwner = !metadata.owner
  // A chat's own workspace has no members to speak of beyond the people it was shared with.
  const isNamed = metadata.kind === 'workspace'
  // The server refuses non-owner grants once this is set.
  const canShare = metadata.role !== 'use' && (isOwner || metadata.ownerInvitesOnly !== true)
  const owner = isOwner ? currentUser : metadata.owner ?? null
  // Every member can edit this gadget, so the dialog lists only the people given it on its own.
  const members = collaborators.filter(person => person.access.role === 'build')
  const viewers = collaborators.filter(({ access }) =>
    access.role === 'use' && access.gadgetIds !== 'all' && access.gadgetIds.includes(gadget.id))
  const excludeIds = [...new Set([...(currentUser ? [currentUser.id] : []), ...(owner ? [owner.id] : []),
    ...members.map(person => person.profile.id), ...viewers.map(person => person.profile.id)])]
  const inviterNames = new Map(collaborators.map(person => [person.profile.id, person.profile.name]))
  if (owner) inviterNames.set(owner.id, owner.name)
  const { requirements, failed: requirementsFailed } = useObserverRequirements(overseer, open, gadget.id)
  // People without access see the owner's view, which "What people see" explains in place of the
  // protected resources they would otherwise have to verify.
  const sharedViews = metadata.sharedViewsAvailable === true
  const presentIds = usePresentUserIds(overseer, open && sharedViews)

  const loadData = useCallback(async () => {
    const request = ++requestId.current
    try {
      const people = await overseer.listCollaborators()
      if (request !== requestId.current) return
      setCollaborators(people)
      setMembership('ready')
    } catch {
      if (request !== requestId.current) return
      setMembership('failed')
      toastsRef.current.add({ title: 'Failed to load gadget sharing.', variant: 'error' })
    }
  }, [overseer])
  const general = useGeneralAccess({ overseer, open, workspaceId: metadata.id, gadgetId: gadget.id, onChanged: loadData })
  // Under ownerInvitesOnly the server refuses anyone the owner didn't add, link or not.
  const ownerInvitesOnly = metadata.ownerInvitesOnly === true
  const generalState = ownerInvitesOnly ? { kind: 'off' as const } : general.state
  const linkUrl = generalState.kind === 'on' ? generalState.url : null
  // Until the link is known (and, when on, its key minted), a copy could be the wrong one.
  const linkPending = generalState.kind === 'loading' || (generalState.kind === 'on' && !linkUrl)
  const removal = useCollaboratorRemoval({ overseer, open, collaborators: viewers, gadgetId: gadget.id, onRemoved: loadData })
  const removalId = removal.target?.profileId ?? null
  // Removing someone on live data right now disconnects them: the revocation restarts them.
  const removalLoss = (() => {
    if (!sharedViews || !removal.target) return undefined
    const person = viewers.find(info => info.profile.id === removal.target!.profileId)
    const live = person !== undefined && presentIds.has(person.profile.id) &&
      person.lastOpened?.[gadget.id]?.mode === 'live'
    return `${removal.target.name} will no longer see this gadget${live ? ' and will be disconnected now' : ''}.`
  })()

  useEffect(() => {
    if (!open) return
    setMembership('loading')
    setUsername('')
    setFeedback(null)
    setCopied(false)
    setShowResources(false)
    void loadData()
    return () => { requestId.current++ }
  }, [open, loadData])

  useEffect(() => {
    if (!landedPersonId) return
    const timer = window.setTimeout(() => setLandedPersonId(null), 2200)
    return () => window.clearTimeout(timer)
  }, [landedPersonId])

  useEffect(() => {
    if (!copied) return
    const timer = window.setTimeout(() => setCopied(false), 2000)
    return () => window.clearTimeout(timer)
  }, [copied])

  useLayoutEffect(() => {
    if (showResources) backRef.current?.focus({ preventScroll: true })
    else if (restoreResourcesFocus.current) {
      resourcesRef.current?.focus({ preventScroll: true })
      restoreResourcesFocus.current = false
    }
  }, [showResources])

  useLayoutEffect(() => {
    if (removalId) cancelRemovalRef.current?.focus({ preventScroll: true })
    else if (previousRemoval.current) {
      (triggerRefs.current.get(previousRemoval.current) ?? inputRef.current ?? copyRef.current)?.focus({ preventScroll: true })
    }
    previousRemoval.current = removalId
  }, [removalId])

  // Why sharing with this person would change nothing, if it wouldn't. A typed id bypasses the
  // search's exclusions, and the server accepts a grant someone already holds without complaint
  // (granting a member a gadget may even add a redundant grant), so this is checked first.
  const existingAccess = (userId: string): string | null => {
    const id = userId.toLowerCase()
    if (owner?.id.toLowerCase() === id) return `${owner.name} owns this workspace and can already edit this gadget.`
    const existing = collaborators.find(person => person.profile.id.toLowerCase() === id)
    if (!existing) return null
    return accessBeyondGadget(existing) ??
      (viewers.includes(existing) ? `This gadget is already shared with ${existing.profile.name}.` : null)
  }

  const share = async (userId: string) => {
    if (!canShare || addingRef.current) return
    const already = existingAccess(userId)
    if (already) {
      setFeedback({ tone: 'info', message: already })
      return
    }
    addingRef.current = true
    setAdding(true)
    setFeedback(null)
    try {
      const person = await overseer.addCollaborator(userId, { gadgetId: gadget.id }, undefined)
      if (!person) { setFeedback({ tone: 'error', message: 'No account found for that username or email.' }); return }
      setUsername('')
      await loadData()
      // The list checked beforehand may have been stale.
      const unchanged = accessBeyondGadget(person)
      if (unchanged) {
        setFeedback({ tone: 'info', message: unchanged })
        return
      }
      setLandedPersonId(person.profile.id)
      setCopied(false)
      const first = ownerFirstName(person.profile)
      setFeedback({
        tone: 'success',
        message: sharedViews
          ? `Shared with ${first}. ${first} sees what you see.`
          : `${person.profile.name} can now use “${gadget.title}”.`,
      })
    } catch (err) {
      setFeedback({ tone: 'error', message: err instanceof Error ? err.message : 'Failed to share gadget.' })
    } finally {
      addingRef.current = false
      setAdding(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  // With the link on, its key lets anyone in the deployment in; otherwise the link only opens the
  // workspace on this gadget for the people it is shared with.
  const copyLink = async () => {
    if (linkPending) return
    if (await copyToClipboard(linkUrl ?? gadgetUrl(metadata.id, gadget.id))) setCopied(true)
    else toasts.add({ title: 'Could not copy the gadget link.', variant: 'error' })
  }

  const setGeneralAccess = async (enabled: boolean) => {
    try {
      await general.setEnabled(enabled)
      setCopied(false)
      toasts.add({
        title: enabled ? `Anyone in ${siteName} with the link can use it` : 'Only people listed can open it now',
      })
    } catch (err) {
      toasts.add({ title: err instanceof Error ? err.message : 'Could not change link access.', variant: 'error' })
    }
  }

  const closeResources = () => {
    restoreResourcesFocus.current = true
    setShowResources(false)
  }

  const title = removal.target ? `Remove ${removal.target.name}?`
    : showResources ? (sharedViews ? 'What people see' : 'Protected resources')
    : <>Share <span className="text-kumo-subtle">&ldquo;{gadget.title}&rdquo;</span></>
  const description = removal.target || showResources ? undefined : isNamed
    ? <>People you add can use this app on its own, without the rest of {metadata.title}.</>
    : 'People you add can use this app on its own, without the chat it was made in.'

  return (
    <ShareDialogFrame
      open={open}
      onDismiss={() => {
        if (removal.busy || adding) return
        if (removal.target) removal.cancel()
        else if (showResources) closeResources()
        else onClose()
      }}
      title={title}
      description={description}
      onBack={showResources && !removal.target ? closeResources : undefined}
      backRef={backRef}
      backLabel="Back to sharing"
      closeDisabled={removal.busy}
      footer={removal.target || showResources ? undefined : <>
        {sharedViews
          ? <SharedViewButton requirements={requirements} failed={requirementsFailed} hasRecipients={viewers.length > 0} onOpen={() => setShowResources(true)} buttonRef={resourcesRef} />
          : <ProtectedResourcesButton requirements={requirements} failed={requirementsFailed} onOpen={() => setShowResources(true)} buttonRef={resourcesRef} />}
        <button ref={copyRef} type="button" disabled={linkPending} onClick={() => void copyLink()} className={sharePrimaryButtonClass}>
          {copied ? <CheckIcon size={12} /> : <LinkIcon size={14} />}{copied ? 'Copied' : 'Copy link'}
        </button>
      </>}
    >
      {removal.target ? (
        <RemovalConfirmation {...removal.target} authenticatedApi={authenticatedApi} resource="gadget" inviterNames={inviterNames} busy={removal.busy} onKeepSetChange={removal.setKeepSet} onCancel={removal.cancel} onConfirm={() => void removal.confirm()} cancelRef={cancelRemovalRef} lossDescription={removalLoss} />
      ) : showResources && sharedViews ? (
        <WhatPeopleSee
          overseer={overseer} authenticatedApi={authenticatedApi} gadgetId={gadget.id} commitId={gadget.commitId}
          viewTakenAt={gadget.viewTakenAt} viewUpdateFailedAt={gadget.viewUpdateFailedAt}
          requirements={requirements} requirementsFailed={requirementsFailed}
        />
      ) : showResources ? (
        <ShareDialogBody>
          <p className="mb-3 text-[13px] leading-[18px] text-kumo-subtle">
            Someone you share it with needs their own access to these before they can open this app.
          </p>
          <ProtectedResourcesList requirements={requirements} failed={requirementsFailed} authenticatedApi={authenticatedApi} />
        </ShareDialogBody>
      ) : (
        <ShareDialogBody>
          <RestrictedDataNotice metadata={metadata} sharedViews={sharedViews} />
          {canShare && <InviteComposer
            authenticatedApi={authenticatedApi} searchEnabled={searchEnabled} membership={membership} excludeIds={excludeIds}
            value={username} onValueChange={value => { setUsername(value); setFeedback(null) }} action="Share"
            adding={adding} feedback={feedback} link={{ copied, onCopy: () => void copyLink() }} onInvite={userId => void share(userId)} inputRef={inputRef}
          />}
          <CollaboratorList owner={owner} collaborators={viewers} currentUser={currentUser} authenticatedApi={authenticatedApi}
            landedPersonId={landedPersonId} disabled={removal.busy || adding} accessLabel="Can use" menuContainer={null}
            canEdit={person => canShare && (isOwner || person.addedBy.some(edge => edge.type === 'user' && edge.sharer === currentUser?.id))}
            onRemove={profileId => void removal.start(profileId)} onTriggerRef={(profileId, element) => {
              if (element) triggerRefs.current.set(profileId, element)
              else triggerRefs.current.delete(profileId)
            }}
          >
            {(isNamed || members.length > 0) && (
              <ShareRow icon={<UsersIcon size={14} />} label={isNamed ? <>Members of {metadata.title}</> : 'People in this chat'}>
                <span className={ACCESS_LABEL}>Can edit</span>
              </ShareRow>
            )}
            <GeneralAccessRow
              siteName={siteName} state={generalState} busy={general.busy} container={null}
              canChange={canShare && !ownerInvitesOnly} onChange={enabled => void setGeneralAccess(enabled)}
            />
          </CollaboratorList>
        </ShareDialogBody>
      )}
    </ShareDialogFrame>
  )
}
