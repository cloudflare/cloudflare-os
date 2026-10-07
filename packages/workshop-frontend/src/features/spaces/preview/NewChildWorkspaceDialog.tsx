import { useEffect, useState } from 'react'
import { Checkbox, Dialog, Radio } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  CollaboratorRole,
  OutputFormatOffer,
  Overseer,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { useAuthenticatedApi } from '../../../AuthContext'
import { FormatGlyph } from '../../../components/format/FormatVisuals'
import { WorkshopButton } from '../../../components/WorkshopControls'
import { useRpcStub } from '../../../RpcContext'
import { logRpcFailure, rpcFailureDescription } from '../../../rpcErrors'
import { SpaceDialogFrame } from '../SpaceDialogFrame'
import { SPACE_ACTION_CLASS_NAME } from '../SpaceEntryPoints'
import { hiddenByTitle } from '../tree/workspaceTree'

// What each format's blueprint declares it is published with by default
// (`BlueprintMetadata.publication`): a role, null for none, or 'unknown' where that could not be
// read. Absent while it is being read.
type Publications = ReadonlyMap<string, CollaboratorRole | null | 'unknown'>

// The deployment's output formats (`AuthenticatedApi.listOutputFormats`), read for this dialog,
// which says something different while they load, when they could not be read, and when there
// are none.
type FormatsRead =
  | { status: 'loading' }
  | { status: 'failed' }
  | { status: 'ready'; formats: OutputFormatOffer[] }

const NO_FORMATS: OutputFormatOffer[] = []

const PUBLICATION_ROLE_TEXT: Record<CollaboratorRole, string> = {
  use: 'use it',
  build: 'use it and build in it',
}

const titleOf = (entry: SpaceWorkspaceInfo) => entry.title || 'Untitled Workspace'

const blockerName = (title: string | undefined) =>
  title === undefined ? 'a workspace above it' : `“${title || 'Untitled Workspace'}”`

/**
 * Creates a workspace in a space's tree from one of the deployment's output formats
 * (`AuthenticatedApi.newGadgetFromBlueprint`), under `parent` or at the top. A format that needs
 * its connections set up first is shown but cannot be chosen here: it is created from its own
 * page. A format whose blueprint is published by default (`BlueprintMetadata.publication`)
 * offers 'Publish to everyone signed in', checked, and says what that means; unchecking it opts
 * out. Where whether a format publishes could not be read, nothing is published.
 */
