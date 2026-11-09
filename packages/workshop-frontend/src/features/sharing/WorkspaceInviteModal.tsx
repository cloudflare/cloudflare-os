import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useKumoToastManager } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, Overseer, WorkspaceMetadata } from '@gadgets/workshop-shared/api'
import { CheckIcon, LinkIcon } from '../../components/icons/designIcons'
import { ShareDialogBody, ShareDialogFrame, sharePrimaryButtonClass } from './ShareDialogFrame'
import { copyToClipboard } from '../../clipboard'
import { useServerConfig } from '../../ServerConfigContext'
import { CollaboratorList } from './CollaboratorList'
import { InviteComposer, type InviteFeedback } from './InviteComposer'
import { ProtectedResourcesButton } from './ProtectedResourcesButton'
import { ProtectedResourcesList } from './ProtectedResourcesList'
import { RemovalConfirmation } from './RemovalConfirmation'
import { RestrictedDataNotice } from './RestrictedDataNotice'
import { useCollaboratorRemoval } from './useCollaboratorRemoval'
import { useObserverRequirements } from './useObserverRequirements'

type Props = {
  open: boolean
  onClose: () => void
  overseer: RpcStub<Overseer>
  metadata: WorkspaceMetadata
  currentUser: AiChatAuthorInfo | null
  authenticatedApi: RpcStub<AuthenticatedApi>
}

