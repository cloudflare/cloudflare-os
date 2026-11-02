import { useId, useRef, useState } from 'react'
import { flushSync } from 'react-dom'
import { DropdownMenu } from '@cloudflare/kumo'
import type { PortalContainer } from '@cloudflare/kumo'
import { CaretDown, Check, GlobeSimple } from '@phosphor-icons/react'
import type { RpcStub } from 'capnweb'
import type { CollaboratorRole, GadgetMetadata, Overseer } from '@gadgets/workshop-shared/api'
import { MENU_CONTENT, MENU_ITEM } from '../../components/menuStyles'
import { WorkshopButton } from '../../components/WorkshopControls'
import { useUiFeatureFlag } from '../../FeatureFlagsContext'
import { logRpcFailure, rpcFailureDescription } from '../../rpcErrors'
import { PUBLIC_ACCESS_LABELS } from './PublishedBadge'
import { SPACE_ACTION_CLASS_NAME } from './SpaceEntryPoints'

/** The role a workspace is published with, or null while it is not published. */
type PublicAccess = CollaboratorRole | null

/** What decides whether, and how, the workspace is published. */
type Publication = Pick<GadgetMetadata, 'publicAccess' | 'containsRestrictedData' | 'ownerInvitesOnly'>

const publicationOf = ({ publicAccess, containsRestrictedData, ownerInvitesOnly }: Publication): Publication =>
  ({ publicAccess, containsRestrictedData, ownerInvitesOnly })

const samePublication = (a: Publication, b: Publication) =>
  a.publicAccess === b.publicAccess
  && !!a.containsRestrictedData === !!b.containsRestrictedData
  && !!a.ownerInvitesOnly === !!b.ownerInvitesOnly

// In order of how much each gives, which is what tells a change that takes access away, and so
// restarts the workspace, from one that only adds to it.
const CHOICES: readonly PublicAccess[] = [null, 'use', 'build']

const RECONNECTS = 'Everyone currently in the workspace will be reconnected.'

const choiceLabel = (access: PublicAccess) =>
  access === null ? 'No access' : PUBLIC_ACCESS_LABELS[access]

const DESCRIPTIONS: Record<CollaboratorRole, string> = {
  use: 'Can open this workspace and use its gadgets without being invited.',
  build: 'Can open this workspace without being invited, edit its gadgets, use chat, rename it, and see '
    + 'who has access to it, its share links and who is in it, but cannot share, move, publish or delete it.',
}

/**
 * The row of the Share dialog for publishing the workspace: what anyone signed in to the
 * deployment may open it with, without being invited (`GadgetMetadata.publicAccess`). Behind
 * the `spaces` flag: with the flag off the row is absent.
 *
 * The owner gets the control. A change that takes access away (a lower role, or none) restarts
 * the workspace for everyone in it, so the row says so first and waits for a second step. A
 * workspace that holds restricted data or is owner-invites-only cannot be published, so there
 * the row says why in place of the control. Anyone else is told the role while the workspace is
 * published, and shown nothing otherwise: their metadata may not say whether it is.
 *
 * The second step takes the focus when it appears, in a group named by its warning, so that the
 * warning is heard, and gives it back to the trigger when it is gone: its buttons go with it.
 */