export const NewChildWorkspaceDialog = ({ spaceKey, parent, listing, onClose, onCreated }: {
  /** The team space to create the workspace in, or undefined for the user's personal space. */
  spaceKey: string | undefined
  /** The entry to create the workspace under, or null for the top of the tree. */
  parent: SpaceWorkspaceInfo | null
  /** The space's listing, as `Space.listWorkspaces` returns it. */
  listing: readonly SpaceWorkspaceInfo[]
  onClose: () => void
  /** The workspace with this id was created. Closing the dialog is the caller's. */
  onCreated: (workspaceId: string) => void
}) => {
  const { authenticatedApi } = useAuthenticatedApi()
  const publicApi = useRpcStub()
  const [formatsRead, setFormatsRead] = useState<FormatsRead>({ status: 'loading' })
  const [formatsAttempt, setFormatsAttempt] = useState(0)
  const [chosen, setChosen] = useState<string | null>(null)
  const [publish, setPublish] = useState(true)
  const [publications, setPublications] = useState<Publications>(new Map())
  const [creating, setCreating] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    authenticatedApi.listOutputFormats().then(
      (list) => { if (!cancelled) setFormatsRead({ status: 'ready', formats: [...list] }) },
      (err: unknown) => {
        logRpcFailure('Failed to load output formats:', err)
        if (!cancelled) setFormatsRead({ status: 'failed' })
      },
    )
    return () => { cancelled = true }
  }, [authenticatedApi, formatsAttempt])

  const formats = formatsRead.status === 'ready' ? formatsRead.formats : NO_FORMATS

  useEffect(() => {
    let cancelled = false
    void Promise.all(formats.map(async (format): Promise<[string, CollaboratorRole | null | 'unknown']> => {
      try {
        const blueprint = await publicApi.getBlueprint(format.blueprintId)
        return [format.blueprintId, blueprint?.metadata.publication ?? null]
      } catch (err) {
        logRpcFailure('Failed to read whether a format is published by default:', err)
        return [format.blueprintId, 'unknown']
      }
    })).then((read) => { if (!cancelled) setPublications(new Map(read)) })
    return () => { cancelled = true }
  }, [formats, publicApi])

  const creatable = formats.filter(format => !format.requiresSetup)
  const format: OutputFormatOffer | undefined =
    creatable.find(candidate => candidate.blueprintId === chosen) ?? creatable[0]
  const publication = format && publications.get(format.blueprintId)
  // Published by default only when its blueprint says so; while that is being read, the choice
  // waits for it.
  const publicationKnown = publication !== undefined
  const publishedByDefault = publication === 'use' || publication === 'build' ? publication : null

  // Above the new workspace, the entry that keeps a publication from taking effect: the parent
  // itself while it is not published, or the unpublished entry above the parent, named when the
  // listing holds it.
  const blockedBy = parent === null
    ? undefined
    : parent.published === undefined
      ? `“${titleOf(parent)}”`
      : parent.hiddenBy === undefined
        ? undefined
        : blockerName(hiddenByTitle(listing, parent))

  const handleCreate = async () => {
    if (!format || !publicationKnown || creating) return
    setCreating(true)
    setFailure(null)
    // Not awaited: the metadata read is pipelined on the creation, and disposing the promise
    // disposes the workspace it resolves to.
    const overseer: RpcStub<Overseer> = authenticatedApi.newGadgetFromBlueprint(format.blueprintId, {}, {
      ...(spaceKey !== undefined && { spaceKey }),
      ...(parent !== null && { parentId: parent.id }),
      // A format whose default could not be read publishes nothing the user was not told of.
      ...(publication === 'unknown'
        ? { publish: false }
        : publishedByDefault !== null && { publish }),
    })
    try {
      const { id } = await overseer.getMetadata()
      onCreated(id)
    } catch (err) {
      logRpcFailure('Failed to create a workspace in a space:', err, { reportSite: 'space.new-child-workspace' })
      setFailure(rpcFailureDescription(err) ?? `Couldn’t create the ${format.output.noun}. Try again.`)
    } finally {
      overseer[Symbol.dispose]()
      setCreating(false)
    }
  }

  return (
    <SpaceDialogFrame
      layout="list"
      title={parent === null ? 'New workspace' : 'New child workspace'}
      description={parent === null ? 'At the top of the space.' : `Under “${titleOf(parent)}”.`}
      busy={creating}
      onClose={onClose}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-4">
        {formatsRead.status === 'loading' && (
          <p role="status" className="text-[13px] leading-[18px] text-kumo-subtle">Loading formats…</p>
        )}
        {formatsRead.status === 'failed' && (
          <div role="alert" className="flex flex-col items-start gap-2">
            <p className="text-[13px] leading-[18px] text-kumo-danger">Couldn’t load the formats.</p>
            <WorkshopButton
              className={SPACE_ACTION_CLASS_NAME}
              onClick={() => {
                setFormatsRead({ status: 'loading' })
                setFormatsAttempt(attempt => attempt + 1)
              }}
            >
              Try again
            </WorkshopButton>
          </div>
        )}
        {formatsRead.status === 'ready' && formats.length === 0 && (
          <p className="text-[13px] leading-[18px] text-kumo-subtle">There are no formats to create from.</p>
        )}
        {formats.length > 0 && (
          <Radio.Group
            legend="Format"
            appearance="card"
            value={format?.blueprintId ?? ''}
            disabled={creating}
            onValueChange={(value: string) => { setChosen(value); setPublish(true); setFailure(null) }}
          >
            {formats.map(offer => (
              <Radio.Item
                key={offer.blueprintId}
                value={offer.blueprintId}
                disabled={offer.requiresSetup}
                label={(
                  <span className="inline-flex items-center gap-1.5">
                    <FormatGlyph output={offer.output} size="sm" className="shrink-0" />
                    {offer.output.noun}
                  </span>
                )}
                description={offer.requiresSetup
                  ? 'Its connections have to be set up first, from its own page.'
                  : offer.description}
              />
            ))}
          </Radio.Group>
        )}
        {format && publishedByDefault !== null && (
          <div className="flex flex-col gap-1">
            <Checkbox
              label="Publish to everyone signed in"
              checked={publish}
              disabled={creating}
              onCheckedChange={(checked) => setPublish(checked === true)}
            />
            <p className="pl-6 text-[12px] leading-4 text-kumo-subtle">
              {`A new ${format.output.noun} is published by default: anyone signed in can `
                + `${PUBLICATION_ROLE_TEXT[publishedByDefault]} without being invited.`}
              {publish && blockedBy !== undefined && ` Not visible to others until ${blockedBy} is published.`}
            </p>
          </div>
        )}
        {failure && <p role="alert" className="text-[12px] leading-4 text-kumo-danger">{failure}</p>}
      </div>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t border-kumo-line px-5 py-3">
        <Dialog.Close
          render={(props) => (
            <WorkshopButton {...props} className="!h-9" disabled={creating}>Cancel</WorkshopButton>
          )}
        />
        <WorkshopButton
          tone="primary"
          className="min-w-[80px]"
          onClick={() => void handleCreate()}
          disabled={!format || !publicationKnown || creating}
        >
          {creating ? 'Creating…' : 'Create'}
        </WorkshopButton>
      </div>
    </SpaceDialogFrame>
  )
}
