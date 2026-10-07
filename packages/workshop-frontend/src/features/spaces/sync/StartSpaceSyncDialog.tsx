import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { Dialog, Radio } from '@cloudflare/kumo'
import type { CollaboratorRole, SpaceSyncJobInfo, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import type { ResourceConfiguratorFrame } from '@gadgets/workshop-shared/gatekeeper'
import { useAuthenticatedApi } from '../../../AuthContext'
import { WorkshopButton } from '../../../components/WorkshopControls'
import ResourceConfiguratorHost from '../../../ResourceConfiguratorHost'
import { reportIssue } from '../../../errorReporting'
import { useRpcStub } from '../../../RpcContext'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { SpaceDialogFrame } from '../SpaceDialogFrame'
import { parentOptions, titleOf, TOP_OF_TREE } from '../tree/parentOptions'
import { hiddenByTitle } from '../tree/workspaceTree'
import { syncSourceName, type SpaceSyncAccount } from './useSpaceSyncAccounts'

const accountLabel = (account: SpaceSyncAccount) => `${account.label} (${account.vendorName})`

// The dialog's choices are inline radio groups rather than dropdowns: the resource configurator
// is an iframe drawn above everything else in its rect, so a popup opening over it could not be
// clicked.
const LEGEND_CLASS_NAME = 'text-[12px] leading-4 font-medium text-kumo-default'

const PUBLICATION_TEXT: Record<CollaboratorRole, string> = {
  use: 'who can use them',
  build: 'who can use and build on them',
}

// The unpublished entry that would keep the synced workspaces from everyone else when they go
// under `parent`: the parent itself, or the entry above it that already holds it back. Its title
// is undefined when the listing does not hold it.
const blockingEntry = (
  listing: readonly SpaceWorkspaceInfo[],
  parent: SpaceWorkspaceInfo | undefined,
): { title: string | undefined } | undefined => {
  if (!parent) return undefined
  if (parent.published === undefined) return { title: titleOf(parent) }
  if (parent.hiddenBy === undefined) return undefined
  const title = hiddenByTitle(listing, parent)
  return { title: title === undefined ? undefined : title || 'Untitled Workspace' }
}

// The configurator started for one account, resource type and attempt, tagged with all three so
// that a render that follows a change of any never shows the previous one's.
type Configurator = { target: string } & (
  | { status: 'ready'; frame: ResourceConfiguratorFrame; key: number }
  | { status: 'failed'; message: string }
)

// The frame's capability is typed as the bare target, without the disposer every stub has.
const disposeFrame = (frame: ResourceConfiguratorFrame | null) => {
  const ui: Partial<Disposable> | undefined = frame?.ui
  ui?.[Symbol.dispose]?.()
}

/**
 * Starts a sync of a source into a space through one of the user's connected accounts that
 * declare `providesSpaceSync`: the account, when there are several; the source, picked with the
 * account's own resource configurator; and the entry of the space's tree the synced workspaces
 * go under. Before anything starts it says that every synced workspace will be published to
 * everyone signed in, with the role the account's blueprint declares (`BlueprintMetadata.
 * publication`, "use" when it declares none), that the workspaces are the user's own copies,
 * that a sync of a source synced before replaces what was written in the workspaces it created,
 * and that items restricted at the source are skipped. Start waits for that role to be read,
 * and is unavailable where it could not be, and while a sync of the user's into the space is
 * running, since the server would refuse it. Mounted only while open.
 */
export const StartSpaceSyncDialog = ({
  space, listing, accounts, defaultParentId, syncRunning, onClose, onStarted,
}: {
  space: { key: string; name: string }
  /** The space's listing, as `Space.listWorkspaces` returns it. */
  listing: readonly SpaceWorkspaceInfo[]
  /** The accounts that can sync, as `useSpaceSyncAccounts` lists them. */
  accounts: readonly SpaceSyncAccount[]
  /** The entry the synced workspaces go under unless another is chosen; the top when omitted. */
  defaultParentId?: string
  /** A sync of the user's into this space is running. */
  syncRunning: boolean
  onClose: () => void
  /**
   * The sync was started, and `job` is as the server recorded it, which may already have failed.
   * Closing the dialog and following the job are the caller's.
   */
  onStarted: (job: SpaceSyncJobInfo) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const publicApi = useRpcStub()
  // The role each blueprint's syncs publish with, or 'unknown' where it could not be read.
  // Absent while it is being read.
  const [publications, setPublications] = useState<ReadonlyMap<string, CollaboratorRole | 'unknown'>>(new Map())
  const [chosenAccountId, setChosenAccountId] = useState<number | null>(null)
  const [chosenPattern, setChosenPattern] = useState<string | null>(null)
  const [chosenParent, setChosenParent] = useState(defaultParentId ?? TOP_OF_TREE)
  const [configurator, setConfigurator] = useState<Configurator | null>(null)
  // Bumped to start the configurator again after it failed to start.
  const [attempt, setAttempt] = useState(0)
  const [selection, setSelection] = useState<{ key: number; ready: boolean | null } | null>(null)
  const [starting, setStarting] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const collectRef = useRef<(() => Promise<string>) | null>(null)
  const revealedParentRef = useRef(false)
  const nextFrameKeyRef = useRef(0)
  const sourceLabelId = useId()

  // An account that went away while the dialog was open gives way to the first usable one.
  const account = accounts.find(candidate => candidate.id === chosenAccountId)
    ?? accounts.find(candidate => candidate.credentialsValid)
    ?? accounts[0]
  const resource = account?.resources.find(candidate => candidate.urlPattern === chosenPattern)
    ?? account?.resources[0]
  const configurable = account !== undefined && account.credentialsValid && resource !== undefined
  const accountId = configurable ? account.id : null
  const pattern = configurable ? resource.urlPattern : null
  const vendorId = configurable ? account.vendorId : null
  const target = configurable ? `${accountId} ${pattern} ${attempt}` : null
  const shown = configurator?.target === target ? configurator : null
  const ready = shown?.status === 'ready' && selection?.key === shown.key && selection.ready === true
  const blueprintId = account?.blueprintId
  const publication = blueprintId === undefined ? undefined : publications.get(blueprintId)

  useEffect(() => {
    if (blueprintId === undefined) return
    let cancelled = false
    const learn = (role: CollaboratorRole | 'unknown') => {
      if (!cancelled) setPublications(previous => new Map(previous).set(blueprintId, role))
    }
    publicApi.getBlueprint(blueprintId).then(
      // One the deployment does not have is refused by the server too, so its role is not guessed.
      blueprint => learn(blueprint ? blueprint.metadata.publication ?? 'use' : 'unknown'),
      (err: unknown) => {
        logRpcFailure('Failed to read how a space sync publishes its workspaces:', err)
        learn('unknown')
      },
    )
    return () => { cancelled = true }
  }, [publicApi, blueprintId])

  useEffect(() => {
    if (accountId === null || pattern === null) return
    const started = `${accountId} ${pattern} ${attempt}`
    let cancelled = false
    let frame: ResourceConfiguratorFrame | null = null
    authenticatedApi.startResourceConfigurator(accountId, pattern).then(
      (resolved) => {
        if (cancelled) {
          disposeFrame(resolved)
          return
        }
        frame = resolved
        setConfigurator({ target: started, status: 'ready', frame: resolved, key: ++nextFrameKeyRef.current })
      },
      (err: unknown) => {
        if (cancelled) return
        logRpcFailure('Failed to start a resource configurator for a space sync:', err)
        reportIssue('gatekeeper.configurator-start', err, { gatekeeperVendorId: vendorId ?? undefined })
        setConfigurator({
          target: started,
          status: 'failed',
          message: rpcFailureDescription(err) ?? 'Couldn’t load the source picker.',
        })
      },
    )
    return () => {
      cancelled = true
      disposeFrame(frame)
      // A disposed frame must never be shown again, even if this account and type come back.
      setConfigurator(null)
    }
  }, [authenticatedApi, accountId, pattern, vendorId, attempt])

  // The entry preselected may sit far down a long list, which scrolls on its own, so the list is
  // scrolled to it once it first shows, which is after the dialog mounts. Only the list is: the
  // choice's own scrollIntoView would scroll the dialog as well.
  const revealPreselectedParent = (option: HTMLDivElement | null) => {
    const list = option?.parentElement
    if (!option || !list || revealedParentRef.current) return
    revealedParentRef.current = true
    const view = list.getBoundingClientRect()
    const place = option.getBoundingClientRect()
    if (place.top < view.top || place.bottom > view.bottom) list.scrollTop += place.top - view.top
  }

  // Stable, since the configurator re-registers its collector whenever this changes.
  const handleCollectChange = useCallback((collect: (() => Promise<string>) | null) => {
    collectRef.current = collect
  }, [])

  const options = parentOptions(listing)
  // A parent the listing, read again while the dialog is open, no longer holds gives way to the top.
  const parentValue = options.some(option => option.value === chosenParent) ? chosenParent : TOP_OF_TREE
  const parentId = parentValue === TOP_OF_TREE ? undefined : parentValue
  const blockedBy = blockingEntry(listing, listing.find(entry => entry.id === parentId))
  const sourceName = account?.vendorName ?? syncSourceName(accounts)
  const publicationKnown = publication === 'use' || publication === 'build'
  const canStart = ready && publicationKnown && !starting && !syncRunning

  const handleStart = async () => {
    if (!canStart || !account) return
    setStarting(true)
    setFailure(null)
    try {
      const collect = collectRef.current
      if (!collect) throw new Error('The source picker is not ready. Try again.')
      const resourceUrl = await collect()
      onStarted(await authenticatedApi.startSpaceSync(account.id, space.key, {
        resourceUrl,
        ...(parentId !== undefined && { parentId }),
      }))
    } catch (err) {
      logRpcFailure('Failed to start a space sync:', err)
      setFailure(rpcFailureDescription(err) ?? 'Couldn’t start the sync. Try again.')
    } finally {
      setStarting(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="list"
      title={`Sync from ${sourceName}`}
      description={`Copies items from ${sourceName} into “${space.name}”, one workspace each.`}
      busy={starting}
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {accounts.length === 0 ? (
          <p className="text-[12px] leading-4 text-kumo-subtle">
            None of your connected accounts can sync into a space any longer.
          </p>
        ) : accounts.length > 1 ? (
          <Radio.Group
            className="gap-2"
            appearance="card"
            value={account ? String(account.id) : ''}
            disabled={starting}
            onValueChange={(value: string) => {
              setChosenAccountId(Number(value))
              setChosenPattern(null)
              setFailure(null)
            }}
          >
            <Radio.Legend className={LEGEND_CLASS_NAME}>Account</Radio.Legend>
            {accounts.map(candidate => (
              <Radio.Item
                key={candidate.id}
                value={String(candidate.id)}
                label={candidate.label}
                description={candidate.credentialsValid
                  ? candidate.vendorName
                  : `${candidate.vendorName}, needs reconnecting`}
              />
            ))}
          </Radio.Group>
        ) : (
          account && (
            <p className="text-[12px] leading-4 text-kumo-subtle">
              Through your account {accountLabel(account)}.
            </p>
          )
        )}

        {account && !account.credentialsValid && (
          <p role="note" className="text-[12px] leading-4 text-kumo-subtle">
            This account needs to be reconnected from Connections before it can sync.
          </p>
        )}
        {account?.credentialsValid && account.resources.length === 0 && (
          <p role="note" className="text-[12px] leading-4 text-kumo-subtle">
            This account hasn’t been granted access to anything it can sync. Grant access from
            Connections, then try again.
          </p>
        )}

        {account && account.resources.length > 1 && (
          <Radio.Group
            className="gap-2"
            value={resource?.urlPattern ?? ''}
            disabled={starting}
            onValueChange={(value: string) => {
              setChosenPattern(value)
              setFailure(null)
            }}
          >
            <Radio.Legend className={LEGEND_CLASS_NAME}>Source type</Radio.Legend>
            {account.resources.map(candidate => (
              <Radio.Item key={candidate.urlPattern} value={candidate.urlPattern} label={candidate.title} />
            ))}
          </Radio.Group>
        )}

        {configurable && (
          <div role="group" aria-labelledby={sourceLabelId} className="flex flex-col gap-1.5">
            <span id={sourceLabelId} className="text-[12px] leading-4 font-medium text-kumo-default">Source</span>
            <ResourceConfiguratorHost
              frame={shown?.status === 'ready' ? shown.frame : null}
              frameKey={shown?.status === 'ready' ? shown.key : null}
              loading={shown === null}
              error={shown?.status === 'failed' ? shown.message : null}
              disabled={false}
              onCollectResourceUrlChange={handleCollectChange}
              onSelectionReadyChange={shown?.status === 'ready'
                ? (selected) => setSelection({ key: shown.key, ready: selected })
                : undefined}
              resourceUrlPattern={pattern ?? undefined}
            />
            {shown?.status === 'failed' && (
              <WorkshopButton className="!h-8 w-fit" onClick={() => setAttempt(previous => previous + 1)}>
                Try again
              </WorkshopButton>
            )}
          </div>
        )}

        <Radio.Group
          className="gap-2"
          value={parentValue}
          disabled={starting}
          onValueChange={(value: string) => {
            setChosenParent(value)
            setFailure(null)
          }}
        >
          <Radio.Legend className={LEGEND_CLASS_NAME}>Place under</Radio.Legend>
          <div className="flex max-h-48 flex-col gap-2 overflow-y-auto rounded-xl border border-kumo-line px-3 py-2.5">
            {options.map(option => (
              // Indented by depth, so the choices read as the tree they come from.
              <div
                key={option.value}
                ref={option.value === parentValue ? revealPreselectedParent : undefined}
                className="min-w-0"
                style={{ paddingInlineStart: `${option.ancestors.length * 16}px` }}
              >
                <Radio.Item
                  value={option.value}
                  label={(
                    <>
                      {option.label}
                      {option.ancestors.length > 0 && (
                        <span className="sr-only">, under {option.ancestors.join(' / ')}</span>
                      )}
                    </>
                  )}
                />
              </div>
            ))}
          </div>
        </Radio.Group>

        <div role="note" className="flex flex-col gap-1.5 rounded-xl border border-kumo-line bg-kumo-elevated px-3 py-2.5 text-[12px] leading-4 text-kumo-default">
          <p>
            {publicationKnown
              ? `Every workspace this sync creates will be published to everyone signed in, ${PUBLICATION_TEXT[publication]}.`
              : 'Every workspace this sync creates will be published to everyone signed in.'}
          </p>
          {publication === 'unknown' && (
            <p className="text-kumo-danger">
              Couldn’t read whether they could also be built on, so the sync can’t be started. Try
              again later.
            </p>
          )}
          <p className="text-kumo-subtle">
            They are your own copies: later changes in {sourceName} reach them only when they are
            synced again. Items restricted in {sourceName} are skipped.
          </p>
          <p className="text-kumo-subtle">
            Syncing a source again replaces the content and all the comments of the workspaces it
            created before, including every edit and comment made in them since, and leaves them
            where they are.
          </p>
          {blockedBy && (
            <p className="text-kumo-subtle">
              {blockedBy.title === undefined
                ? 'A workspace above where they go isn’t published, so others won’t see them until it is.'
                : `“${blockedBy.title}” isn’t published, so others won’t see them until it is.`}
            </p>
          )}
        </div>

        {syncRunning && (
          <p role="note" className="text-[12px] leading-4 text-kumo-subtle">
            A sync into this space is already running. Wait for it to finish, or cancel it, before
            starting another.
          </p>
        )}
        {failure && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
        <Dialog.Close
          render={(props) => (
            <WorkshopButton {...props} className="!h-9" disabled={starting}>Cancel</WorkshopButton>
          )}
        />
        <WorkshopButton
          tone="primary"
          className="min-w-[88px]"
          disabled={!canStart}
          onClick={() => void handleStart()}
        >
          {starting ? 'Starting…' : 'Start sync'}
        </WorkshopButton>
      </div>
    </SpaceDialogFrame>
  )
}