export const PublicAccessRow = ({ overseer, metadata, container, onChange }: {
  overseer: RpcStub<Overseer>
  /** The workspace as the dialog has it. With no `owner`, the user is its owner. */
  metadata: Pick<GadgetMetadata, 'owner' | 'publicAccess' | 'containsRestrictedData' | 'ownerInvitesOnly'>
  /** Where the control's options are rendered, so they sit above the dialog the row is in. */
  container?: PortalContainer
  /** The workspace is now published with this role, or with null no longer published. */
  onChange?: (access: PublicAccess) => void
}) => {
  const flag = useUiFeatureFlag('spaces')
  // The publication as the dialog's metadata gives it, and how many times that has changed.
  const [given, setGiven] = useState({ publication: publicationOf(metadata), changes: 0 })
  if (!samePublication(given.publication, metadata)) {
    setGiven({ publication: publicationOf(metadata), changes: given.changes + 1 })
  }
  // What this row last learned is in effect, and the metadata it asked against. The dialog may be
  // showing metadata that was read once, which then does not follow a change. Metadata that says
  // something new replaces what was learned, and an answer to a request made before it is stale.
  const [learned, setLearned] = useState<{ publication: Publication; asked: number } | null>(null)
  const current = learned?.asked === given.changes ? learned.publication : metadata
  // The choice that takes access away, while the row waits for it to be confirmed.
  const [confirming, setConfirming] = useState<{ access: PublicAccess } | null>(null)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const warningId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)

  const unavailable = current.ownerInvitesOnly
    ? 'Not available: only the owner can add people to this workspace.'
    : current.containsRestrictedData
      ? 'Not available: this workspace has read sensitive data.'
      : null
  const access = unavailable ? null : current.publicAccess ?? null
  const isOwner = !metadata.owner
  const offered = isOwner && !unavailable

  if (!flag.enabled || (!isOwner && access === null)) return null

  // The focus goes back to the trigger once the change settles: the menu item or the second
  // step's button that made the change is gone, and the trigger is disabled while it saves.
  const apply = async (next: PublicAccess) => {
    const asked = given.changes
    const learn = (publication: Publication) => {
      setLearned({ publication, asked })
      onChange?.(publication.publicAccess ?? null)
    }
    setConfirming(null)
    setSaving(true)
    setFailure(null)
    try {
      await overseer.setPublicAccess(next)
      learn({ ...publicationOf(current), publicAccess: next ?? undefined })
    } catch (err) {
      logRpcFailure('Failed to change a workspace’s publication:', err)
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t change this. Try again.')
      // The change may have taken effect all the same (see `Overseer.setPublicAccess`), and a
      // refusal may come of a flag set since the dialog read the workspace, so what is in effect
      // is read again.
      try {
        learn(publicationOf(await overseer.getMetadata()))
      } catch (readErr) {
        logRpcFailure('Failed to read a workspace’s publication again:', readErr)
      }
    } finally {
      // Rendered at once, so that the trigger is enabled again before it takes the focus.
      flushSync(() => setSaving(false))
      triggerRef.current?.focus()
    }
  }

  const cancel = () => {
    setConfirming(null)
    triggerRef.current?.focus()
  }

  const choose = (next: PublicAccess) => {
    if (saving) return
    setFailure(null)
    if (next === access) setConfirming(null)
    else if (CHOICES.indexOf(next) < CHOICES.indexOf(access)) setConfirming({ access: next })
    else void apply(next)
  }

  return (
    <div className="border-t border-kumo-line/70 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div
          aria-hidden="true"
          className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-kumo-tint text-kumo-subtle"
        >
          <GlobeSimple size={15} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] leading-[17px] font-medium tracking-[-0.25px] text-kumo-default">
            Anyone signed in to this deployment
          </p>
          <p className="text-[12px] leading-[15px] tracking-[-0.15px] text-kumo-subtle">
            {unavailable ?? (access === null ? 'This workspace is not published.' : DESCRIPTIONS[access])}
          </p>
        </div>
        {!isOwner && <span className="px-2 text-[12px] text-kumo-subtle">{choiceLabel(access)}</span>}
        {offered && (
          <DropdownMenu>
            <DropdownMenu.Trigger
              disabled={saving}
              render={
                <button
                  ref={triggerRef}
                  type="button"
                  disabled={saving}
                  aria-label="Access for anyone signed in to this deployment"
                  className="inline-flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-lg px-2 text-[12px] leading-4 font-medium text-kumo-subtle transition-colors hover:bg-kumo-tint hover:text-kumo-default focus-visible:bg-kumo-tint focus-visible:text-kumo-default focus-visible:outline-none data-[popup-open]:bg-kumo-tint data-[popup-open]:text-kumo-default disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {saving ? 'Saving…' : choiceLabel(access)}
                  <CaretDown size={11} weight="bold" className="text-kumo-inactive" />
                </button>
              }
            />
            <DropdownMenu.Content container={container} align="end" sideOffset={6} className={MENU_CONTENT}>
              {CHOICES.map(choice => (
                <DropdownMenu.Item
                  key={choice ?? 'none'}
                  onClick={() => choose(choice)}
                  className={MENU_ITEM}
                >
                  <span className="min-w-0 flex-1">{choiceLabel(choice)}</span>
                  <span className="ml-2 flex h-4 w-4 shrink-0 items-center justify-center">
                    {choice === access && <Check size={13} weight="bold" className="text-kumo-brand" />}
                  </span>
                </DropdownMenu.Item>
              ))}
            </DropdownMenu.Content>
          </DropdownMenu>
        )}
      </div>
      {offered && confirming && (
        <div
          role="group"
          aria-labelledby={warningId}
          className="mt-2 flex flex-wrap items-center justify-end gap-2"
        >
          <p id={warningId} className="mr-auto text-[12px] leading-4 text-kumo-default">
            {RECONNECTS}
          </p>
          <WorkshopButton autoFocus className={SPACE_ACTION_CLASS_NAME} onClick={cancel}>
            Cancel
          </WorkshopButton>
          <WorkshopButton
            tone="danger"
            className={SPACE_ACTION_CLASS_NAME}
            aria-describedby={warningId}
            onClick={() => void apply(confirming.access)}
          >
            Change to {choiceLabel(confirming.access)}
          </WorkshopButton>
        </div>
      )}
      {failure && (
        <p role="alert" className="mt-2 text-[12px] leading-4 text-kumo-danger">{failure}</p>
      )}
    </div>
  )
}