export const WorkspaceInviteModal = ({ open, onClose, overseer, metadata, currentUser, authenticatedApi }: Props) => {
  const toasts = useKumoToastManager()
  const toastsRef = useRef(toasts)
  toastsRef.current = toasts
  const searchEnabled = useServerConfig()?.userSearchEnabled ?? false
  const [collaborators, setCollaborators] = useState<CollaboratorInfo[]>([])
  const [membership, setMembership] = useState<'loading' | 'ready' | 'failed'>('loading')
  const [username, setUsername] = useState('')
  const [adding, setAdding] = useState(false)
  const [feedback, setFeedback] = useState<InviteFeedback | null>(null)
  const [copied, setCopied] = useState(false)
  const [showResources, setShowResources] = useState(false)
  const [landedPersonId, setLandedPersonId] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const copyRef = useRef<HTMLButtonElement>(null)
  const backRef = useRef<HTMLButtonElement>(null)
  const resourcesRef = useRef<HTMLButtonElement>(null)
  const restoreResourcesFocus = useRef(false)
  const triggers = useRef(new Map<string, HTMLButtonElement>())
  const previousRemoval = useRef<string | null>(null)
  const addingRef = useRef(false)
  const requestId = useRef(0)
  const isOwner = !metadata.owner
  // The server refuses non-owner invites once this is set.
  const canInvite = isOwner || metadata.ownerInvitesOnly !== true
  const owner = isOwner ? currentUser : metadata.owner ?? null
  const members = collaborators.filter(person => person.access.role === 'build')
  const excludeIds = [...new Set([...(currentUser ? [currentUser.id] : []), ...(owner ? [owner.id] : []), ...members.map(person => person.profile.id)])]
  const inviterNames = new Map(collaborators.map(person => [person.profile.id, person.profile.name]))
  if (owner) inviterNames.set(owner.id, owner.name)
  const { requirements, failed: requirementsFailed } = useObserverRequirements(overseer, open)

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
      toastsRef.current.add({ title: 'Failed to load workspace members.', variant: 'error' })
    }
  }, [overseer])
  const removal = useCollaboratorRemoval({ overseer, open, collaborators: members, onRemoved: loadData })
  const removalId = removal.target?.profileId ?? null

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
    if (removalId) cancelRef.current?.focus({ preventScroll: true })
    else if (previousRemoval.current) {
      (triggers.current.get(previousRemoval.current) ?? inputRef.current ?? copyRef.current)?.focus({ preventScroll: true })
    }
    previousRemoval.current = removalId
  }, [removalId])

  // Why inviting this person would change nothing, if it wouldn't. A typed id bypasses the
  // search's exclusions, and the server accepts a grant someone already holds without complaint.
  const existingAccess = (userId: string): string | null => {
    const id = userId.toLowerCase()
    if (owner?.id.toLowerCase() === id) return `${owner.name} owns this workspace.`
    const member = members.find(person => person.profile.id.toLowerCase() === id)
    return member ? `${member.profile.name} is already a member of this workspace.` : null
  }

  const invite = async (userId: string) => {
    if (!canInvite || addingRef.current) return
    const already = existingAccess(userId)
    if (already) {
      setFeedback({ tone: 'info', message: already })
      return
    }
    addingRef.current = true
    setAdding(true)
    setFeedback(null)
    try {
      const person = await overseer.addCollaborator(userId, 'workspace', undefined)
      if (!person) { setFeedback({ tone: 'error', message: 'No account found for that username or email.' }); return }
      setUsername('')
      await loadData()
      setLandedPersonId(person.profile.id)
      setCopied(false)
      setFeedback({ tone: 'success', message: metadata.kind === 'workspace'
        ? `${person.profile.name} is now a member of ${metadata.title}.`
        : `Shared with ${person.profile.name}.` })
    } catch (err) {
      setFeedback({ tone: 'error', message: err instanceof Error ? err.message : 'Failed to invite member.' })
    } finally {
      addingRef.current = false
      setAdding(false)
      inputRef.current?.focus({ preventScroll: true })
    }
  }

  // Adding someone already granted them access, so this carries no secret: they only need to
  // know where to go.
  const copyLink = async () => {
    if (await copyToClipboard(`${window.location.origin}/workspace/${metadata.id}`)) setCopied(true)
    else toasts.add({ title: 'Could not copy the workspace link.', variant: 'error' })
  }

  const closeResources = () => {
    restoreResourcesFocus.current = true
    setShowResources(false)
  }

  // A chat's own workspace is the chat, to whoever is added to it.
  const named = metadata.kind === 'workspace'
  const title = removal.target ? `Remove ${removal.target.name}?`
    : showResources ? 'Protected resources'
    : named ? <>Invite to <span className="text-kumo-subtle">{metadata.title}</span></> : 'Share chat'
  const description = removal.target || showResources ? undefined : named
    ? 'Members work on everything in it with you: its chats, gadgets and files.'
    : 'People you add can read this chat, carry it on with you and use the gadgets it made.'

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
      backLabel="Back to invitations"
      closeDisabled={removal.busy}
      footer={removal.target || showResources ? undefined : <>
        <ProtectedResourcesButton requirements={requirements} failed={requirementsFailed} onOpen={() => setShowResources(true)} buttonRef={resourcesRef} />
        <button ref={copyRef} type="button" onClick={() => void copyLink()} className={sharePrimaryButtonClass}>
          {copied ? <CheckIcon size={12} /> : <LinkIcon size={14} />}{copied ? 'Copied' : 'Copy link'}
        </button>
      </>}
    >
      {removal.target ? (
        <RemovalConfirmation {...removal.target} authenticatedApi={authenticatedApi} resource="workspace" inviterNames={inviterNames} busy={removal.busy} onKeepSetChange={removal.setKeepSet} onCancel={removal.cancel} onConfirm={() => void removal.confirm()} cancelRef={cancelRef} />
      ) : showResources ? (
        <ShareDialogBody>
          <p className="mb-3 text-[13px] leading-[18px] text-kumo-subtle">
            {named
              ? 'A member needs their own access to these before they can open this workspace.'
              : 'Someone you add needs their own access to these before they can open this chat.'}
          </p>
          <ProtectedResourcesList requirements={requirements} failed={requirementsFailed} authenticatedApi={authenticatedApi} />
        </ShareDialogBody>
      ) : (
        <ShareDialogBody>
          <RestrictedDataNotice metadata={metadata} />
          {canInvite && <InviteComposer
            authenticatedApi={authenticatedApi} searchEnabled={searchEnabled} membership={membership} excludeIds={excludeIds}
            value={username} onValueChange={value => { setUsername(value); setFeedback(null) }} action={named ? 'Invite' : 'Share'}
            adding={adding} feedback={feedback} link={{ copied, onCopy: () => void copyLink() }} onInvite={userId => void invite(userId)} inputRef={inputRef}
          />}
          <CollaboratorList owner={owner} collaborators={members} currentUser={currentUser} authenticatedApi={authenticatedApi}
            landedPersonId={landedPersonId} disabled={removal.busy} accessLabel="Member" menuContainer={null}
            canEdit={person => isOwner || (canInvite && person.addedBy.some(edge => edge.type === 'user' && edge.sharer === currentUser?.id))}
            onRemove={profileId => void removal.start(profileId)} onTriggerRef={(profileId, element) => {
              if (element) triggers.current.set(profileId, element)
              else triggers.current.delete(profileId)
            }}
          />
        </ShareDialogBody>
      )}
    </ShareDialogFrame>
  )
}
